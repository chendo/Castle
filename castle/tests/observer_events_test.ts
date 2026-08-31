import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  classify,
  EventBuffer,
  isSignificant,
  isUrgent,
  type ObservedEvent,
} from "../observer-events.ts";
import type { HAState } from "../ha-client.ts";

const T0 = Date.parse("2026-08-31T18:00:00Z");

function state(
  entityId: string,
  value: string,
  opts: {
    deviceClass?: string;
    userId?: string;
    parentId?: string;
    changedAt?: number;
    friendlyName?: string;
  } = {},
): HAState {
  const iso = new Date(opts.changedAt ?? T0).toISOString();
  return {
    entity_id: entityId,
    state: value,
    attributes: {
      ...(opts.deviceClass ? { device_class: opts.deviceClass } : {}),
      ...(opts.friendlyName ? { friendly_name: opts.friendlyName } : {}),
    },
    last_changed: iso,
    last_updated: iso,
    context: {
      id: "ctx",
      parent_id: opts.parentId ?? null,
      user_id: opts.userId ?? null,
    },
  };
}

function transition(entityId: string, to: string, deviceClass?: string): ObservedEvent {
  return {
    kind: "transition",
    ts: T0,
    entityId,
    from: to === "on" ? "off" : "on",
    to,
    cause: "device",
    deviceClass,
  };
}

// --- classify ---------------------------------------------------------------

Deno.test("classify — unchanged state produces nothing", () => {
  const s = state("light.kitchen", "on");
  assertEquals(classify("light.kitchen", s, s, T0), null);
});

Deno.test("classify — a removed entity produces nothing", () => {
  assertEquals(classify("light.kitchen", state("light.kitchen", "on"), null, T0), null);
});

Deno.test("classify — going unavailable is its own kind, not a transition", () => {
  const e = classify(
    "sensor.garage",
    state("sensor.garage", "18.4"),
    state("sensor.garage", "unavailable"),
    T0,
  );
  assertEquals(e?.kind, "unavailable");
  assertEquals(e?.kind === "unavailable" ? e.from : null, "18.4");
});

Deno.test("classify — unknown counts as going dark, same as unavailable", () => {
  const e = classify(
    "sensor.garage",
    state("sensor.garage", "18.4"),
    state("sensor.garage", "unknown"),
    T0,
  );
  assertEquals(e?.kind, "unavailable");
});

Deno.test("classify — no loss to report when nothing was readable before", () => {
  assertEquals(
    classify(
      "sensor.garage",
      state("sensor.garage", "unknown"),
      state("sensor.garage", "unavailable"),
      T0,
    ),
    null,
  );
});

Deno.test("classify — recovery reports how long the entity was down", () => {
  const e = classify(
    "light.porch",
    state("light.porch", "unavailable", { changedAt: T0 - 38_000 }),
    state("light.porch", "on"),
    T0,
  );
  assertEquals(e?.kind, "recovered");
  assertEquals(e?.kind === "recovered" ? e.downForMs : null, 38_000);
});

Deno.test("classify — attributes a change with user_id to a human", () => {
  const e = classify(
    "light.kitchen",
    state("light.kitchen", "off"),
    state("light.kitchen", "on", { userId: "u1" }),
    T0,
  );
  assertEquals(e?.kind === "transition" ? e.cause : null, "manual");
});

Deno.test("classify — attributes a change with parent_id to an automation", () => {
  const e = classify(
    "light.kitchen",
    state("light.kitchen", "off"),
    state("light.kitchen", "on", { parentId: "p1" }),
    T0,
  );
  assertEquals(e?.kind === "transition" ? e.cause : null, "automated");
});

Deno.test("classify — bare context means the device reported it itself", () => {
  const e = classify(
    "light.kitchen",
    state("light.kitchen", "off"),
    state("light.kitchen", "on"),
    T0,
  );
  assertEquals(e?.kind === "transition" ? e.cause : null, "device");
});

// --- isSignificant ----------------------------------------------------------

Deno.test("isSignificant — numeric sensor churn is dropped", () => {
  assertFalse(isSignificant(transition("sensor.living_room_temperature", "21.5")));
});

Deno.test("isSignificant — a light transition is kept", () => {
  assert(isSignificant(transition("light.kitchen", "on")));
});

Deno.test("isSignificant — binary_sensor needs a meaningful device_class", () => {
  assert(isSignificant(transition("binary_sensor.front_door", "on", "door")));
  assertFalse(isSignificant(transition("binary_sensor.phone_charging", "on", "battery_charging")));
  assertFalse(isSignificant(transition("binary_sensor.mystery", "on")));
});

Deno.test("isSignificant — media_player only when something starts playing", () => {
  assert(isSignificant(transition("media_player.lounge", "playing")));
  assertFalse(isSignificant(transition("media_player.lounge", "paused")));
});

Deno.test("isSignificant — health signals bypass the domain allowlist", () => {
  // sensor.* transitions are dropped, but a sensor going dark is the point.
  assert(isSignificant({ kind: "unavailable", ts: T0, entityId: "sensor.garage", from: "18.4" }));
  assert(
    isSignificant({ kind: "recovered", ts: T0, entityId: "sensor.garage", to: "18.4", downForMs: 1 }),
  );
  assert(
    isSignificant({
      kind: "automation_triggered",
      ts: T0,
      entityId: "automation.x",
      name: "X",
    }),
  );
});

// --- isUrgent ---------------------------------------------------------------

Deno.test("isUrgent — smoke going on is urgent, motion is not", () => {
  assert(isUrgent(transition("binary_sensor.hall_smoke", "on", "smoke")));
  assertFalse(isUrgent(transition("binary_sensor.hall_motion", "on", "motion")));
});

Deno.test("isUrgent — losing a lock is urgent, losing a light is not", () => {
  assert(isUrgent({ kind: "unavailable", ts: T0, entityId: "lock.front", from: "locked" }));
  assertFalse(isUrgent({ kind: "unavailable", ts: T0, entityId: "light.porch", from: "on" }));
});

// --- EventBuffer ------------------------------------------------------------

function motion(ts: number): ObservedEvent {
  return {
    kind: "transition",
    ts,
    entityId: "binary_sensor.hall_motion",
    from: "off",
    to: "on",
    cause: "device",
    deviceClass: "motion",
  };
}

Deno.test("EventBuffer — repeated motion inside 30s collapses to one event", () => {
  const buf = new EventBuffer(() => T0 + 30_000);
  for (let i = 0; i < 6; i++) buf.ingest(motion(T0 + i * 4_000));
  const batch = buf.drain();
  assertEquals(batch.events.length, 1);
  assertEquals(batch.suppressed.get("binary_sensor.hall_motion"), 5);
});

Deno.test("EventBuffer — suppressed events are counted, never silently dropped", () => {
  const buf = new EventBuffer(() => T0);
  buf.ingest(motion(T0));
  buf.ingest(motion(T0 + 1_000));
  const batch = buf.drain();
  // The finding "this sensor is flapping" only exists if the count survives.
  assertEquals(batch.suppressed.get("binary_sensor.hall_motion"), 1);
});

Deno.test("EventBuffer — a light toggled every 6s is kept up to the per-entity cap", () => {
  const buf = new EventBuffer(() => T0 + 60_000);
  for (let i = 0; i < 5; i++) {
    buf.ingest({
      kind: "transition",
      ts: T0 + i * 6_000,
      entityId: "light.kitchen",
      from: i % 2 === 0 ? "off" : "on",
      to: i % 2 === 0 ? "on" : "off",
      cause: "manual",
    });
  }
  const batch = buf.drain();
  assertEquals(batch.events.length, 3);
  assertEquals(batch.suppressed.get("light.kitchen"), 2);
});

Deno.test("EventBuffer — insignificant events never enter the buffer", () => {
  const buf = new EventBuffer(() => T0);
  const r = buf.ingest(transition("sensor.temperature", "21.5"));
  assertFalse(r.accepted);
  assertEquals(buf.size(), 0);
});

Deno.test("EventBuffer — muted entities are dropped and not even counted", () => {
  const buf = new EventBuffer(() => T0, ["binary_sensor.hall_motion"]);
  assertFalse(buf.ingest(motion(T0)).accepted);
  const batch = buf.drain();
  assertEquals(batch.events.length, 0);
  assertEquals(batch.suppressed.size, 0);
});

Deno.test("EventBuffer — urgent events bypass cooldown and the per-entity cap", () => {
  const buf = new EventBuffer(() => T0);
  const smoke = (ts: number): ObservedEvent => ({
    kind: "transition",
    ts,
    entityId: "binary_sensor.hall_smoke",
    from: "off",
    to: "on",
    cause: "device",
    deviceClass: "smoke",
  });
  for (let i = 0; i < 6; i++) buf.ingest(smoke(T0 + i * 100));
  assert(buf.hasUrgent());
  assertEquals(buf.drain().events.length, 6);
});

Deno.test("EventBuffer — the ring bound holds and reports what it lost", () => {
  const buf = new EventBuffer(() => T0 + 10 * 60_000);
  for (let i = 0; i < 250; i++) {
    buf.ingest({
      kind: "transition",
      ts: T0 + i * 10_000,
      entityId: `light.l${i}`,
      from: "off",
      to: "on",
      cause: "device",
    });
  }
  const batch = buf.drain();
  assertEquals(batch.events.length, 200);
  assertEquals(batch.dropped, 50);
});

Deno.test("EventBuffer — drain resets the window but keeps recent cooldowns", () => {
  const buf = new EventBuffer(() => T0 + 1_000);
  buf.ingest(motion(T0));
  assertEquals(buf.drain().events.length, 1);
  // Still inside the 30s window, so the next fire is suppressed rather than
  // treated as a fresh start.
  assertFalse(buf.ingest(motion(T0 + 2_000)).accepted);
});

Deno.test("EventBuffer — cooldowns older than the retention window are pruned", () => {
  let now = T0;
  const buf = new EventBuffer(() => now);
  buf.ingest(motion(T0));
  buf.drain();
  now = T0 + 6 * 60_000;
  buf.drain(); // prunes
  // The entity is forgotten, so an event 6 minutes later is accepted.
  assert(buf.ingest(motion(now + 1_000)).accepted);
});

Deno.test("EventBuffer — an empty drain reports a zero-width window, not garbage", () => {
  const buf = new EventBuffer(() => T0);
  const batch = buf.drain();
  assertEquals(batch.events.length, 0);
  assertEquals(batch.windowStart, T0);
  assertEquals(batch.windowEnd, T0);
});
