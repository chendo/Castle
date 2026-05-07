import { assert, assertEquals } from "jsr:@std/assert";
import { EventTimeline, type TimelineEvent } from "../event-timeline.ts";
import type { HAState } from "../ha-client.ts";

function state(entityId: string, value: string, attrs: Record<string, unknown> = {}): HAState {
  return {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: entityId, ...attrs },
    last_changed: new Date(0).toISOString(),
    last_updated: new Date(0).toISOString(),
  };
}

function captured(timeline: EventTimeline): { events: TimelineEvent[]; unsub: () => void } {
  const events: TimelineEvent[] = [];
  const unsub = timeline.subscribe((e) => { events.push(e); });
  return { events, unsub };
}

Deno.test("ingestStateChange — drops noisy domains", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.ingestStateChange("sensor.temp", state("sensor.temp", "20"), state("sensor.temp", "21"), 1000);
  t.ingestStateChange("weather.home", state("weather.home", "sunny"), state("weather.home", "rainy"), 1000);
  t.ingestStateChange("sun.sun", state("sun.sun", "above_horizon"), state("sun.sun", "below_horizon"), 1000);
  assertEquals(events.length, 0);
});

Deno.test("ingestStateChange — emits motion-on once, suppresses motion-off", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  const off = state("binary_sensor.hall", "off", { device_class: "motion" });
  const on = state("binary_sensor.hall", "on", { device_class: "motion" });
  t.ingestStateChange("binary_sensor.hall", off, on, 1000);
  t.ingestStateChange("binary_sensor.hall", on, off, 1500);
  assertEquals(events.length, 1);
  assertEquals(events[0].verb, "motion detected");
});

Deno.test("ingestStateChange — binary_sensor cooldown holds for 30s", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  const off = state("binary_sensor.hall", "off", { device_class: "motion" });
  const on = state("binary_sensor.hall", "on", { device_class: "motion" });
  t.ingestStateChange("binary_sensor.hall", off, on, 1000);
  t.ingestStateChange("binary_sensor.hall", off, on, 1000 + 5_000);  // inside 30s window
  t.ingestStateChange("binary_sensor.hall", off, on, 1000 + 35_000); // outside window
  assertEquals(events.length, 2);
});

Deno.test("ingestStateChange — light transitions emit (after burst flush)", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  const off = state("light.kitchen", "off");
  const on = state("light.kitchen", "on");
  t.ingestStateChange("light.kitchen", off, on, 1000);
  // Burst is held; nothing emits until flush.
  assertEquals(events.length, 0);
  t.flushBurst();
  assertEquals(events.length, 1);
  assertEquals(events[0].domain, "light");
  assertEquals(events[0].verb, "on");
});

Deno.test("ingestStateChange — 4 light transitions in window emit individually", () => {
  // 4 lights at 1s gaps with 5s default cooldown means each is buffered into
  // separate burst windows. We bypass by flushing manually after each.
  const t = new EventTimeline();
  const { events } = captured(t);
  for (let i = 0; i < 4; i++) {
    const eid = `light.l${i}`;
    t.ingestStateChange(eid, state(eid, "off"), state(eid, "on"), 1000 + i * 100);
  }
  t.flushBurst();
  // 4 lights inside 2s burst window → 1 coalesced row (>= BURST_MIN_COUNT=3).
  assertEquals(events.length, 1);
  assertEquals(events[0].source, "burst");
});

Deno.test("ingestStateChange — 2 lights in burst window emit individually", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.ingestStateChange("light.a", state("light.a", "off"), state("light.a", "on"), 1000);
  t.ingestStateChange("light.b", state("light.b", "off"), state("light.b", "on"), 1100);
  t.flushBurst();
  // Below BURST_MIN_COUNT=3 → emitted individually.
  assertEquals(events.length, 2);
  assert(events.every((e) => e.source === "state"));
});

Deno.test("noteAgentAction — emits one row and suppresses echo", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.noteAgentAction("light", "turn_on", ["light.kitchen"], true, 1000);
  // Echoed state_change inside the suppression window is dropped.
  t.ingestStateChange("light.kitchen", state("light.kitchen", "off"), state("light.kitchen", "on"), 1500);
  assertEquals(events.length, 1);
  assertEquals(events[0].source, "agent");
  assertEquals(events[0].via_agent, true);
  assertEquals(events[0].entity_id, "light.kitchen");
});

Deno.test("noteAgentAction — echo suppression expires", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.noteAgentAction("light", "turn_on", ["light.kitchen"], true, 1000);
  // Past the 5s window — the next change should emit (after burst flush).
  t.ingestStateChange("light.kitchen", state("light.kitchen", "off"), state("light.kitchen", "on"), 7000);
  t.flushBurst();
  assertEquals(events.length, 2);
  assertEquals(events[1].source, "state");
});

Deno.test("setMutes — filters subsequent events", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.setMutes(["binary_sensor.flaky"]);
  const off = state("binary_sensor.flaky", "off", { device_class: "motion" });
  const on = state("binary_sensor.flaky", "on", { device_class: "motion" });
  t.ingestStateChange("binary_sensor.flaky", off, on, 1000);
  assertEquals(events.length, 0);
  t.setMutes([]);
  t.ingestStateChange("binary_sensor.flaky", off, on, 60_000);
  assertEquals(events.length, 1);
});

Deno.test("ingestStateChange — drops unavailable transitions in either direction", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  const on = state("light.x", "on");
  const unavailable = state("light.x", "unavailable");
  t.ingestStateChange("light.x", on, unavailable, 1000);
  t.ingestStateChange("light.x", unavailable, on, 2000);
  t.flushBurst();
  assertEquals(events.length, 0);
});

Deno.test("ingestBusEvent — automation_triggered emits with name", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  t.ingestBusEvent("automation_triggered", { name: "Movie Night" }, 1000);
  assertEquals(events.length, 1);
  assertEquals(events[0].source, "automation");
  assertEquals(events[0].subject, "Movie Night");
  assertEquals(events[0].verb, "triggered");
});

Deno.test("snapshot — keeps insertion order, capped at 200", () => {
  const t = new EventTimeline();
  for (let i = 0; i < 250; i++) {
    t.ingestBusEvent("script_started", { name: `s${i}` }, 1000 + i);
  }
  const snap = t.snapshot();
  assertEquals(snap.length, 200);
  assertEquals(snap[0].subject, "s50");
  assertEquals(snap[199].subject, "s249");
});

Deno.test("ingestStateChange — same-state transitions are ignored", () => {
  const t = new EventTimeline();
  const { events } = captured(t);
  const on = state("light.x", "on");
  t.ingestStateChange("light.x", on, on, 1000);
  t.flushBurst();
  assertEquals(events.length, 0);
});
