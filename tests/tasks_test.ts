import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { type Task, validateTaskSpec } from "../tasks.ts";
import { fireTask, parseDecision } from "../tasks-fire.ts";
import type { HAClient } from "../ha-client.ts";

Deno.test("validateTaskSpec — accepts a minimal at-trigger reminder", () => {
  const out = validateTaskSpec({
    brief: "remind me",
    trigger: { kind: "at", ts: Date.now() + 60_000 },
  });
  assertEquals(out.trigger.kind, "at");
  assertEquals(out.termination.kind, "one_shot_on_fire");
  assertEquals(out.context, {});
});

Deno.test("validateTaskSpec — at trigger accepts delayMs and resolves to ts", () => {
  const before = Date.now();
  const out = validateTaskSpec({
    brief: "remind me",
    trigger: { kind: "at", delayMs: 300_000 },
  });
  const after = Date.now();
  if (out.trigger.kind !== "at") throw new Error("kind");
  // ts should be ~now + 300_000, within the validation window.
  if (out.trigger.ts < before + 300_000) throw new Error(`ts too small: ${out.trigger.ts}`);
  if (out.trigger.ts > after + 300_000) throw new Error(`ts too large: ${out.trigger.ts}`);
});

Deno.test("validateTaskSpec — at trigger requires ts or delayMs", () => {
  assertThrows(
    () => validateTaskSpec({ brief: "x", trigger: { kind: "at" } }),
    Error,
    "ts (epoch ms) or delayMs",
  );
});

Deno.test("validateTaskSpec — minIntervalMs defaults to 5s", () => {
  const out = validateTaskSpec({
    brief: "x",
    trigger: { kind: "every", intervalMs: 60_000 },
  });
  assertEquals(out.minIntervalMs, 5_000);
});

Deno.test("validateTaskSpec — minIntervalMs honours override", () => {
  const out = validateTaskSpec({
    brief: "x",
    trigger: { kind: "every", intervalMs: 60_000 },
    minIntervalMs: 30_000,
  });
  assertEquals(out.minIntervalMs, 30_000);
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

Deno.test("fireTask — reminder (no cameraFrames) short-circuits LLM and notifies with brief", async () => {
  const task: Task = {
    id: "t1",
    brief: "Take your medication.",
    trigger: { kind: "at", ts: Date.now() },
    context: { parentThread: true },
    termination: { kind: "one_shot_on_fire" },
    status: "watching",
    observations: [],
    cost: { fires: 0, framesAnalyzed: 0 },
    createdAt: Date.now(),
    ttlAfterFireMs: 1000,
    maxObservations: 10,
    minIntervalMs: 5000,
  };
  // ha is unused on this code path — pass an empty stub.
  const out = await fireTask(task, "at", {} as HAClient);
  assertEquals(out.observation.decision, "notify");
  assertEquals(out.observation.framePaths.length, 0);
  assertEquals(out.notification?.summary, "Take your medication.");
  assertEquals(out.notification?.confidence, 1);
});
