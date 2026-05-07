// Scheduled / triggered agent tasks.
//
// A `Task` is a brief + a trigger + a context spec + a termination policy. When
// the trigger fires, the server gathers context (camera frames, narrative log)
// and asks the LLM to decide whether to notify the parent conversation. The
// fire path lives in tasks-fire.ts; this module owns lifecycle, persistence,
// and trigger wiring.
//
// Persistence: each task is one JSON file under .pi-agent/tasks/<id>.json. Frame
// blobs live in .pi-agent/tasks/<id>/frames/. On boot, init() rehydrates every
// non-terminal task and re-arms its triggers; terminal tasks past their TTL are
// purged.

import type { HAClient } from "./ha-client.ts";
import { fireTask, type FireOutcome } from "./tasks-fire.ts";

const TASKS_DIR = new URL(".pi-agent/tasks/", import.meta.url).pathname.replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Types

export type TaskStatus = "watching" | "fired" | "expired" | "stopped" | "errored";

export type Trigger =
  | { kind: "at"; ts: number }
  | { kind: "every"; intervalMs: number }
  | { kind: "on_state"; entity: string; to?: string; from?: string }
  | { kind: "on_event"; eventType: string; dataMatch?: Record<string, unknown> }
  | { kind: "any_of"; triggers: Trigger[] };

export interface ContextSpec {
  /** Capture a fresh snapshot from this camera on every fire and keep the last
   *  N in a rolling window for the LLM. Frames are written to disk and
   *  referenced by relative path on the Observation. */
  cameraFrames?: { entity: string; lastN: number };
  /** When true, the result of a successful fire is posted back into the parent
   *  conversation as a system-style message. Most user-facing tasks want this. */
  parentThread?: boolean;
}

export type Termination =
  | { kind: "one_shot_on_fire" }
  | { kind: "expires"; ttlMs: number }
  | { kind: "manual" };

export interface Observation {
  id: string;
  ts: number;
  triggerKind: string;
  framePaths: string[];
  narrative: string;
  decision: "wait" | "notify" | "error";
  confidence?: number;
  errorMessage?: string;
}

export interface TaskNotification {
  summary: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
  observationId: string;
  ts: number;
}

export interface Task {
  id: string;
  parentSessionId?: string;
  brief: string;
  trigger: Trigger;
  context: ContextSpec;
  termination: Termination;
  status: TaskStatus;
  observations: Observation[];
  notification?: TaskNotification;
  cost: { fires: number; framesAnalyzed: number };
  createdAt: number;
  firedAt?: number;
  expiresAt?: number;
  /** Frames + JSON retention after termination. Default 24h. */
  ttlAfterFireMs: number;
  /** Cap on observations kept in memory + on disk. */
  maxObservations: number;
}

const DEFAULT_TTL_AFTER_FIRE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OBSERVATIONS = 50;
const MIN_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Validation

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateTrigger(t: unknown): Trigger {
  if (!isPlainObject(t)) throw new Error("trigger must be an object");
  const kind = t.kind;
  if (kind === "at") {
    const ts = Number(t.ts);
    if (!Number.isFinite(ts)) throw new Error("trigger.at: ts (epoch ms) required");
    return { kind, ts };
  }
  if (kind === "every") {
    const intervalMs = Number(t.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`trigger.every: intervalMs must be ≥ ${MIN_INTERVAL_MS}`);
    }
    return { kind, intervalMs: Math.floor(intervalMs) };
  }
  if (kind === "on_state") {
    if (typeof t.entity !== "string" || !t.entity.includes(".")) {
      throw new Error("trigger.on_state: entity (e.g. binary_sensor.gate) required");
    }
    const out: Trigger = { kind, entity: t.entity };
    if (typeof t.to === "string") out.to = t.to;
    if (typeof t.from === "string") out.from = t.from;
    return out;
  }
  if (kind === "on_event") {
    if (typeof t.eventType !== "string" || !t.eventType) {
      throw new Error("trigger.on_event: eventType required");
    }
    if (t.eventType === "state_changed") {
      throw new Error("trigger.on_event: use on_state for state_changed");
    }
    const out: Trigger = { kind, eventType: t.eventType };
    if (isPlainObject(t.dataMatch)) out.dataMatch = t.dataMatch;
    return out;
  }
  if (kind === "any_of") {
    if (!Array.isArray(t.triggers) || t.triggers.length === 0) {
      throw new Error("trigger.any_of: non-empty triggers[] required");
    }
    return { kind, triggers: t.triggers.map(validateTrigger) };
  }
  throw new Error(`trigger.kind: unknown "${String(kind)}"`);
}

function validateContext(c: unknown): ContextSpec {
  if (!isPlainObject(c)) return {};
  const out: ContextSpec = {};
  if (isPlainObject(c.cameraFrames)) {
    const cf = c.cameraFrames;
    if (typeof cf.entity !== "string" || !cf.entity.startsWith("camera.")) {
      throw new Error("context.cameraFrames.entity must be a camera.* entity");
    }
    const n = Number(cf.lastN ?? 5);
    if (!Number.isFinite(n) || n < 1 || n > 20) {
      throw new Error("context.cameraFrames.lastN must be 1..20");
    }
    out.cameraFrames = { entity: cf.entity, lastN: Math.floor(n) };
  }
  if (typeof c.parentThread === "boolean") out.parentThread = c.parentThread;
  return out;
}

function validateTermination(t: unknown): Termination {
  if (!isPlainObject(t)) return { kind: "one_shot_on_fire" };
  if (t.kind === "one_shot_on_fire") return { kind: "one_shot_on_fire" };
  if (t.kind === "expires") {
    const ttlMs = Number(t.ttlMs);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("termination.expires.ttlMs > 0 required");
    return { kind: "expires", ttlMs: Math.floor(ttlMs) };
  }
  if (t.kind === "manual") return { kind: "manual" };
  throw new Error(`termination.kind: unknown "${String(t.kind)}"`);
}

export interface TaskSpec {
  brief: string;
  trigger: unknown;
  context?: unknown;
  termination?: unknown;
  parentSessionId?: string;
  ttlAfterFireMs?: number;
  maxObservations?: number;
}

export function validateTaskSpec(spec: TaskSpec): {
  brief: string;
  trigger: Trigger;
  context: ContextSpec;
  termination: Termination;
  parentSessionId?: string;
  ttlAfterFireMs: number;
  maxObservations: number;
} {
  if (typeof spec.brief !== "string" || spec.brief.trim().length === 0) {
    throw new Error("brief required");
  }
  if (spec.brief.length > 2000) throw new Error("brief must be < 2000 chars");
  const trigger = validateTrigger(spec.trigger);
  const context = validateContext(spec.context);
  const termination = validateTermination(spec.termination);
  const ttlAfterFireMs = typeof spec.ttlAfterFireMs === "number" && spec.ttlAfterFireMs > 0
    ? Math.floor(spec.ttlAfterFireMs) : DEFAULT_TTL_AFTER_FIRE_MS;
  const maxObservations = typeof spec.maxObservations === "number" && spec.maxObservations > 1
    ? Math.floor(spec.maxObservations) : DEFAULT_MAX_OBSERVATIONS;
  return {
    brief: spec.brief.trim(),
    trigger,
    context,
    termination,
    parentSessionId: typeof spec.parentSessionId === "string" ? spec.parentSessionId : undefined,
    ttlAfterFireMs,
    maxObservations,
  };
}

// ---------------------------------------------------------------------------
// Persistence

async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
}

function taskJsonPath(id: string): string {
  return `${TASKS_DIR}/${id}.json`;
}

export function taskFramesDir(id: string): string {
  return `${TASKS_DIR}/${id}/frames`;
}

async function readTaskFile(path: string): Promise<Task | null> {
  try {
    const text = await Deno.readTextFile(path);
    return JSON.parse(text) as Task;
  } catch (err) {
    console.warn(`[tasks] failed to read ${path}: ${(err as Error).message}`);
    return null;
  }
}

async function writeTaskFile(task: Task): Promise<void> {
  await ensureDir(TASKS_DIR);
  await Deno.writeTextFile(taskJsonPath(task.id), JSON.stringify(task, null, 2));
}

async function deleteTaskFiles(id: string): Promise<void> {
  try {
    await Deno.remove(taskJsonPath(id));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(`[tasks] failed to delete ${id}.json: ${(err as Error).message}`);
    }
  }
  try {
    await Deno.remove(`${TASKS_DIR}/${id}`, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(`[tasks] failed to delete ${id}/: ${(err as Error).message}`);
    }
  }
}

async function listTaskFiles(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(TASKS_DIR)) {
      if (e.isFile && e.name.endsWith(".json")) out.push(`${TASKS_DIR}/${e.name}`);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manager

export type TaskEvent =
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; id: string };

export class TasksManager {
  private tasks = new Map<string, Task>();
  private triggers = new Map<string, () => void>();
  private listeners = new Set<(e: TaskEvent) => void>();
  private firing = new Set<string>();
  private booted = false;

  constructor(private ha: HAClient) {}

  async init(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await ensureDir(TASKS_DIR);
    const files = await listTaskFiles();
    let armed = 0;
    let purged = 0;
    const now = Date.now();
    for (const f of files) {
      const t = await readTaskFile(f);
      if (!t) continue;
      // Purge terminal tasks that are past their TTL.
      if (t.status !== "watching" && t.firedAt !== undefined) {
        if (now - t.firedAt > t.ttlAfterFireMs) {
          await deleteTaskFiles(t.id);
          purged++;
          continue;
        }
      }
      this.tasks.set(t.id, t);
      if (t.status === "watching") {
        try {
          this.armTriggers(t);
          armed++;
        } catch (err) {
          console.warn(`[tasks] could not arm ${t.id}: ${(err as Error).message}`);
          t.status = "errored";
          await writeTaskFile(t);
        }
      }
    }
    if (armed || purged) {
      console.log(`[tasks] init: ${armed} armed, ${purged} purged, ${this.tasks.size} retained`);
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  subscribe(fn: (e: TaskEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(e: TaskEvent): void {
    for (const l of this.listeners) {
      try { l(e); }
      catch (err) { console.warn("[tasks] listener threw:", (err as Error).message); }
    }
  }

  async schedule(spec: TaskSpec): Promise<Task> {
    const v = validateTaskSpec(spec);
    const id = mintTaskId();
    const task: Task = {
      id,
      parentSessionId: v.parentSessionId,
      brief: v.brief,
      trigger: v.trigger,
      context: v.context,
      termination: v.termination,
      status: "watching",
      observations: [],
      cost: { fires: 0, framesAnalyzed: 0 },
      createdAt: Date.now(),
      ttlAfterFireMs: v.ttlAfterFireMs,
      maxObservations: v.maxObservations,
      expiresAt: v.termination.kind === "expires" ? Date.now() + v.termination.ttlMs : undefined,
    };
    await writeTaskFile(task);
    this.tasks.set(id, task);
    this.armTriggers(task);
    this.emit({ type: "task_created", task });
    console.log(`[tasks] scheduled ${id}: ${task.brief.slice(0, 80)}`);
    return task;
  }

  async cancel(id: string): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.disarmTriggers(id);
    t.status = "stopped";
    await writeTaskFile(t);
    this.emit({ type: "task_updated", task: t });
    console.log(`[tasks] cancelled ${id}`);
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.disarmTriggers(id);
    this.tasks.delete(id);
    await deleteTaskFiles(id);
    this.emit({ type: "task_deleted", id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Trigger arming / firing

  private armTriggers(task: Task): void {
    this.disarmTriggers(task.id);
    const teardowns: Array<() => void> = [];
    const fire = (hint: string) => this.handleTrigger(task.id, hint);

    const arm = (trig: Trigger) => {
      if (trig.kind === "at") {
        const delay = Math.max(0, trig.ts - Date.now());
        const handle = setTimeout(() => fire("at"), delay);
        teardowns.push(() => clearTimeout(handle));
        return;
      }
      if (trig.kind === "every") {
        const handle = setInterval(() => fire("every"), trig.intervalMs);
        teardowns.push(() => clearInterval(handle));
        return;
      }
      if (trig.kind === "on_state") {
        const off = this.ha.onStateTransition((entityId, oldState, newState) => {
          if (entityId !== trig.entity) return;
          if (trig.to !== undefined && newState?.state !== trig.to) return;
          if (trig.from !== undefined && oldState?.state !== trig.from) return;
          fire(`on_state(${entityId})`);
        });
        teardowns.push(off);
        return;
      }
      if (trig.kind === "on_event") {
        // Fire-and-forget upstream subscription. If HA isn't connected yet
        // (boot path), HAClient queues the type and re-subscribes on reconnect.
        void this.ha.subscribeEventType(trig.eventType);
        const off = this.ha.onBusEvent(trig.eventType, (data) => {
          if (trig.dataMatch && !shallowMatch(data, trig.dataMatch)) return;
          fire(`on_event(${trig.eventType})`);
        });
        teardowns.push(off);
        return;
      }
      if (trig.kind === "any_of") {
        for (const sub of trig.triggers) arm(sub);
        return;
      }
    };
    arm(task.trigger);

    // Expiry timer drives termination for kind: "expires" and acts as an upper
    // bound for stuck `at`/`every` triggers whose target time has passed.
    if (task.expiresAt !== undefined) {
      const delay = Math.max(0, task.expiresAt - Date.now());
      const handle = setTimeout(() => void this.expire(task.id), delay);
      teardowns.push(() => clearTimeout(handle));
    }

    this.triggers.set(task.id, () => {
      for (const fn of teardowns) {
        try { fn(); } catch (err) { console.warn("[tasks] teardown threw:", (err as Error).message); }
      }
    });
  }

  private disarmTriggers(id: string): void {
    const t = this.triggers.get(id);
    if (t) {
      t();
      this.triggers.delete(id);
    }
  }

  private async handleTrigger(id: string, hint: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "watching") return;
    if (this.firing.has(id)) {
      // Drop overlapping fires — the next trigger tick will catch up. Avoids
      // pile-ups when LLM latency exceeds tick interval.
      return;
    }
    this.firing.add(id);
    try {
      const outcome = await fireTask(task, hint, this.ha);
      await this.applyOutcome(task, outcome);
    } catch (err) {
      console.error(`[tasks] fire ${id} threw:`, (err as Error).message);
      const obs: Observation = {
        id: mintObservationId(),
        ts: Date.now(),
        triggerKind: hint,
        framePaths: [],
        narrative: "",
        decision: "error",
        errorMessage: (err as Error).message,
      };
      this.appendObservation(task, obs);
      task.cost.fires++;
      await writeTaskFile(task);
      this.emit({ type: "task_updated", task });
    } finally {
      this.firing.delete(id);
    }
  }

  private async applyOutcome(task: Task, outcome: FireOutcome): Promise<void> {
    this.appendObservation(task, outcome.observation);
    task.cost.fires++;
    task.cost.framesAnalyzed += outcome.observation.framePaths.length;

    if (outcome.observation.decision === "notify" && outcome.notification) {
      task.notification = outcome.notification;
      task.firedAt = outcome.notification.ts;
      if (task.termination.kind === "one_shot_on_fire") {
        task.status = "fired";
        this.disarmTriggers(task.id);
      }
    }
    await writeTaskFile(task);
    this.emit({ type: "task_updated", task });
  }

  private appendObservation(task: Task, obs: Observation): void {
    task.observations.push(obs);
    if (task.observations.length > task.maxObservations) {
      // Drop oldest. Frame files for evicted observations are intentionally
      // left on disk for debug; the per-task TTL cleanup at boot purges them
      // wholesale with the task directory.
      task.observations.splice(0, task.observations.length - task.maxObservations);
    }
  }

  private async expire(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (!t || t.status !== "watching") return;
    this.disarmTriggers(id);
    t.status = "expired";
    t.firedAt = Date.now();
    await writeTaskFile(t);
    this.emit({ type: "task_updated", task: t });
    console.log(`[tasks] expired ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function shallowMatch(haystack: Record<string, unknown>, needle: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(needle)) {
    if (haystack[k] !== v) return false;
  }
  return true;
}

let idCounter = 0;
function mintTaskId(): string {
  idCounter++;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `task_${t}_${r}_${idCounter}`;
}

let obsCounter = 0;
export function mintObservationId(): string {
  obsCounter++;
  return `obs_${Date.now().toString(36)}_${obsCounter}`;
}

// Singleton — set by main.ts at boot. Exported so tools / WS handlers can reach it.
let singleton: TasksManager | null = null;

export function setTasksSingleton(m: TasksManager): void {
  singleton = m;
}

export function getTasksSingleton(): TasksManager | null {
  return singleton;
}
