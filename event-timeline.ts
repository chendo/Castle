// Activity-timeline state and filter pipeline.
//
// Sits between the HA event firehose and the browser. Drops noise (battery
// sensors, weather updates, transient `unavailable` flips), coalesces bursts,
// and keeps a bounded ring buffer so a freshly-connected browser can pull a
// snapshot without history hitting the wire on every state_changed.
//
// Pure of HA side-effects — `ingestStateChange`, `ingestBusEvent`,
// `noteAgentAction` are the three input edges; `subscribe` and `snapshot` are
// the output edges. main.ts wires it up; the unit tests drive it directly.

import type { HAClient, HAState } from "./ha-client.ts";

export type TimelineSource =
  | "state"
  | "automation"
  | "script"
  | "agent"
  | "burst";

export interface TimelineEvent {
  /** Monotonic, server-assigned. The browser uses this to dedupe across
   *  snapshot + live frames. */
  id: string;
  /** ms since epoch. */
  timestamp: number;
  source: TimelineSource;
  /** Where applicable. Click-to-open uses this. */
  entity_id?: string;
  domain?: string;
  /** Pre-rendered for the browser — keeps per-row JS cheap. */
  icon: string;
  subject: string;
  verb: string;
  details?: string;
  /** True when the action originated from the agent (chat tool call), as
   *  opposed to a UI click or the user / HA's own automation. */
  via_agent?: boolean;
}

const MAX_EVENTS = 200;

// Cooldowns keep flapping sensors quiet. binary_sensor.motion / occupancy fire
// hard and short; everything else is bursty over seconds. Tuned to match what a
// human would expect to see in a feed.
const COOLDOWN_DEFAULT_MS = 5_000;
const COOLDOWN_BINARY_SENSOR_MS = 30_000;

// Window after a noteAgentAction in which the resulting state_changed echo
// should be suppressed. The agent's row already says what happened.
const AGENT_ECHO_WINDOW_MS = 5_000;

// Burst coalescing: ≥3 light/switch/scene transitions inside this window
// collapse into one "N lights turned on" row. 2s matches a typical scene
// activation time.
const BURST_WINDOW_MS = 2_000;
const BURST_MIN_COUNT = 3;

// Window after an automation_triggered / script_started in which subsequent
// burst transitions are attributed to that automation/script's friendly name.
const ATTRIBUTION_WINDOW_MS = 3_000;

const BURST_DOMAINS = new Set(["light", "switch", "input_boolean"]);

const SIGNIFICANT_BINARY_SENSOR_CLASSES = new Set([
  "door", "window", "motion", "occupancy", "opening",
  "smoke", "moisture", "safety", "sound", "garage_door",
]);

const TRANSITION_DOMAINS = new Set([
  "lock", "cover", "alarm_control_panel", "device_tracker", "person",
  "light", "switch", "input_boolean", "fan", "media_player",
  "binary_sensor", "event",
]);

function domainOf(entityId: string): string {
  const idx = entityId.indexOf(".");
  return idx === -1 ? entityId : entityId.slice(0, idx);
}

function friendlyOf(state: HAState | null | undefined, fallback: string): string {
  if (!state) return fallback;
  const fn = state.attributes?.friendly_name;
  return typeof fn === "string" && fn.length > 0 ? fn : fallback;
}

function iconForDomain(domain: string, deviceClass?: string): string {
  if (domain === "binary_sensor" || domain === "lock" || domain === "cover") {
    switch (deviceClass) {
      case "motion": return "🚶";
      case "occupancy": return "👤";
      case "door": return "🚪";
      case "window": return "🪟";
      case "garage_door": return "🚗";
      case "opening": return "🚪";
      case "smoke": return "🔥";
      case "moisture": return "💧";
      case "safety": return "⚠️";
      case "sound": return "🔊";
    }
  }
  switch (domain) {
    case "light": return "💡";
    case "switch": return "🔌";
    case "input_boolean": return "⚐";
    case "fan": return "🌀";
    case "media_player": return "▶";
    case "lock": return "🔒";
    case "cover": return "🪟";
    case "alarm_control_panel": return "🛡";
    case "device_tracker":
    case "person": return "📍";
    case "scene": return "🎬";
    case "automation": return "⚙";
    case "script": return "📜";
    case "event": return "•";
  }
  return "•";
}

function verbForBinarySensor(state: string, deviceClass?: string): string {
  const isOn = state === "on";
  switch (deviceClass) {
    case "motion": return isOn ? "motion detected" : "motion cleared";
    case "occupancy": return isOn ? "occupied" : "vacated";
    case "door":
    case "window":
    case "garage_door":
    case "opening": return isOn ? "opened" : "closed";
    case "smoke": return isOn ? "smoke detected" : "smoke cleared";
    case "moisture": return isOn ? "moisture detected" : "moisture cleared";
    case "safety": return isOn ? "unsafe" : "safe";
    case "sound": return isOn ? "sound detected" : "sound cleared";
  }
  return isOn ? "on" : "off";
}

function verbForState(domain: string, newState: string, deviceClass?: string): string {
  switch (domain) {
    case "binary_sensor": return verbForBinarySensor(newState, deviceClass);
    case "light":
    case "switch":
    case "input_boolean":
    case "fan": return newState === "on" ? "on" : "off";
    case "lock": return newState === "locked" ? "locked" : newState === "unlocked" ? "unlocked" : newState;
    case "cover": return newState === "open" ? "opened" : newState === "closed" ? "closed" : newState;
    case "alarm_control_panel": return newState;
    case "device_tracker":
    case "person": return newState === "home" ? "arrived home" : newState === "not_home" ? "left home" : `is ${newState}`;
    case "media_player": return newState === "playing" ? "started playing" : newState;
    case "event": return "fired";
  }
  return newState;
}

interface AttributionHint {
  source: "automation" | "script";
  name: string;
  expiresAt: number;
}

let nextId = 1;
function mintId(): string {
  return `t${nextId++}`;
}

export class EventTimeline {
  private events: TimelineEvent[] = [];
  private cooldown = new Map<string, number>();
  private muted = new Set<string>();
  private listeners = new Set<(e: TimelineEvent) => void>();
  // Recent burst-eligible transitions waiting to either flush as N
  // individual rows (cooldown timer fires) or coalesce.
  private burstBuffer: Array<{ ts: number; entityId: string; domain: string; subject: string; newState: string; deviceClass?: string }> = [];
  private burstTimer: number | undefined;
  // Last automation_triggered / script_started, so a burst that follows can
  // be labelled with its name.
  private lastAttribution: AttributionHint | null = null;
  // Recent agent actions (entity → expiresAt) — state_changed echoes for
  // these entities are suppressed within the window.
  private agentEchoSuppression = new Map<string, number>();

  constructor(private readonly ha: HAClient | null = null) {}

  setMutes(ids: string[]): void {
    this.muted = new Set(ids);
  }

  getMutes(): string[] {
    return [...this.muted];
  }

  snapshot(): TimelineEvent[] {
    return [...this.events];
  }

  subscribe(fn: (e: TimelineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  ingestStateChange(entityId: string, oldState: HAState | null, newState: HAState | null, now: number = Date.now()): void {
    if (this.muted.has(entityId)) return;

    const echoUntil = this.agentEchoSuppression.get(entityId);
    if (echoUntil !== undefined) {
      if (echoUntil >= now) return;
      this.agentEchoSuppression.delete(entityId);
    }

    if (!newState) return;
    if (oldState && oldState.state === newState.state) return;
    if (newState.state === "unavailable" || newState.state === "unknown") return;
    if (oldState && (oldState.state === "unavailable" || oldState.state === "unknown")) {
      // Coming back online isn't actionable noise — suppress the off→on
      // transition that follows a reload / restart.
      return;
    }

    const domain = domainOf(entityId);
    if (!TRANSITION_DOMAINS.has(domain)) return;
    const deviceClass = newState.attributes?.device_class as string | undefined;

    if (domain === "binary_sensor") {
      if (!deviceClass || !SIGNIFICANT_BINARY_SENSOR_CLASSES.has(deviceClass)) return;
      // Most motion sensors are interesting on activation only; the off
      // edge is implied and just doubles up the noise.
      if (newState.state !== "on") return;
    }

    if (domain === "media_player" && newState.state !== "playing") return;

    if (domain === "device_tracker" || domain === "person") {
      // Only home/away transitions, not zone churn between named zones.
      if (newState.state === oldState?.state) return;
      const isMeaningful = newState.state === "home" || newState.state === "not_home";
      const wasMeaningful = oldState?.state === "home" || oldState?.state === "not_home";
      if (!isMeaningful && !wasMeaningful) return;
    }

    const cooldownMs = domain === "binary_sensor" ? COOLDOWN_BINARY_SENSOR_MS : COOLDOWN_DEFAULT_MS;
    const last = this.cooldown.get(entityId);
    if (last !== undefined && now - last < cooldownMs) return;
    this.cooldown.set(entityId, now);

    const subject = friendlyOf(newState, entityId);

    if (BURST_DOMAINS.has(domain)) {
      this.bufferBurst({ ts: now, entityId, domain, subject, newState: newState.state, deviceClass });
      return;
    }

    this.emit({
      id: mintId(),
      timestamp: now,
      source: "state",
      entity_id: entityId,
      domain,
      icon: iconForDomain(domain, deviceClass),
      subject,
      verb: verbForState(domain, newState.state, deviceClass),
    });
  }

  ingestBusEvent(
    type: "automation_triggered" | "script_started",
    data: Record<string, unknown>,
    now: number = Date.now(),
  ): void {
    const name = (data.name as string | undefined)
      ?? (data.entity_id as string | undefined)
      ?? (data.alias as string | undefined)
      ?? "(unnamed)";

    this.lastAttribution = {
      source: type === "automation_triggered" ? "automation" : "script",
      name,
      expiresAt: now + ATTRIBUTION_WINDOW_MS,
    };

    const entityId = typeof data.entity_id === "string" ? data.entity_id : undefined;
    const domain = type === "automation_triggered" ? "automation" : "script";
    this.emit({
      id: mintId(),
      timestamp: now,
      source: type === "automation_triggered" ? "automation" : "script",
      entity_id: entityId,
      domain,
      icon: iconForDomain(domain),
      subject: name,
      verb: type === "automation_triggered" ? "triggered" : "started",
    });
  }

  /**
   * Called from the WS service_call handler and the ha_call_service tool.
   * Two effects:
   *   1. Suppress the resulting state_changed echo(es) so the row isn't
   *      duplicated.
   *   2. Emit one synthesised row attributed to the agent / dashboard.
   * `viaAgent: true` marks the row with the 🤖 marker. Dashboard / favourite
   * card clicks pass `false` — the action gets a row, but no robot.
   */
  noteAgentAction(
    domain: string,
    service: string,
    entityIds: string[],
    viaAgent: boolean,
    now: number = Date.now(),
  ): void {
    if (entityIds.length === 0) return;
    const expiresAt = now + AGENT_ECHO_WINDOW_MS;
    for (const id of entityIds) {
      this.agentEchoSuppression.set(id, expiresAt);
      // Skip cooldown bookkeeping for suppressed echoes — they never reach the
      // emit path, so the cooldown they would have written would only block a
      // *real* user action a moment later.
    }

    const verb = humanizeService(domain, service);
    if (entityIds.length === 1) {
      const id = entityIds[0];
      const state = this.ha?.getState(id);
      const subject = friendlyOf(state, id);
      const deviceClass = state?.attributes?.device_class as string | undefined;
      this.emit({
        id: mintId(),
        timestamp: now,
        source: "agent",
        entity_id: id,
        domain: domainOf(id),
        icon: iconForDomain(domainOf(id), deviceClass),
        subject,
        verb,
        via_agent: viaAgent,
      });
      return;
    }

    this.emit({
      id: mintId(),
      timestamp: now,
      source: "agent",
      domain,
      icon: iconForDomain(domain),
      subject: `${entityIds.length} ${domain}s`,
      verb,
      details: entityIds.join(", "),
      via_agent: viaAgent,
    });
  }

  // --- internals ----------------------------------------------------------

  private bufferBurst(entry: { ts: number; entityId: string; domain: string; subject: string; newState: string; deviceClass?: string }): void {
    this.burstBuffer.push(entry);
    if (this.burstTimer !== undefined) clearTimeout(this.burstTimer);
    this.burstTimer = setTimeout(() => this.flushBurst(), BURST_WINDOW_MS) as unknown as number;
  }

  // Exposed for tests so they don't have to wait on a real timer.
  flushBurst(now: number = Date.now()): void {
    if (this.burstTimer !== undefined) {
      clearTimeout(this.burstTimer);
      this.burstTimer = undefined;
    }
    const buf = this.burstBuffer;
    this.burstBuffer = [];
    if (buf.length === 0) return;

    const isAttributed = this.lastAttribution !== null && this.lastAttribution.expiresAt >= buf[0].ts;
    const allOn = buf.every((b) => b.newState === "on");

    if (buf.length >= BURST_MIN_COUNT) {
      const verb = allOn ? `${buf.length} ${buf[0].domain}s on` : `${buf.length} transitions`;
      const subject = isAttributed && this.lastAttribution
        ? this.lastAttribution.name
        : `Scene`;
      this.emit({
        id: mintId(),
        timestamp: buf[0].ts,
        source: "burst",
        domain: buf[0].domain,
        icon: iconForDomain(buf[0].domain),
        subject,
        verb,
        details: buf.map((b) => b.subject).join(", "),
      });
      return;
    }

    for (const b of buf) {
      this.emit({
        id: mintId(),
        timestamp: b.ts,
        source: "state",
        entity_id: b.entityId,
        domain: b.domain,
        icon: iconForDomain(b.domain, b.deviceClass),
        subject: b.subject,
        verb: verbForState(b.domain, b.newState, b.deviceClass),
      }, now);
    }
  }

  private emit(event: TimelineEvent, _now: number = Date.now()): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const l of this.listeners) {
      try { l(event); }
      catch (err) { console.warn("[timeline] listener threw:", (err as Error).message); }
    }
  }
}

// Process-wide singleton. main.ts initialises it at boot; agent.ts and tools.ts
// pull it from here so they don't need to import main.ts (which would be a
// dependency cycle since main.ts imports agent.ts).
let singleton: EventTimeline | null = null;
export function setTimelineSingleton(t: EventTimeline): void {
  singleton = t;
}
export function getTimelineSingleton(): EventTimeline | null {
  return singleton;
}

// Map service names to a short human verb. The default is the service name with
// underscores → spaces — fine for unfamiliar domains.
function humanizeService(domain: string, service: string): string {
  if (service === "turn_on") return domain === "scene" ? "activated" : "turned on";
  if (service === "turn_off") return "turned off";
  if (service === "toggle") return "toggled";
  if (service === "open_cover") return "opened";
  if (service === "close_cover") return "closed";
  if (service === "lock") return "locked";
  if (service === "unlock") return "unlocked";
  if (service === "media_play") return "started playing";
  if (service === "media_pause") return "paused";
  if (service === "media_stop") return "stopped";
  return service.replace(/_/g, " ");
}
