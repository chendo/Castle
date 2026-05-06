// Integration tests: multi-turn context, cross-domain coordination, and problem-solving.
// These test the agent's ability to maintain entity references across turns and
// chain multiple tool calls for complex goals.

import { assert } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

async function testRun(prompt: string, opts?: { timeoutMs?: number; resetBefore?: boolean }) {
  return S.runConversation(prompt, opts);
}

// ── Entity Reference Resolution ─────────────────────────────────────────────

Deno.test({
  name: "context — entity reference resolution across turns (turn on then dim)",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    // First turn: turn on the light
    await S.setEntityState(HA_BASE, lightId, "off");

    const turn1 = await testRun(
      `Turn on the light ${lightId}.`,
    );

    S.assertToolCalled(turn1, "ha_call_service", (args) =>
      args?.domain === "light" && String(args?.entity_id ?? "") === lightId,
    );
    await S.assertEntityState(HA_BASE, lightId, "on");

    // Second turn: reference the same entity via description ("dim them").
    // Don't reset — this turn intentionally needs turn1's history to resolve
    // "it" to lightId from context.
    const turn2 = await testRun(
      `Now dim it to 50% brightness.`,
      { resetBefore: false },
    );

    // The agent should call ha_call_service with the correct entity_id inferred from context
    S.assertToolCalled(turn2, "ha_call_service", (args) => {
      return args?.domain === "light" && String(args?.entity_id ?? "") === lightId;
    });
  },
});

Deno.test({
  name: "context — cross-domain coordination (good night mode)",
  fn: async () => {
    const lights = await S.getLightEntityIds(HA_BASE);
    if (lights.length === 0) throw new Error("No lights found in HA demo");

    // Good night mode should chain multiple service calls across domains
    const result = await testRun(
      `Activate good night mode: turn off all lights and set the climate to sleep temperature using ha_call_service.`,
    );

    // Should have at least 2 tool calls (lights + climate)
    S.assertAtLeastNTotalTools(result, 2);

    // Verify actual state changes for lights
    const lightCalls = result.toolCalls.filter((t) => t.toolName === "ha_call_service");
    if (lightCalls.length > 0) {
      // At least one light turn_off should have been called
      const hasLightOff = lightCalls.some((tc) =>
        tc.args?.domain === "light" && String(tc.args?.service ?? "") === "turn_off",
      );
      assert(hasLightOff, `Expected a light.turn_off call in good night mode. Got: [${lightCalls.map((t) => JSON.stringify(t.args)).join(", ")}]`);
    }

    // Read-only check on the climate side — it may or may not exist
    const hasClimate = result.toolCalls.some((tc) => tc.args?.domain === "climate");
    // Either climate was addressed OR there were enough other tool calls
    assert(hasClimate || lightCalls.length >= 2, "Expected lights + climate actions in good night mode");
  },
});

Deno.test({
  name: "context — problem solving: diagnose why a device won't turn on",
  fn: async () => {
    const switchId = await S.findDemoSwitch(HA_BASE);
    if (!switchId) throw new Error("No switch entity found in HA demo");

    // Ensure it's already on so the "turn off" fails gracefully for diagnosis
    await S.setEntityState(HA_BASE, switchId, "on");

    const result = await testRun(
      `I tried turning off ${switchId} but it didn't work. Help me figure out why by checking its current state and any relevant logs using ha_get_entity and ha_get_logs.`,
    );

    // Agent should investigate: check entity state AND look at logs
    const hasGetEntity = result.toolCalls.some((t) => t.toolName === "ha_get_entity");
    const hasGetLogs = result.toolCalls.some((t) => t.toolName === "ha_get_logs");
    assert(hasGetEntity || hasGetLogs, `Expected diagnostic investigation. Got: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`);

    // Should NOT blindly call service again without checking first
    // (though the agent might — that's a quality signal, not a hard fail here)
  },
});

Deno.test({
  name: "context — multi-tool problem solving: find and fix a bright room",
  fn: async () => {
    const lights = await S.getLightEntityIds(HA_BASE);
    if (lights.length === 0) throw new Error("No lights found in HA demo");

    // First turn all lights on so there's something to dim
    for (const lightId of lights.slice(0, 2)) {
      await S.setEntityState(HA_BASE, lightId, "on");
    }

    const result = await testRun(
      `The living room is too bright. Check which lights are on and dim them appropriately using ha_get_states and ha_call_service.`,
    );

    // Should use get_states to discover, then call_service to act
    S.assertAtLeastNTotalTools(result, 2);
  },
});

Deno.test({
  name: "context — fallback when entity is unavailable",
  fn: async () => {
    const sensorId = await S.findDemoSensor(HA_BASE);
    if (!sensorId) throw new Error("No sensor found in HA demo");

    // Ask about the sensor's state — should handle gracefully whether available or not
    const result = await testRun(
      `What is the current reading from ${sensorId}?`,
    );

    // ha_get_entity and ha_get_states-with-entity_id return the same data;
    // accept either path.
    S.assertOneOfToolsCalled(
      result,
      ["ha_get_entity", "ha_get_states"],
      (args) => String(args?.entity_id ?? "") === sensorId,
    );
  },
});

Deno.test({
  name: "context — multi-step reasoning with state verification",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    // Ensure off
    await S.setEntityState(HA_BASE, lightId, "off");

    const result = await testRun(
      `Turn on ${lightId}, then verify it actually turned on by checking its state. Tell me the final result.`,
    );

    // Should call service to turn on, then get_entity or get_states to verify
    S.assertAtLeastNTotalTools(result, 2);

    const hasCallService = result.toolCalls.some((t) => t.toolName === "ha_call_service");
    const hasVerification = result.toolCalls.some((t) =>
      t.toolName === "ha_get_entity" || t.toolName === "ha_get_states",
    );
    assert(hasCallService, "Expected ha_call_service to turn on the light");
    assert(hasVerification, "Expected verification tool call (get_entity or get_states)");

    // Final state should be on
    await S.assertEntityState(HA_BASE, lightId, "on");
  },
});
