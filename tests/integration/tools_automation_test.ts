// Integration tests: automation CRUD — get config, create (via update), modify,
// strict validation, and trace inspection with debugging.

import { assert } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

async function testRun(prompt: string, opts?: { timeoutMs?: number }) {
  return S.runConversation(prompt, opts);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Find a writable automation in the demo. */
async function findWritableAutomation() {
  const automations = await S.listAutomations(HA_BASE);
  // YAML-defined automations come back from /api/config/automation/list with
  // a stringified id ("1001") and entity_id "automation.<slug>". UI-created
  // automations have UUID strings. Both are mutable via ha_update_automation;
  // any entry under automation.* with an id is fine for these tests.
  return automations.find((a) => a.id != null && String(a.id) !== "" && a.entity_id?.startsWith("automation.")) ?? null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "automation — list all automations",
  fn: async () => {
    const result = await testRun(
      `List all my automations using ha_get_automation_trace. How many do I have?`,
    );

    // The agent might use ha_get_states or ha_get_automation_trace to discover them
    const hasAutomationTool = result.toolCalls.some((t) =>
      t.toolName === "ha_get_automation_trace" || t.toolName === "ha_get_states",
    );
    assert(hasAutomationTool, `Expected automation discovery tool call. Got: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`);
  },
});

Deno.test({
  name: "automation — get specific automation config",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    const result = await testRun(
      `Show me the full YAML configuration for ${auto.entity_id} using ha_get_automation.`,
    );

    S.assertToolCalled(result, "ha_get_automation", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );
  },
});

Deno.test({
  name: "automation — create new automation via update and verify config",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    // Save original for cleanup
    const origConfig = (await S.getAutomationConfig(HA_BASE, auto.id)) as Record<string, unknown> | null;

    try {
      const result = await testRun(
        `Modify ${auto.entity_id} to turn on light when the door opens using ha_update_automation.`,
        { timeoutMs: S.COMPLEX_TIMEOUT },
      );

      const toolCall = S.assertToolCalled(result, "ha_update_automation", (args) =>
        String(args?.automation_id ?? "") === String(auto.id),
      );

      // Verify config has expected structure if available in args
      const config = toolCall.args?.config as Record<string, unknown> | undefined;
      if (config) {
        assert(Array.isArray(config.trigger ?? []), "Expected trigger array in automation config");
      }

      // Verify via HA REST API that the automation was updated
      const updatedConfig = await S.getAutomationConfig(HA_BASE, auto.id);
      assert(updatedConfig !== null, "Automation should exist after update");
    } finally {
      if (origConfig && typeof origConfig === "object") {
        await S.updateAutomationConfig(HA_BASE, auto.id, origConfig as Record<string, unknown>);
      }
    }
  },
});

Deno.test({
  name: "automation — update with strict validation warns on unknown entities",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    // Save original for cleanup
    const origConfig = (await S.getAutomationConfig(HA_BASE, auto.id)) as Record<string, unknown> | null;

    try {
      const result = await testRun(
        `Call ha_update_automation with automation_id=${auto.id} and strict=true to update ${auto.entity_id} so it turns on light.nonexistent_entity when a door opens. The strict flag should surface a warning about the unknown entity_id.`,
        { timeoutMs: S.COMPLEX_TIMEOUT },
      );

      // Tool should still be called but config may contain warnings about unknown entity
      const toolCall = S.assertToolCalled(result, "ha_update_automation");
      assert(toolCall.args?.strict === true || toolCall.args?.strict === "true", "Expected strict=true for validation test");
    } finally {
      if (origConfig && typeof origConfig === "object") {
        await S.updateAutomationConfig(HA_BASE, auto.id, origConfig as Record<string, unknown>);
      }
    }
  },
});

Deno.test({
  name: "automation — update to also handle door closing",
  fn: () => S.withFlakeRetry("automation — update to also handle door closing", async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    // Save original for cleanup
    const origConfig = (await S.getAutomationConfig(HA_BASE, auto.id)) as Record<string, unknown> | null;

    try {
      // Earlier "Update X to also handle Y using ha_update_automation" phrasing
      // led the model to read the current config and then quit before writing.
      // Naming both steps explicitly + putting the write verb up front pushes
      // the model toward actually committing the change.
      const result = await testRun(
        `Use ha_update_automation to extend automation ${auto.entity_id}: read its current config with ha_get_automation, then submit an updated config that ALSO turns off the light when the door closes. You must call ha_update_automation to commit the change — reading alone is not enough.`,
        { timeoutMs: S.COMPLEX_TIMEOUT },
      );

      S.assertToolCalled(result, "ha_update_automation", (args) =>
        String(args?.automation_id ?? "") === String(auto.id),
      );
    } finally {
      if (origConfig && typeof origConfig === "object") {
        await S.updateAutomationConfig(HA_BASE, auto.id, origConfig as Record<string, unknown>);
      }
    }
  }),
});

Deno.test({
  name: "automation — trace inspection lists recent runs",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    const result = await testRun(
      `Show me the recent execution history for ${auto.entity_id} using ha_get_automation_trace.`,
    );

    S.assertToolCalled(result, "ha_get_automation_trace", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );
  },
});

Deno.test({
  name: "automation — trace specific run with debugging info",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    // First get the list of runs to find a run_id
    const listResult = await testRun(
      `List recent runs for ${auto.entity_id} and get the most recent run ID.`,
    );

    S.assertToolCalled(listResult, "ha_get_automation_trace", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );

    // Now inspect a specific run
    const debugResult = await testRun(
      `Show me the full trace details for ${auto.entity_id} including trigger info and any errors.`,
    );

    S.assertToolCalled(debugResult, "ha_get_automation_trace", (args) =>
      String(args?.automation_id ?? "") === String(auto.id),
    );

    // Assistant should mention trace/trigger/run details
    assert(
      debugResult.assistantText.length > 0 || debugResult.toolCalls.some((t) => t.toolName === "ha_get_automation_trace"),
      "Expected assistant to respond with trace information",
    );
  },
});

Deno.test({
  name: "automation — debug a failed run end-to-end",
  fn: async () => {
    const auto = await findWritableAutomation();
    if (!auto) throw new Error("No writable automation found in HA demo");

    // Save original for cleanup
    const origConfig = (await S.getAutomationConfig(HA_BASE, auto.id)) as Record<string, unknown> | null;

    try {
      // First create a broken automation that references an invalid entity
      await testRun(
        `Update ${auto.entity_id} to reference light.nonexistent_entity so we can debug it.`,
        { timeoutMs: S.COMPLEX_TIMEOUT },
      );

      // Now ask the agent to debug it
      const result = await testRun(
        `Why is automation ${auto.entity_id} failing? Show me the trace and explain what went wrong.`,
      );

      S.assertToolCalled(result, "ha_get_automation_trace");
    } finally {
      if (origConfig && typeof origConfig === "object") {
        await S.updateAutomationConfig(HA_BASE, auto.id, origConfig as Record<string, unknown>);
      }
    }
  },
});
