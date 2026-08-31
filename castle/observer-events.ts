// Event ingest for the proactive observer.
//
// Home Assistant emits state_changed for every entity on every update — a
// medium house produces tens of events per second, the overwhelming majority
// of them numeric sensor noise. An LLM cannot read that, and paying for a pass
// per event would be absurd. This module is the funnel: it turns the raw
// firehose into a small, typed, rate-controlled batch worth waking an agent
// for.
//
// Three stages, deliberately separated so the first two stay pure and testable
// without a clock, an HA connection, or an LLM:
//
//   classify()      raw state transition / bus event -> typed ObservedEvent
//   isSignificant() is this worth an agent's attention at all?
//   EventBuffer     cooldowns, per-entity caps, ring bound, urgency
//
// The filter design (domain allowlist, meaningful-transition test, cooldown +
// coalesce) follows the spec in workspace/EVENT_TIMELINE.md, which was written
// for a UI activity feed and never implemented. Two deliberate departures:
// health signals (unavailable / recovered / automation fired) bypass the
// domain allowlist entirely, because "the thing you care about stopped
// working" is the observer's whole job; and suppressed events are counted
// rather than dropped, because a sensor flapping 40 times a minute is itself
// the finding, and a silent drop would hide it.

import type { HAState } from "./ha-client.ts";

/** How a state change came about, per HA's context record. */
export type Cause = "manual" | "automated" | "device";

export type ObservedEvent =
  | { kind: "automation_triggered"; ts: number; entityId: string; name: string }
  | { kind: "script_started"; ts: number; entityId: string; name: string }
  | { kind: "unavailable"; ts: number; entityId: string; from: string }
  | { kind: "recovered"; ts: number; entityId: string; to: string; downForMs: number }
  | {
    kind: "transition";
    ts: number;
    entityId: string;
    from: string;
    to: string;
    cause: Cause;
    deviceClass?: string;
  };

export interface EventBatch {
  windowStart: number;
  windowEnd: number;
  events: ObservedEvent[];
  /** entity_id -> events swallowed by cooldown or the per-entity cap. */
  suppressed: Map<string, number>;
  /** Events lost to the ring cap, i.e. the batch is a sample not a census. */
  dropped: number;
}

// "unavailable" and "unknown" are HA's two ways of saying "no reading". They
// are never a meaningful *value*, but crossing into or out of them is exactly
// the device-health signal we want, so they're handled before the allowlist.
const NO_READING = new Set(["unavailable", "unknown"]);

// Domains where a state transition is a real-world event a person would
// recognise. Everything absent from this set is dropped: sensor/weather/sun/
// number/update/tts/stt/conversation/persistent_notification and friends are
// either continuous telemetry (the observer pulls those on demand with
// get_history) or Castle's own plumbing echoing back at us.
const TRANSITION_DOMAINS = new Set([
  "lock",
  "cover",
  "alarm_control_panel",
  "climate",
  "light",
  "switch",
  "fan",
  "input_boolean",
  "person",
  "device_tracker",
]);

// binary_sensor is half signal, half noise: door/motion/smoke matter, while
// battery/connectivity/power/plug flap constantly and mean nothing here. The
// device_class is the only reliable discriminator, so an unclassed
// binary_sensor is dropped rather than guessed at.
const BINARY_SENSOR_CLASSES = new Set([
  "door",
  "window",
  "garage_door",
  "opening",
  "motion",
  "occupancy",
  "presence",
  "smoke",
  "gas",
  "co",
  "moisture",
  "safety",
  "sound",
  "tamper",
  "vibration",
]);

/** Device classes where a `binary_sensor` going `on` is an emergency. */
const ALARM_CLASSES = new Set(["smoke", "gas", "co", "moisture"]);

/** Domains where losing an entity entirely is urgent rather than routine. */
const CRITICAL_DOMAINS = new Set(["alarm_control_panel", "lock", "climate", "camera"]);

export function domainOf(entityId: string): string {
  const i = entityId.indexOf(".");
  return i < 0 ? entityId : entityId.slice(0, i);
}

/** HA's context tells us who caused a change; absent context means the
 *  integration reported it unprompted. */
function causeOf(s: HAState | null): Cause {
  const ctx = s?.context;
  if (ctx?.user_id) return "manual";
  if (ctx?.parent_id) return "automated";
  return "device";
}

/**
 * Turn one HA state transition into a typed event, or null when it carries no
 * information (no new state, or the value didn't actually move — HA re-emits
 * unchanged states constantly as attributes tick over).
 *
 * `now` is passed rather than read so callers can replay a batch of historical
 * transitions deterministically.
 */
export function classify(
  entityId: string,
  oldState: HAState | null,
  newState: HAState | null,
  now: number,
): ObservedEvent | null {
  // Entity removed from the registry: not a health signal, just gone.
  if (!newState) return null;

  const from = oldState?.state ?? "";
  const to = newState.state;
  if (from === to) return null;

  const goingDark = NO_READING.has(to);
  const comingBack = from !== "" && NO_READING.has(from) && !goingDark;

  if (goingDark) {
    // Nothing was ever readable, so there's no loss to report.
    if (from === "" || NO_READING.has(from)) return null;
    return { kind: "unavailable", ts: now, entityId, from };
  }

  if (comingBack) {
    const since = Date.parse(oldState?.last_changed ?? "");
    const downForMs = Number.isFinite(since) ? Math.max(0, now - since) : 0;
    return { kind: "recovered", ts: now, entityId, to, downForMs };
  }

  const deviceClass = typeof newState.attributes?.device_class === "string"
    ? newState.attributes.device_class
    : undefined;

  return {
    kind: "transition",
    ts: now,
    entityId,
    from,
    to,
    cause: causeOf(newState),
    deviceClass,
  };
}

/**
 * Is this event worth an agent's attention? Health signals always are;
 * transitions have to earn it by domain (and, for binary_sensor, by
 * device_class).
 */
export function isSignificant(e: ObservedEvent): boolean {
  switch (e.kind) {
    case "automation_triggered":
    case "script_started":
    case "unavailable":
    case "recovered":
      return true;
    case "transition": {
      const domain = domainOf(e.entityId);
      if (domain === "binary_sensor") {
        return e.deviceClass !== undefined && BINARY_SENSOR_CLASSES.has(e.deviceClass);
      }
      // media_player transitions through paused/idle/buffering constantly and
      // volume changes churn attributes; only "something started playing" is
      // an event a person would name.
      if (domain === "media_player") return e.to === "playing";
      return TRANSITION_DOMAINS.has(domain);
    }
  }
}

/** Events that should collapse the debounce window rather than wait it out. */
export function isUrgent(e: ObservedEvent): boolean {
  if (e.kind === "unavailable") return CRITICAL_DOMAINS.has(domainOf(e.entityId));
  if (e.kind !== "transition") return false;
  if (domainOf(e.entityId) === "alarm_control_panel") return e.to === "triggered";
  if (domainOf(e.entityId) === "binary_sensor" && e.to === "on") {
    return e.deviceClass !== undefined && ALARM_CLASSES.has(e.deviceClass);
  }
  return false;
}

// Motion and occupancy sensors retrigger every few seconds while someone is in
// the room; 30s is long enough to collapse one person walking around into one
// event. Everything else gets a short window that only catches genuine
// duplicates.
const COOLDOWN_BINARY_SENSOR_MS = 30_000;
const COOLDOWN_DEFAULT_MS = 5_000;
/** One entity can't dominate a batch; beyond this it's counted, not listed. */
const MAX_PER_ENTITY = 3;
/** Ring bound. ~200 events is well inside the rendered 4 KB budget. */
const MAX_BUFFERED = 200;
/** Cooldown entries older than this are pruned on drain so the map can't grow. */
const COOLDOWN_RETENTION_MS = 5 * 60_000;

/**
 * Accumulates significant events between passes, applying per-entity cooldowns
 * and caps so one chatty sensor can't crowd out everything else.
 *
 * Cleanup: holds no timers and no subscriptions — the owner (observer-runtime)
 * owns those and calls drain(). Both internal maps are bounded: `counts` and
 * the ring are cleared on every drain, and `cooldown` is pruned to entities
 * seen in the last 5 minutes. Cost per ingest is one string split, one Set
 * lookup and two Map operations; the significance filter rejects the bulk of
 * the firehose before any of that.
 */
export class EventBuffer {
  private events: ObservedEvent[] = [];
  private cooldown = new Map<string, number>();
  private counts = new Map<string, number>();
  private suppressed = new Map<string, number>();
  private dropped = 0;
  private windowStart = 0;
  private urgent = false;
  private muted: Set<string>;

  constructor(private readonly now: () => number = Date.now, muted: Iterable<string> = []) {
    this.muted = new Set(muted);
  }

  /** Replace the mute set. Takes effect on the next ingest. */
  setMuted(ids: Iterable<string>): void {
    this.muted = new Set(ids);
  }

  /**
   * Offer an event to the buffer. Returns whether it was kept and whether it
   * should shorten the debounce. Insignificant, muted and cooled-down events
   * are rejected here rather than by the caller so there is one filter.
   */
  ingest(e: ObservedEvent): { accepted: boolean; urgent: boolean } {
    if (!isSignificant(e)) return { accepted: false, urgent: false };
    if (this.muted.has(e.entityId)) return { accepted: false, urgent: false };

    const urgent = isUrgent(e);
    const now = e.ts;

    // Urgent events bypass cooldown and the per-entity cap: a smoke alarm
    // retriggering must never be swallowed by the same rule that quietens a
    // hallway motion sensor.
    if (!urgent) {
      const window = domainOf(e.entityId) === "binary_sensor"
        ? COOLDOWN_BINARY_SENSOR_MS
        : COOLDOWN_DEFAULT_MS;
      const last = this.cooldown.get(e.entityId);
      if (last !== undefined && now - last < window) {
        this.bumpSuppressed(e.entityId);
        return { accepted: false, urgent: false };
      }
      if ((this.counts.get(e.entityId) ?? 0) >= MAX_PER_ENTITY) {
        this.bumpSuppressed(e.entityId);
        return { accepted: false, urgent: false };
      }
    }

    this.cooldown.set(e.entityId, now);
    this.counts.set(e.entityId, (this.counts.get(e.entityId) ?? 0) + 1);
    if (this.events.length === 0) this.windowStart = now;
    this.events.push(e);
    if (this.events.length > MAX_BUFFERED) {
      this.events.shift();
      this.dropped++;
    }
    if (urgent) this.urgent = true;
    return { accepted: true, urgent };
  }

  private bumpSuppressed(entityId: string): void {
    this.suppressed.set(entityId, (this.suppressed.get(entityId) ?? 0) + 1);
  }

  size(): number {
    return this.events.length;
  }

  hasUrgent(): boolean {
    return this.urgent;
  }

  /** Take everything buffered and reset for the next window. */
  drain(): EventBatch {
    const now = this.now();
    const batch: EventBatch = {
      windowStart: this.events.length > 0 ? this.windowStart : now,
      windowEnd: now,
      events: this.events,
      suppressed: this.suppressed,
      dropped: this.dropped,
    };
    this.events = [];
    this.suppressed = new Map();
    this.counts.clear();
    this.dropped = 0;
    this.urgent = false;
    // Keep recent cooldowns so a drain doesn't reopen the floodgates on a
    // flapping entity, but don't accumulate an entry per entity forever.
    for (const [id, ts] of this.cooldown) {
      if (now - ts > COOLDOWN_RETENTION_MS) this.cooldown.delete(id);
    }
    return batch;
  }
}
