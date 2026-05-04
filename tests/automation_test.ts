import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectConfigReferences, formatAutomationTrace, validateAutomationConfig } from "../tools.ts";

Deno.test("collectConfigReferences — top-level entity_id and service strings", () => {
  const config = {
    alias: "Hallway lights at sunset",
    trigger: [{ platform: "sun", event: "sunset" }],
    action: [
      { service: "light.turn_on", target: { entity_id: "light.hallway" } },
    ],
  };
  const out = collectConfigReferences(config);
  assertEquals(out.services, ["light.turn_on"]);
  assertEquals(out.entityIds, ["light.hallway"]);
});

Deno.test("collectConfigReferences — nested choose / sequence walks recursively", () => {
  const config = {
    action: [{
      choose: [{
        conditions: [{ condition: "state", entity_id: "binary_sensor.front_door", state: "on" }],
        sequence: [
          { service: "notify.mobile_app", data: { message: "Door is open" } },
          { service: "switch.turn_on", target: { entity_id: ["switch.porch", "switch.path"] } },
        ],
      }],
      default: [{ service: "light.turn_off", target: { entity_id: "light.hallway" } }],
    }],
  };
  const out = collectConfigReferences(config);
  assertEquals(out.services.sort(), ["light.turn_off", "notify.mobile_app", "switch.turn_on"]);
  assertEquals(
    out.entityIds.sort(),
    ["binary_sensor.front_door", "light.hallway", "switch.path", "switch.porch"],
  );
});

Deno.test("collectConfigReferences — skips templates", () => {
  const config = {
    action: [
      { service: "{{ states('input_text.svc') }}", target: { entity_id: "{{ states('input_text.eid') }}" } },
      { service: "light.turn_on", target: { entity_id: "light.real" } },
    ],
  };
  const out = collectConfigReferences(config);
  // Only the literal entries are collected; the template strings are skipped.
  assertEquals(out.services, ["light.turn_on"]);
  assertEquals(out.entityIds, ["light.real"]);
});

Deno.test("collectConfigReferences — entity_id list is flattened", () => {
  const config = { action: { service: "light.turn_off", target: { entity_id: ["light.a", "light.b", "light.c"] } } };
  const out = collectConfigReferences(config);
  assertEquals(out.entityIds.sort(), ["light.a", "light.b", "light.c"]);
});

Deno.test("validateAutomationConfig — warnings for unknown entity / service", () => {
  const config = {
    action: [
      { service: "light.turn_on", target: { entity_id: "light.real" } },
      { service: "fake.service", target: { entity_id: "light.fake" } },
    ],
  };
  const known = new Set(["light.real"]);
  const knownSvc = new Set(["light.turn_on"]);
  const out = validateAutomationConfig(config, known, knownSvc);
  // Two warnings: fake.service AND light.fake.
  assertEquals(out.warnings.length, 2);
  assert(out.warnings.some((w) => w.includes("light.fake")));
  assert(out.warnings.some((w) => w.includes("fake.service")));
});

Deno.test("validateAutomationConfig — clean config has no warnings", () => {
  const config = {
    action: [{ service: "light.turn_on", target: { entity_id: "light.real" } }],
  };
  const out = validateAutomationConfig(
    config,
    new Set(["light.real"]),
    new Set(["light.turn_on"]),
  );
  assertEquals(out.warnings, []);
});

Deno.test("formatAutomationTrace — surfaces trigger, steps, and errors", () => {
  const trace = {
    domain: "automation",
    item_id: "1234",
    run_id: "abc",
    state: "stopped",
    script_execution: "finished",
    timestamp: { start: "2026-05-04T09:00:00.000Z", finish: "2026-05-04T09:00:01.500Z" },
    trigger: "state of binary_sensor.front_door",
    trace: {
      "trigger/0": [{
        timestamp: "2026-05-04T09:00:00.010Z",
        changed_variables: { trigger: { platform: "state", description: "front door opened" } },
      }],
      "condition/0": [{
        timestamp: "2026-05-04T09:00:00.020Z",
        result: { result: true },
      }],
      "action/0": [{
        timestamp: "2026-05-04T09:00:00.030Z",
        result: { params: { domain: "light", service: "turn_on" } },
      }],
      "action/1": [{
        timestamp: "2026-05-04T09:00:00.040Z",
        error: "service unavailable",
      }],
    },
  };
  const out = formatAutomationTrace(trace);
  assert(out.includes("Automation 1234 run abc"));
  assert(out.includes("State: stopped"));
  assert(/Trigger: state of binary_sensor\.front_door/.test(out));
  assert(out.includes("trigger/0"));
  assert(/condition\/0\s+condition=true/.test(out));
  assert(/action\/0\s+called/.test(out));
  assert(/action\/1.*ERROR=service unavailable/.test(out));
});
