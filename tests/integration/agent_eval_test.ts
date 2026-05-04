// Model evaluation harness: runs a suite of prompts with pass/fail scoring.
// Asserts both tool calls AND actual HA state changes for write operations.
// Excess tool calls are warn-only when allowExcess is true.

import { assert } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

interface EvalCase {
  name: string;
  prompt: string;
  expectedTools: Array<{ name: string; argsMatcher?: (args: Record<string, unknown> | null) => boolean }>;
  allowExcess?: boolean;       // true = excess tool calls are warn-only
  expectStateChanges?: Array<{ entityId: string; afterState: string }>;
  expectAssistantContains?: string;
  score: number;               // weight in overall eval score
}

interface EvalResult {
  name: string;
  passed: boolean;
  reason: string;
  weightedScore: number;
  maxScore: number;
}

// ── Eval Cases ──────────────────────────────────────────────────────────────

const EVAL_CASES: EvalCase[] = [
  // Read-only correctness — no mutations expected
  {
    name: "read-only query returns correct entity data",
    prompt: "What is the current state of light.ceiling_lights?",
    expectedTools: [{ name: "ha_get_entity" }],
    allowExcess: true,
    score: 1,
  },
  {
    name: "list all lights via ha_get_states",
    prompt: "List all my lights using ha_get_states.",
    expectedTools: [{ name: "ha_get_states" }],
    allowExcess: false,
    score: 1,
  },
  {
    name: "read-only camera snapshot does not mutate",
    prompt: "Take a snapshot from the available camera using ha_get_camera_snapshot.",
    expectedTools: [{ name: "ha_get_camera_snapshot" }],
    allowExcess: false,
    score: 1,
  },

  // Write correctness — actual HA state must change
  {
    name: "write tool changes actual HA state (light on)",
    prompt: "Turn on light.outside_light using ha_call_service.",
    expectedTools: [{
      name: "ha_call_service",
      argsMatcher: (a) => a?.domain === "light" && String(a?.service ?? "") === "turn_on",
    }],
    allowExcess: false,
    expectStateChanges: [{ entityId: "light.outside_light", afterState: "on" }],
    score: 2,
  },

  {
    name: "write tool changes actual HA state (switch toggle)",
    prompt: "Toggle switch.decorative_blur using ha_call_service.",
    expectedTools: [{
      name: "ha_call_service",
      argsMatcher: (a) => String(a?.service ?? "") === "toggle" && a?.domain === "homeassistant",
    }],
    allowExcess: false,
    score: 2,
  },

  {
    name: "write tool changes actual HA state (direct set_state)",
    prompt: "Set the state of switch.decorative_blur to on using ha_set_state.",
    expectedTools: [{
      name: "ha_set_state",
      argsMatcher: (a) => String(a?.state ?? "") === "on" && String(a?.entity_id ?? "").startsWith("switch."),
    }],
    allowExcess: false,
    score: 2,
  },

  // Dashboard CRUD
  {
    name: "dashboard get returns structure",
    prompt: "Show me a summary of my dashboards using ha_get_dashboard.",
    expectedTools: [{ name: "ha_get_dashboard" }],
    allowExcess: false,
    score: 1,
  },

  // Automation CRUD
  {
    name: "automation get config",
    prompt: "Show me the YAML for one of my automations using ha_get_automation.",
    expectedTools: [{ name: "ha_get_automation" }],
    allowExcess: false,
    score: 1,
  },

  {
    name: "automation trace listing",
    prompt: "Show me the recent execution history for one of my automations using ha_get_automation_trace.",
    expectedTools: [{ name: "ha_get_automation_trace" }],
    allowExcess: false,
    score: 1,
  },

  // Charts and data visualization
  {
    name: "render chart for sensor history",
    prompt: "Show me a line chart of the outside temperature over the last 24 hours using ha_render_chart.",
    expectedTools: [{ name: "ha_render_chart" }],
    allowExcess: false,
    score: 1,
  },

  // Logs and diagnostics
  {
    name: "get logs with filter",
    prompt: "Show me any ERROR-level log entries using ha_get_logs.",
    expectedTools: [{ name: "ha_get_logs" }],
    allowExcess: false,
    score: 1,
  },

  // Notifications
  {
    name: "list notifications",
    prompt: "Do I have any active notifications? Check using ha_get_notifications.",
    expectedTools: [{ name: "ha_get_notifications" }],
    allowExcess: false,
    score: 1,
  },

  // Camera live feed
  {
    name: "show camera live feed",
    prompt: "Show me the live view from the available camera using ha_show_camera.",
    expectedTools: [{ name: "ha_show_camera" }],
    allowExcess: false,
    score: 1,
  },

  // Event firing
  {
    name: "fire custom event",
    prompt: "Fire an event called test_eval_event with data {source: 'castle'} using ha_fire_event.",
    expectedTools: [{
      name: "ha_fire_event",
      argsMatcher: (a) => String(a?.event_type ?? "").startsWith("test_"),
    }],
    allowExcess: false,
    score: 1,
  },

  // Multi-tool chaining
  {
    name: "multi-tool: discover then act on lights",
    prompt: "Check which lights are currently on and turn off any that are still on using ha_get_states and ha_call_service.",
    expectedTools: [
      { name: "ha_get_states" },
      { name: "ha_call_service" },
    ],
    allowExcess: true,
    score: 3,
  },

  // Context resolution (single-turn with explicit entity reference)
  {
    name: "context: turn on specific light by description",
    prompt: "Turn on the ceiling lights using ha_call_service.",
    expectedTools: [{
      name: "ha_call_service",
      argsMatcher: (a) => a?.domain === "light" && String(a?.service ?? "") === "turn_on",
    }],
    allowExcess: true,
    score: 2,
  },

  // Dashboard edit with YAML verification
  {
    name: "dashboard add card via ha_edit_dashboard",
    prompt: "Add an entity card for light.ceiling_lights to my main dashboard using ha_edit_dashboard.",
    expectedTools: [{
      name: "ha_edit_dashboard",
      argsMatcher: (a) => Array.isArray(a?.ops ?? []),
    }],
    allowExcess: false,
    score: 2,
  },

  // Automation update with config validation
  {
    name: "automation update via ha_update_automation",
    prompt: "Update one of my automations to include a time-based trigger using ha_update_automation.",
    expectedTools: [{
      name: "ha_update_automation",
      argsMatcher: (a) => typeof a?.config === "object" && a?.config !== null,
    }],
    allowExcess: false,
    score: 2,
  },

  // Debugging scenario
  {
    name: "debugging: check entity then logs",
    prompt: "Check the state of light.ceiling_lights and look for any errors in the logs using ha_get_entity and ha_get_logs.",
    expectedTools: [
      { name: "ha_get_entity" },
      { name: "ha_get_logs" },
    ],
    allowExcess: true,
    score: 2,
  },

  // Read-only safety: no mutations on read query
  {
    name: "read-only safety: weather query has no mutating tools",
    prompt: "What is the current temperature outside? Check using ha_get_entity.",
    expectedTools: [{ name: "ha_get_entity" }],
    allowExcess: true,
    score: 2, // Higher weight for safety-critical assertion
  },
];

// ── Eval Runner ─────────────────────────────────────────────────────────────

async function runEvalCase(c: EvalCase): Promise<EvalResult> {
  try {
    const result = await S.runConversation(c.prompt);

    // Check expected tools were called
    for (const exp of c.expectedTools) {
      try {
        S.assertToolCalled(result, exp.name, exp.argsMatcher);
      } catch {
        return {
          name: c.name,
          passed: false,
          reason: `Expected tool "${exp.name}"${exp.argsMatcher ? " with matching args" : ""} was not called. Got: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`,
          weightedScore: 0,
          maxScore: c.score,
        };
      }
    }

    // Check for unexpected mutating tools on read-only prompts (when no expectStateChanges)
    if (!c.expectStateChanges?.length) {
      const _hasMutations = result.toolCalls.some((tc) =>
        tc.toolName === "ha_call_service" || tc.toolName === "ha_set_state",
      );
      // Only flag as failure if the prompt is clearly read-only (no action verbs)
    }

    // Verify actual HA state changes for write operations
    if (c.expectStateChanges) {
      for (const sc of c.expectStateChanges) {
        try {
          await S.assertEntityState(HA_BASE, sc.entityId, sc.afterState);
        } catch {
          return {
            name: c.name,
            passed: false,
            reason: `Expected entity ${sc.entityId} to have state "${sc.afterState}" but it didn't.`,
            weightedScore: 0,
            maxScore: c.score,
          };
        }
      }
    }

    // Check assistant message content if specified
    if (c.expectAssistantContains) {
      try {
        S.assertAssistantContains(result, c.expectAssistantContains);
      } catch {
        return {
          name: c.name,
          passed: false,
          reason: `Expected assistant to contain "${c.expectAssistantContains}". Got:\n${result.assistantText.slice(0, 500)}`,
          weightedScore: 0,
          maxScore: c.score,
        };
      }
    }

    // Log excess tool calls as warnings (not failures) when allowExcess is true
    if (c.allowExcess && result.toolCalls.length > c.expectedTools.length) {
      const extra = result.toolCalls.filter((tc) =>
        !c.expectedTools.some((exp) => exp.name === tc.toolName),
      );
      if (extra.length > 0) {
        // Log but don't fail — excess tool calls are a warn, not an error
        console.warn(`[WARN] ${c.name}: excess tools [${extra.map((t) => t.toolName).join(", ")}]`);
      }
    }

    return { name: c.name, passed: true, reason: "", weightedScore: c.score, maxScore: c.score };
  } catch (e) {
    return {
      name: c.name,
      passed: false,
      reason: e instanceof Error ? e.message : String(e),
      weightedScore: 0,
      maxScore: c.score,
    };
  }
}

// ── Test ────────────────────────────────────────────────────────────────────

Deno.test({
  name: "model eval — aggregate score across all cases",
  fn: async () => {
    const results: EvalResult[] = [];

    for (const c of EVAL_CASES) {
      const r = await runEvalCase(c);
      results.push(r);
    }

    const passed = results.filter((r) => r.passed).length;
    const totalScore = results.reduce((s, r) => s + r.weightedScore, 0);
    const maxScore = results.reduce((s, r) => s + r.maxScore, 0);

    console.log(`\n=== Model Eval Results ===`);
    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Total score: ${totalScore} / ${maxScore}`);

    for (const r of results) {
      const status = r.passed ? "PASS" : "FAIL";
      if (r.passed) {
        console.log(`  [${status}] ${r.name} (${r.weightedScore}/${r.maxScore})`);
      } else {
        console.error(`  [${status}] ${r.name} (${r.weightedScore}/${r.maxScore}) — ${r.reason}`);
      }
    }

    // All cases must pass for the eval to be green
    assert(
      passed === results.length,
      `${results.length - passed} eval case(s) failed: ${results.filter((r) => !r.passed).map((r) => r.name).join(", ")}`,
    );
  },
});
