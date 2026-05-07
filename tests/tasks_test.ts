import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { validateTaskSpec } from "../tasks.ts";
import { parseDecision } from "../tasks-fire.ts";

Deno.test("validateTaskSpec — accepts a minimal at-trigger reminder", () => {
  const out = validateTaskSpec({
    brief: "remind me",
    trigger: { kind: "at", ts: Date.now() + 60_000 },
  });
  assertEquals(out.trigger.kind, "at");
  assertEquals(out.termination.kind, "one_shot_on_fire");
  assertEquals(out.context, {});
});

Deno.test("validateTaskSpec — every with floor", () => {
  assertThrows(
    () => validateTaskSpec({ brief: "x", trigger: { kind: "every", intervalMs: 100 } }),
    Error,
    "intervalMs must be ≥",
  );
  const out = validateTaskSpec({ brief: "x", trigger: { kind: "every", intervalMs: 60_000 } });
  assertEquals(out.trigger.kind === "every" ? out.trigger.intervalMs : 0, 60_000);
});

Deno.test("validateTaskSpec — on_state requires entity with dot", () => {
  assertThrows(
    () => validateTaskSpec({ brief: "x", trigger: { kind: "on_state", entity: "no_dot" } }),
    Error,
    "entity",
  );
  const out = validateTaskSpec({
    brief: "x",
    trigger: { kind: "on_state", entity: "binary_sensor.gate", to: "on" },
  });
  if (out.trigger.kind !== "on_state") throw new Error("kind");
  assertEquals(out.trigger.to, "on");
});

Deno.test("validateTaskSpec — on_event refuses state_changed", () => {
  assertThrows(
    () => validateTaskSpec({ brief: "x", trigger: { kind: "on_event", eventType: "state_changed" } }),
    Error,
    "use on_state",
  );
});

Deno.test("validateTaskSpec — any_of recurses", () => {
  const out = validateTaskSpec({
    brief: "x",
    trigger: {
      kind: "any_of",
      triggers: [
        { kind: "every", intervalMs: 60_000 },
        { kind: "on_state", entity: "binary_sensor.gate" },
      ],
    },
  });
  if (out.trigger.kind !== "any_of") throw new Error("kind");
  assertEquals(out.trigger.triggers.length, 2);
});

Deno.test("validateTaskSpec — cameraFrames requires camera.* entity", () => {
  assertThrows(
    () => validateTaskSpec({
      brief: "x",
      trigger: { kind: "every", intervalMs: 60_000 },
      context: { cameraFrames: { entity: "binary_sensor.x", lastN: 5 } },
    }),
    Error,
    "camera",
  );
});

Deno.test("validateTaskSpec — brief required", () => {
  assertThrows(
    () => validateTaskSpec({ brief: "", trigger: { kind: "every", intervalMs: 60_000 } }),
    Error,
    "brief",
  );
});

Deno.test("parseDecision — wait", () => {
  const r = parseDecision('{"decision":"wait","narrative":"empty driveway","confidence":0.1}');
  assertEquals(r.decision, "wait");
  assertEquals(r.narrative, "empty driveway");
});

Deno.test("parseDecision — notify with summary", () => {
  const r = parseDecision('{"decision":"notify","narrative":"van arriving","confidence":0.9,"notify":{"summary":"delivery"}}');
  assertEquals(r.decision, "notify");
  assertEquals(r.notify?.summary, "delivery");
});

Deno.test("parseDecision — notify without summary held to wait", () => {
  const r = parseDecision('{"decision":"notify","narrative":"x","confidence":0.9}');
  assertEquals(r.decision, "wait");
});

Deno.test("parseDecision — low-confidence notify held to wait", () => {
  const r = parseDecision('{"decision":"notify","narrative":"x","confidence":0.5,"notify":{"summary":"y"}}');
  assertEquals(r.decision, "wait");
});

Deno.test("parseDecision — strips code fences", () => {
  const r = parseDecision('```json\n{"decision":"wait","narrative":"x"}\n```');
  assertEquals(r.decision, "wait");
});

Deno.test("parseDecision — non-JSON falls back to wait", () => {
  const r = parseDecision("I'm waiting for the delivery");
  assertEquals(r.decision, "wait");
});
