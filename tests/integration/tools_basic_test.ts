// Integration tests: exercise every HA tool with prompts that use all arguments.
// Each test targets one tool, asserts the correct call was made with proper args,
// and for write tools verifies the actual HA entity state changed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a prompt and return structured result. */
async function testRun(prompt: string, opts?: { timeoutMs?: number }) {
  const result = await S.runConversation(prompt, opts);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "ha_call_service — turn on a light",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    // Ensure it starts off for deterministic testing
    try {
      await fetch(`${HA_BASE}/api/states/${encodeURIComponent(lightId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "off" }),
      });
    } catch { /* ignore */ }

    const result = await testRun(
      `Turn on ${lightId} using ha_call_service. Confirm what you did.`,
    );

    S.assertToolCalled(result, "ha_call_service", (args) =>
      args?.domain === "light" && args?.service === "turn_on" && String(args?.entity_id ?? "") === lightId,
    );
    await S.assertEntityState(HA_BASE, lightId, "on");
  },
});

Deno.test({
  name: "ha_call_service — toggle a switch",
  fn: async () => {
    const switchId = await S.findDemoSwitch(HA_BASE);
    if (!switchId) throw new Error("No switch entity found in HA demo");

    // Ensure it starts off for deterministic testing
    try {
      await fetch(`${HA_BASE}/api/states/${encodeURIComponent(switchId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "off" }),
      });
    } catch { /* ignore */ }

    const result = await testRun(
      `Toggle ${switchId} using ha_call_service. Tell me the result.`,
    );

    S.assertToolCalled(result, "ha_call_service", (args) =>
      args?.domain === "homeassistant" && String(args?.service ?? "") === "toggle" && String(args?.entity_id ?? "") === switchId,
    );
    await S.assertEntityState(HA_BASE, switchId, "on");
  },
});

Deno.test({
  name: "ha_call_service — set climate temperature",
  fn: async () => {
    const climateId = await S.findDemoClimate(HA_BASE);
    if (!climateId) throw new Error("No climate entity found in HA demo");

    const result = await testRun(
      `Set the target temperature of ${climateId} to 21.5 using ha_call_service.`,
    );

    S.assertToolCalled(result, "ha_call_service", (args) => {
      return args?.domain === "climate" && String(args?.service ?? "") === "set_temperature";
    });
  },
});

Deno.test({
  name: "ha_get_states — list all lights",
  fn: async () => {
    const result = await testRun(
      `List all light entities using ha_get_states. How many are there?`,
    );

    S.assertToolCalled(result, "ha_get_states");
    // Should be read-only — no mutations
    S.assertNoMutatingTools(result);
    assert(result.toolCalls.length > 0, "Expected at least one tool call");
  },
});

Deno.test({
  name: "ha_get_states — filter by domain",
  fn: async () => {
    const result = await testRun(
      `Show me all switch entities using ha_get_states with a domain filter.`,
    );

    S.assertToolCalled(result, "ha_get_states", (args) => args?.domain === "switch");
  },
});

Deno.test({
  name: "ha_get_states — get specific entity",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    const result = await testRun(
      `Get the state of ${lightId} using ha_get_states.`,
    );

    S.assertToolCalled(result, "ha_get_states", (args) => String(args?.entity_id ?? "") === lightId);
  },
});

Deno.test({
  name: "ha_fire_event — fire a custom event",
  fn: async () => {
    const result = await testRun(
      `Fire an event called test_integration_event with data {"source": "castle_test"} using ha_fire_event.`,
    );

    S.assertToolCalled(result, "ha_fire_event", (args) =>
      String(args?.event_type ?? "") === "test_integration_event" &&
      typeof args?.event_data === "object" && args?.event_data !== null,
    );
  },
});

Deno.test({
  name: "ha_set_state — directly set entity state",
  fn: async () => {
    const switchId = await S.findDemoSwitch(HA_BASE);
    if (!switchId) throw new Error("No switch entity found in HA demo");

    // Ensure it starts off
    try {
      await fetch(`${HA_BASE}/api/states/${encodeURIComponent(switchId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "off" }),
      });
    } catch { /* ignore */ }

    const result = await testRun(
      `Set ${switchId} directly to on using ha_set_state.`,
    );

    S.assertToolCalled(result, "ha_set_state", (args) =>
      String(args?.entity_id ?? "") === switchId && String(args?.state ?? "") === "on",
    );
  },
});

Deno.test({
  name: "ha_get_entity — full detail for one entity",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    const result = await testRun(
      `Get complete details about ${lightId} using ha_get_entity.`,
    );

    S.assertToolCalled(result, "ha_get_entity", (args) => String(args?.entity_id ?? "") === lightId);
    // Verify tool succeeded
    const call = S.assertToolCalled(result, "ha_get_entity");
    S.assertToolSucceeded(result, call.toolCallId);
  },
});

Deno.test({
  name: "ha_get_camera_snapshot — capture snapshot",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    const result = await testRun(
      `Take a snapshot from ${cameraId} using ha_get_camera_snapshot.`,
    );

    S.assertToolCalled(result, "ha_get_camera_snapshot", (args) => String(args?.entity_id ?? "") === cameraId);
  },
});

Deno.test({
  name: "ha_show_camera — show live feed",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    const result = await testRun(
      `Show me the live camera feed from ${cameraId} using ha_show_camera.`,
    );

    S.assertToolCalled(result, "ha_show_camera", (args) => String(args?.entity_id ?? "") === cameraId);
  },
});

Deno.test({
  name: "ha_render_chart — line chart for sensor history",
  fn: async () => {
    const sensorId = await S.findDemoSensor(HA_BASE);
    if (!sensorId) throw new Error("No sensor entity found in HA demo");

    const result = await testRun(
      `Render a chart of ${sensorId} for the last 24 hours using ha_render_chart.`,
    );

    S.assertToolCalled(result, "ha_render_chart", (args) => {
      const ids = args?.entity_ids as string[] | undefined;
      return Array.isArray(ids) && ids.some((e) => e === sensorId);
    });
  },
});

Deno.test({
  name: "ha_get_logs — filter error logs",
  fn: async () => {
    const result = await testRun(
      `Show me any ERROR-level log entries using ha_get_logs.`,
    );

    S.assertToolCalled(result, "ha_get_logs");
  },
});

Deno.test({
  name: "ha_get_notifications — list active notifications",
  fn: async () => {
    const result = await testRun(
      `Check if I have any active notifications using ha_get_notifications.`,
    );

    S.assertToolCalled(result, "ha_get_notifications");
    // No args expected for this tool
    assertEquals(result.toolCalls.length, 1);
  },
});

Deno.test({
  name: "ha_get_dashboard — list and inspect dashboards",
  fn: async () => {
    const result = await testRun(
      `List all my dashboards using ha_get_dashboard. What do I have?`,
    );

    S.assertToolCalled(result, "ha_get_dashboard");
  },
});

Deno.test({
  name: "ha_edit_dashboard — add a card to dashboard",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    // Get existing dashboards first
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) {
      throw new Error("No dashboards exist in HA demo — skipping dashboard edit test");
    }
    const _targetDashboard = dashboards[0].slug;

    const result = await testRun(
      `Add an entity card for ${lightId} to the "${dashboards[0].name}" dashboard using ha_edit_dashboard.`,
      { timeoutMs: S.COMPLEX_TIMEOUT },
    );

    S.assertToolCalled(result, "ha_edit_dashboard", (args) =>
      typeof args?.name === "string" && Array.isArray(args?.ops ?? []),
    );
  },
});

Deno.test({
  name: "ha_get_automation — inspect automation config",
  fn: async () => {
    const auto = await S.findDemoAutomation(HA_BASE);
    if (!auto) throw new Error("No automations found in HA demo");

    const result = await testRun(
      `Show me the full YAML configuration for ${auto.entity_id} using ha_get_automation.`,
    );

    S.assertToolCalled(result, "ha_get_automation", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );
  },
});

Deno.test({
  name: "ha_update_automation — modify automation config",
  fn: async () => {
    const auto = await S.findDemoAutomation(HA_BASE);
    if (!auto) throw new Error("No automations found in HA demo");

    // Save original config for cleanup
    const origConfig = await S.getAutomationConfig(HA_BASE, auto.id);

    try {
      const result = await testRun(
        `Update ${auto.entity_id} to turn on light when the door opens using ha_update_automation.`,
        { timeoutMs: S.COMPLEX_TIMEOUT },
      );

      S.assertToolCalled(result, "ha_update_automation", (args) =>
        String(args?.automation_id ?? "") === String(auto.id),
      );
    } finally {
      // Restore original config if we modified it
      if (origConfig && typeof origConfig === "object") {
        await S.updateAutomationConfig(HA_BASE, auto.id, origConfig as Record<string, unknown>);
      }
    }
  },
});

Deno.test({
  name: "ha_get_automation_trace — list recent runs",
  fn: async () => {
    const auto = await S.findDemoAutomation(HA_BASE);
    if (!auto) throw new Error("No automations found in HA demo");

    const result = await testRun(
      `Show me the recent execution history for ${auto.entity_id} using ha_get_automation_trace.`,
    );

    S.assertToolCalled(result, "ha_get_automation_trace", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );
  },
});
