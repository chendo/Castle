// Wiring and scheduling for the proactive observer.
//
// This is the module that owns every subscription and every timer in the
// feature, and therefore the module that has to answer the two questions the
// repo's standards demand of anything long-lived: what cleans this up, and how
// often does it run?
//
//   Subscriptions: three (onStateTransition, onBusEvent x2), taken once in
//   start(), unsubscribe closures retained, all called in stop().
//   Timers: three (debounce, heartbeat, review), all module fields, all
//   cleared in stop(). Plus the manual-action log's own debounce, which it
//   cancels on stop().
//
// Nothing here is reconstructed from disk. Triggers are derived from code plus
// settings on every start(), which is the invariant that keeps this from
// repeating the 0.3.0 failure where persisted state re-armed dead triggers.
//
// Scheduling policy, in one place so it can be reasoned about:
//   - A pass is only ever enqueued when the queue is idle. If it is not, the
//     pass is DROPPED, not deferred — by the time a deferred pass ran, its
//     evidence would be stale and the next debounce will pick up the same
//     buffer anyway. Nothing accumulates a backlog.
//   - A user prompt preempts a running pass (see agent.ts preemptInternalJob).
//   - Rate limits are checked at fire time, not at schedule time.

import type { HAClient, HAState } from "./ha-client.ts";
import { isQueueIdle, submitInternalJob } from "./agent.ts";
import { classify, EventBuffer, type ObservedEvent } from "./observer-events.ts";
import { renderBatch } from "./observer-render.ts";
import { ManualActionLog, renderPatterns } from "./observer-patterns.ts";
import { MemoryStore } from "./observer-memory.ts";
import {
  ObservationStore,
  type Observation,
  type ObservationBody,
  type PassKind,
} from "./observer-store.ts";
import { buildPassPrompt, renderHealthSummary } from "./observer-prompts.ts";
import {
  getObserverSession,
  OBSERVER_DIR,
  peekObserverSession,
  recreateObserverSession,
} from "./observer-agent.ts";
import { loadSettings } from "./settings.ts";

/** Quiet time before a reactive pass fires. Short: reacting quickly is the
 *  point, and the pass itself is cheap triage. */
const DEBOUNCE_MS = 10_000;
/** Urgent events (smoke, a lock going offline) barely wait at all. */
const URGENT_DEBOUNCE_MS = 2_000;
/** Fire immediately once this many events have piled up. */
const BATCH_TRIGGER = 25;
/** Floor between any two passes of any kind. */
const MIN_PASS_GAP_MS = 90_000;
/** A pass that hasn't finished by now is stuck; abort it. */
const PASS_DEADLINE_MS = 90_000;

export interface ObserverStatus {
  enabled: boolean;
  running: boolean;
  passesThisHour: number;
  lastPassAt: number | null;
  lastPassKind: PassKind | null;
  lastDurationMs: number | null;
  nextHeartbeatAt: number | null;
  nextReviewAt: number | null;
}

type StatusListener = (s: ObserverStatus) => void;

export class ObserverRuntime {
  private unsubscribes: Array<() => void> = [];
  private debounceTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private reviewTimer: number | undefined;

  private buffer = new EventBuffer();
  private passTimestamps: number[] = [];
  private lastPassAt: number | null = null;
  private lastPassKind: PassKind | null = null;
  private lastDurationMs: number | null = null;
  private running = false;
  private started = false;
  private nextHeartbeatAt: number | null = null;
  private nextReviewAt: number | null = null;
  private statusListeners = new Set<StatusListener>();

  readonly observations: ObservationStore;
  readonly memory: MemoryStore;
  readonly manualActions: ManualActionLog;

  constructor(
    private readonly ha: HAClient,
    private readonly now: () => number = Date.now,
  ) {
    this.observations = new ObservationStore(OBSERVER_DIR);
    this.memory = new MemoryStore(OBSERVER_DIR);
    this.manualActions = new ManualActionLog(OBSERVER_DIR);
  }

  async init(): Promise<void> {
    await this.observations.init();
    await this.memory.init();
    await this.manualActions.init();
    const settings = await loadSettings();
    if (settings.observer.enabled) await this.start();
  }

  /** Re-read settings and start or stop accordingly. Called after set_settings. */
  async applySettings(): Promise<void> {
    const settings = await loadSettings();
    // The session bakes in the context window and toolset at build time.
    await recreateObserverSession();
    if (settings.observer.enabled) {
      this.stop();
      await this.start();
    } else {
      this.stop();
    }
    this.emitStatus();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const settings = await loadSettings();
    this.buffer.setMuted(settings.observer.mutes);

    this.unsubscribes.push(
      this.ha.onStateTransition((entityId, oldState, newState) => {
        this.onTransition(entityId, oldState, newState);
      }),
    );
    this.unsubscribes.push(
      this.ha.onBusEvent("automation_triggered", (data) => {
        this.onBus("automation_triggered", data);
      }),
    );
    this.unsubscribes.push(
      this.ha.onBusEvent("script_started", (data) => {
        this.onBus("script_started", data);
      }),
    );

    const hb = settings.observer.heartbeatMinutes;
    if (hb > 0) {
      this.nextHeartbeatAt = this.now() + hb * 60_000;
      this.heartbeatTimer = setInterval(() => {
        this.nextHeartbeatAt = this.now() + hb * 60_000;
        void this.maybeRun("heartbeat");
      }, hb * 60_000);
    }
    const rv = settings.observer.reviewHours;
    if (rv > 0) {
      this.nextReviewAt = this.now() + rv * 3_600_000;
      this.reviewTimer = setInterval(() => {
        this.nextReviewAt = this.now() + rv * 3_600_000;
        void this.maybeRun("review");
      }, rv * 3_600_000);
    }

    console.log("[observer] started");
    this.emitStatus();
  }

  /** Release every subscription and timer this runtime owns. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const off of this.unsubscribes) {
      try { off(); } catch { /* listener already gone */ }
    }
    this.unsubscribes = [];
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.reviewTimer !== undefined) clearInterval(this.reviewTimer);
    this.debounceTimer = undefined;
    this.heartbeatTimer = undefined;
    this.reviewTimer = undefined;
    this.nextHeartbeatAt = null;
    this.nextReviewAt = null;
    this.manualActions.stop();
    console.log("[observer] stopped");
  }

  private onTransition(entityId: string, oldState: HAState | null, newState: HAState | null): void {
    const event = classify(entityId, oldState, newState, this.now());
    if (!event) return;
    // Manual actions are logged whether or not the event is significant enough
    // for a pass — the review pass needs the long tail, and "significant" is a
    // filter for what wakes an agent, not for what is worth remembering.
    if (event.kind === "transition" && event.cause === "manual") {
      this.manualActions.record({ ts: event.ts, entityId, to: event.to });
    }
    const { accepted, urgent } = this.buffer.ingest(event);
    if (accepted) this.scheduleReactive(urgent);
  }

  private onBus(kind: "automation_triggered" | "script_started", data: Record<string, unknown>): void {
    const entityId = typeof data.entity_id === "string" ? data.entity_id : undefined;
    if (!entityId) return;
    const name = typeof data.name === "string"
      ? data.name
      : typeof data.alias === "string"
      ? data.alias
      : entityId;
    const event: ObservedEvent = kind === "automation_triggered"
      ? { kind: "automation_triggered", ts: this.now(), entityId, name }
      : { kind: "script_started", ts: this.now(), entityId, name };
    const { accepted, urgent } = this.buffer.ingest(event);
    if (accepted) this.scheduleReactive(urgent);
  }

  private scheduleReactive(urgent: boolean): void {
    if (this.buffer.size() >= BATCH_TRIGGER) {
      this.fireReactive();
      return;
    }
    const delay = urgent || this.buffer.hasUrgent() ? URGENT_DEBOUNCE_MS : DEBOUNCE_MS;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fireReactive(), delay);
  }

  private fireReactive(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    void this.maybeRun("reactive");
  }

  /** Why a pass would be skipped, or null to go ahead. */
  private blockedReason(): string | null {
    if (!this.started) return "observer is off";
    if (this.running) return "a pass is already running";
    if (!this.ha.isConnected) return "HA is not connected";
    if (!isQueueIdle()) return "the agent queue is busy";
    const now = this.now();
    if (this.lastPassAt !== null && now - this.lastPassAt < MIN_PASS_GAP_MS) return "min gap";
    return null;
  }

  private async withinRateLimit(): Promise<boolean> {
    const settings = await loadSettings();
    const cutoff = this.now() - 3_600_000;
    this.passTimestamps = this.passTimestamps.filter((t) => t >= cutoff);
    return this.passTimestamps.length < settings.observer.maxPassesPerHour;
  }

  /** Run a pass if everything allows it. Never throws; never queues. */
  async maybeRun(kind: PassKind): Promise<void> {
    const blocked = this.blockedReason();
    if (blocked) return;
    if (!(await this.withinRateLimit())) return;
    await this.runPass(kind);
  }

  /** Force a pass, ignoring the debounce and gap but not the safety checks.
   *  Backs the "Run now" button and the manual WS trigger. */
  async runNow(kind: PassKind): Promise<{ ran: boolean; reason?: string }> {
    if (this.running) return { ran: false, reason: "a pass is already running" };
    if (!this.ha.isConnected) return { ran: false, reason: "HA is not connected" };
    if (!isQueueIdle()) return { ran: false, reason: "the agent is busy" };
    const evidence = await this.gatherEvidence(kind);
    if (!evidence) return { ran: false, reason: "nothing to look at" };
    await this.runPass(kind, evidence);
    return { ran: true };
  }

  /** Assemble the pass's evidence, or null when there is nothing to look at —
   *  which is what stops an empty window costing an LLM turn. */
  private async gatherEvidence(kind: PassKind): Promise<string | null> {
    if (kind === "reactive") {
      const batch = this.buffer.drain();
      return renderBatch(batch, await this.timeZone());
    }
    if (kind === "heartbeat") {
      const dead: Array<{ entityId: string; sinceMs: number }> = [];
      for (const s of this.ha.getAllStates()) {
        if (s.state !== "unavailable" && s.state !== "unknown") continue;
        const since = Date.parse(s.last_changed);
        dead.push({ entityId: s.entity_id, sinceMs: Number.isFinite(since) ? since : this.now() });
      }
      return renderHealthSummary(dead, this.now());
    }
    const patterns = this.manualActions.rollup(await this.timeZone());
    return renderPatterns(patterns, await this.automationCoverage(patterns.map((p) => p.entityId)));
  }

  private tz: string | undefined;
  private async timeZone(): Promise<string> {
    if (this.tz) return this.tz;
    try {
      const info = await this.ha.getHouseInfo();
      this.tz = typeof info?.timezone === "string" ? info.timezone : "UTC";
    } catch {
      this.tz = "UTC";
    }
    return this.tz;
  }

  /**
   * Which automations already reference each entity. Computed here rather than
   * left to the model, which has no ha_get_automation tool and would otherwise
   * speculate about whether something is already automated.
   */
  private async automationCoverage(entityIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (entityIds.length === 0) return out;
    const wanted = new Set(entityIds);
    for (const s of this.ha.getAllStates()) {
      if (!s.entity_id.startsWith("automation.")) continue;
      const id = s.attributes?.id;
      if (typeof id !== "string") continue;
      try {
        const res = await this.ha.restCall(`/api/config/automation/config/${encodeURIComponent(id)}`);
        if (!res.ok) continue;
        const body = JSON.stringify(await res.json());
        for (const entityId of wanted) {
          if (!body.includes(entityId)) continue;
          const list = out.get(entityId) ?? [];
          list.push(s.entity_id);
          out.set(entityId, list);
        }
      } catch { /* a config we can't read just doesn't count as coverage */ }
    }
    return out;
  }

  private async runPass(kind: PassKind, preGathered?: string): Promise<void> {
    const evidence = preGathered ?? await this.gatherEvidence(kind);
    if (!evidence) return;

    const settings = await loadSettings();
    const passId = `pass_${this.now().toString(36)}`;
    const prompt = buildPassPrompt({
      kind,
      passId,
      evidence,
      memory: this.memory.render(),
      open: this.observations.openObservations(),
      scope: settings.observer.scope,
    });
    if (!prompt) return;

    const startedAt = this.now();
    this.running = true;
    this.passTimestamps.push(startedAt);
    this.emitStatus();

    // The pass runs as an internal job on the shared queue, so it can never
    // overlap a user turn, and preemptInternalJob can abort it the moment the
    // user types.
    submitInternalJob(
      async () => {
        let deadline: number | undefined;
        try {
          const observer = await getObserverSession({
            ha: this.ha,
            tools: {
              memory: this.memory,
              emit: (body) => this.emit(body, passId, kind, startedAt),
              cameras: () => settings.observer.cameras,
              now: this.now,
            },
          });
          observer.beginPass(kind);
          deadline = setTimeout(() => {
            console.warn(`[observer] ${passId} hit the ${PASS_DEADLINE_MS}ms deadline — aborting`);
            try { observer.session.agent.abort(); } catch { /* already done */ }
          }, PASS_DEADLINE_MS);

          await observer.session.prompt(prompt);
          await observer.session.agent.waitForIdle();
          const duration = this.now() - startedAt;
          this.lastDurationMs = duration;
          console.log(
            `[observer] ${passId} (${kind}) done in ${duration}ms, ${observer.toolCalls()} tool calls`,
          );
        } catch (err) {
          console.warn(`[observer] ${passId} failed:`, (err as Error).message);
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
          this.running = false;
          this.lastPassAt = this.now();
          this.lastPassKind = kind;
          this.emitStatus();
        }
      },
      () => {
        const live = peekObserverSession();
        void live?.then((s) => s.session.agent.abort()).catch(() => {});
      },
    );
  }

  private async emit(
    body: ObservationBody,
    passId: string,
    kind: PassKind,
    startedAt: number,
  ): Promise<string | null> {
    const observer = peekObserverSession();
    const toolCalls = observer ? (await observer).toolCalls() : 0;
    const result = await this.observations.raise(body, {
      id: passId,
      kind,
      startedAt,
      durationMs: this.now() - startedAt,
      toolCalls,
    });
    return result.suppressed ? null : result.observation.id;
  }

  // --- status -------------------------------------------------------------

  status(): ObserverStatus {
    const cutoff = this.now() - 3_600_000;
    return {
      enabled: this.started,
      running: this.running,
      passesThisHour: this.passTimestamps.filter((t) => t >= cutoff).length,
      lastPassAt: this.lastPassAt,
      lastPassKind: this.lastPassKind,
      lastDurationMs: this.lastDurationMs,
      nextHeartbeatAt: this.nextHeartbeatAt,
      nextReviewAt: this.nextReviewAt,
    };
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }

  private emitStatus(): void {
    const s = this.status();
    for (const fn of this.statusListeners) {
      try { fn(s); }
      catch (err) { console.warn("[observer] status listener threw:", (err as Error).message); }
    }
  }

  onObservation(fn: (o: Observation) => void): () => void {
    return this.observations.subscribe(fn);
  }
}
