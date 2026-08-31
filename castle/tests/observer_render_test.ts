import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { EventBatch, ObservedEvent } from "../observer-events.ts";
import { renderBatch } from "../observer-render.ts";

const T0 = Date.parse("2026-08-31T18:41:02Z");

function batch(events: ObservedEvent[], extra: Partial<EventBatch> = {}): EventBatch {
  return {
    windowStart: events[0]?.ts ?? T0,
    windowEnd: events.at(-1)?.ts ?? T0,
    events,
    suppressed: new Map(),
    dropped: 0,
    ...extra,
  };
}

const lightOn = (ts: number, id = "light.kitchen", cause: "manual" | "automated" | "device" = "device"): ObservedEvent => ({
  kind: "transition",
  ts,
  entityId: id,
  from: "off",
  to: "on",
  cause,
});

Deno.test("renderBatch — an empty batch renders nothing at all", () => {
  // Load-bearing: this is what stops an empty window waking the agent.
  assertEquals(renderBatch(batch([])), null);
});

Deno.test("renderBatch — groups events under fixed section headings", () => {
  const out = renderBatch(
    batch([
      { kind: "automation_triggered", ts: T0, entityId: "automation.hall", name: "Hall light" },
      { kind: "unavailable", ts: T0 + 1000, entityId: "sensor.garage", from: "18.4" },
      lightOn(T0 + 2000, "light.lounge", "manual"),
      lightOn(T0 + 3000, "light.hall", "automated"),
    ]),
  )!;
  assertStringIncludes(out, "AUTOMATIONS / SCRIPTS FIRED");
  assertStringIncludes(out, "UNAVAILABLE / RECOVERED");
  assertStringIncludes(out, "MANUAL (a person did this)");
  assertStringIncludes(out, "AUTOMATED / DEVICE");
  // Section order is stable so the model can skim rather than parse.
  assert(out.indexOf("AUTOMATIONS") < out.indexOf("UNAVAILABLE"));
  assert(out.indexOf("UNAVAILABLE") < out.indexOf("MANUAL"));
  assert(out.indexOf("MANUAL") < out.indexOf("AUTOMATED"));
});

Deno.test("renderBatch — omits sections that have no events", () => {
  const out = renderBatch(batch([lightOn(T0)]))!;
  assertEquals(out.includes("UNAVAILABLE / RECOVERED"), false);
  assertEquals(out.includes("MANUAL"), false);
});

Deno.test("renderBatch — separates manual from automated causation", () => {
  const out = renderBatch(
    batch([lightOn(T0, "light.a", "manual"), lightOn(T0 + 1000, "light.b", "automated")]),
  )!;
  const manualIdx = out.indexOf("MANUAL");
  const autoIdx = out.indexOf("AUTOMATED / DEVICE");
  assert(out.slice(manualIdx, autoIdx).includes("light.a"));
  assert(out.slice(autoIdx).includes("light.b"));
  assertStringIncludes(out, "(by automation)");
});

Deno.test("renderBatch — annotates an automation that fired repeatedly", () => {
  const fire = (ts: number): ObservedEvent => ({
    kind: "automation_triggered",
    ts,
    entityId: "automation.hall",
    name: "Hall light",
  });
  const out = renderBatch(batch([fire(T0), fire(T0 + 60_000), fire(T0 + 120_000)]))!;
  assertStringIncludes(out, "(fire 1 of 3)");
  assertStringIncludes(out, "(fire 3 of 3)");
});

Deno.test("renderBatch — a single fire is not annotated with a count", () => {
  const out = renderBatch(
    batch([{ kind: "automation_triggered", ts: T0, entityId: "automation.hall", name: "Hall" }]),
  )!;
  assertEquals(out.includes("fire 1 of"), false);
});

Deno.test("renderBatch — reports how long an entity was down", () => {
  const out = renderBatch(
    batch([
      { kind: "recovered", ts: T0, entityId: "light.porch", to: "on", downForMs: 38_000 },
    ]),
  )!;
  assertStringIncludes(out, "recovered after 38s");
});

Deno.test("renderBatch — surfaces suppressed counts, which are the flapping signal", () => {
  const out = renderBatch(
    batch([lightOn(T0)], {
      suppressed: new Map([["binary_sensor.hall_motion", 41]]),
    }),
  )!;
  assertStringIncludes(out, "REPEATED (suppressed, count only)");
  assertStringIncludes(out, "binary_sensor.hall_motion");
  assertStringIncludes(out, "+41 more within the 30s cooldown");
});

Deno.test("renderBatch — says so when the buffer already lost events", () => {
  const out = renderBatch(batch([lightOn(T0)], { dropped: 50 }))!;
  assertStringIncludes(out, "50 events lost to the buffer cap");
  assertStringIncludes(out, "sample, not everything");
});

Deno.test("renderBatch — stays under the byte cap and cuts whole lines", () => {
  const events = Array.from(
    { length: 200 },
    (_, i) => lightOn(T0 + i * 1000, `light.a_very_long_entity_name_number_${i}`),
  );
  const out = renderBatch(batch(events))!;
  assert(new TextEncoder().encode(out).length <= 4 * 1024, "exceeded the 4 KB cap");
  assertStringIncludes(out, "lines cut to fit");
  // Every surviving entity id must be whole — a half-truncated id is
  // indistinguishable from a real one and would get cited in an observation.
  for (const line of out.split("\n")) {
    const m = line.match(/light\.a_very_long_entity_name_number_(\d+)/);
    if (m) assert(line.includes(`${m[0]} off -> on`), `truncated id in: ${line}`);
  }
});

Deno.test("renderBatch — header states the count and the window", () => {
  const out = renderBatch(batch([lightOn(T0), lightOn(T0 + 192_000, "light.b")]))!;
  assertStringIncludes(out, "2 events over 3m12s");
  assertStringIncludes(out, "UTC");
});

Deno.test("renderBatch — renders wall-clock times in the house timezone", () => {
  const utc = renderBatch(batch([lightOn(T0)]), "UTC")!;
  const syd = renderBatch(batch([lightOn(T0)]), "Australia/Sydney")!;
  assertStringIncludes(utc, "18:41:02");
  assertStringIncludes(syd, "04:41:02");
});

Deno.test("renderBatch — a garbage timezone degrades instead of throwing", () => {
  const out = renderBatch(batch([lightOn(T0)]), "Not/AZone")!;
  assertStringIncludes(out, "18:41:02");
});
