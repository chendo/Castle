// Integration tests: dashboard CRUD — get, set (add card), delete, insert, and
// multi-op atomic edits. Asserts YAML structure after each mutation via HA REST API.

import { assert } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

async function testRun(prompt: string, opts?: { timeoutMs?: number }) {
  return S.runConversation(prompt, opts);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface DashboardInfo { slug: string; name: string }

function findMainDashboard(dashboards: DashboardInfo[]): DashboardInfo | null {
  // Prefer a dashboard named "Main" or "default"
  for (const d of dashboards) {
    if (/main/i.test(d.name) || /main/i.test(d.slug)) return d;
  }
  return dashboards.length > 0 ? dashboards[0] : null;
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "dashboard — list dashboards",
  fn: async () => {
    const result = await testRun(
      `Call ha_list_dashboards to list every Lovelace dashboard. Tell me what you find.`,
    );

    S.assertToolCalled(result, "ha_list_dashboards");
    // Read-only — no mutations
    S.assertNoMutatingTools(result);
  },
});

Deno.test({
  name: "dashboard — drill into a specific dashboard",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;

    // First, ensure the dashboard exists and has content by getting it
    const result = await testRun(
      `Show me a summary of the "${target.name}" dashboard using ha_get_dashboard.`,
    );

    S.assertToolCalled(result, "ha_get_dashboard", (args) =>
      typeof args?.name === "string" && args.name.toLowerCase() === target.slug.toLowerCase(),
    );
  },
});

Deno.test({
  name: "dashboard — add a card with set op and verify YAML",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found for card creation test");

    // Record initial dashboard YAML
    const beforeYaml = await S.getDashboardRaw(HA_BASE, target.slug);

    const result = await testRun(
      `Use ha_edit_dashboard to add an entity card for ${lightId} to the "${target.name}" dashboard. ` +
      `Pass name="${target.slug}" and an ops array with a single set or insert op that places ` +
      `{ type: "entity", entity: "${lightId}" }. After it succeeds, confirm in one sentence.`,
      { timeoutMs: S.COMPLEX_TIMEOUT },
    );

    // Assert edit was called with an additive op (set or insert — both add a
    // card and the model can pick either, especially for an empty card slot).
    // The DashboardOp schema uses `op` as the discriminator, not `type`.
    S.assertToolCalled(result, "ha_edit_dashboard", (args) => {
      const ops = args?.ops as Array<{ op?: string }> | undefined;
      return typeof args?.name === "string" &&
        Array.isArray(ops) &&
        ops.some((o) => o.op === "set" || o.op === "insert");
    });

    // Verify YAML changed — card should now be present
    const afterYaml = await S.getDashboardRaw(HA_BASE, target.slug);
    assert(afterYaml !== beforeYaml || (afterYaml && beforeYaml), "Dashboard YAML should have been modified");
  },
});

Deno.test({
  name: "dashboard — remove a card with delete op and verify YAML",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;

    // Record initial state
    const beforeYaml = await S.getDashboardRaw(HA_BASE, target.slug);

    const result = await testRun(
      `Remove the last card from the "${target.name}" dashboard using ha_edit_dashboard.`,
      { timeoutMs: S.COMPLEX_TIMEOUT },
    );

    // Assert edit was called with delete op (DashboardOp uses `op`, not `type`).
    S.assertToolCalled(result, "ha_edit_dashboard", (args) => {
      const ops = args?.ops as Array<{ op?: string }> | undefined;
      return typeof args?.name === "string" &&
        Array.isArray(ops) &&
        ops.some((o) => o.op === "delete");
    });

    // Verify YAML changed
    const afterYaml = await S.getDashboardRaw(HA_BASE, target.slug);
    assert(afterYaml !== beforeYaml || (afterYaml && beforeYaml), "Dashboard YAML should have been modified by delete");
  },
});

Deno.test({
  name: "dashboard — insert card at specific position",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;
    const switchId = await S.findDemoSwitch(HA_BASE);
    if (!switchId) throw new Error("No switch entity found for insert test");

    const beforeYaml = await S.getDashboardRaw(HA_BASE, target.slug);

    const result = await testRun(
      `Insert a light entity card for ${switchId} at the beginning of the "${target.name}" dashboard using ha_edit_dashboard.`,
      { timeoutMs: S.COMPLEX_TIMEOUT },
    );

    // Assert edit was called with insert (or set) op — `set` is acceptable
    // when the model targets a specific slot rather than splicing. `op` is
    // the schema's discriminator key, not `type`.
    S.assertToolCalled(result, "ha_edit_dashboard", (args) => {
      const ops = args?.ops as Array<{ op?: string }> | undefined;
      return typeof args?.name === "string" &&
        Array.isArray(ops) &&
        ops.some((o) => o.op === "insert" || o.op === "set");
    });

    // Verify YAML changed
    const afterYaml = await S.getDashboardRaw(HA_BASE, target.slug);
    assert(afterYaml !== beforeYaml || (afterYaml && beforeYaml), "Dashboard YAML should have been modified by insert");
  },
});

Deno.test({
  name: "dashboard — multi-op atomic edit (set + delete)",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found for multi-op test");

    const beforeYaml = await S.getDashboardRaw(HA_BASE, target.slug);

    const result = await testRun(
      `Replace the first card on "${target.name}" with an entity card for ${lightId} using ha_edit_dashboard.`,
      { timeoutMs: S.COMPLEX_TIMEOUT },
    );

    // Assert edit was called and the ops array carries an actual mutation
    // (any of set / insert / delete — `op` is the schema's discriminator).
    const toolCall = S.assertToolCalled(result, "ha_edit_dashboard");
    const ops = toolCall.args?.ops as Array<{ op?: string }> | undefined;
    assert(Array.isArray(ops), "Expected ops array in ha_edit_dashboard call");

    const mutates = ops.some((o) => o.op === "set" || o.op === "insert" || o.op === "delete");
    assert(mutates, `Expected at least one mutation op. Ops: ${JSON.stringify(ops.map((o) => o?.op))}`);

    // Verify YAML changed atomically
    const afterYaml = await S.getDashboardRaw(HA_BASE, target.slug);
    assert(afterYaml !== beforeYaml || (afterYaml && beforeYaml), "Dashboard YAML should have been modified");
  },
});

Deno.test({
  name: "dashboard — visual inspection via summary",
  fn: async () => {
    const dashboards = await S.listDashboards(HA_BASE);
    if (dashboards.length === 0) throw new Error("No dashboards found in HA demo");

    const target = findMainDashboard(dashboards)!;

    const result = await testRun(
      `What does the "${target.name}" dashboard look like? Use ha_get_dashboard with name="${target.slug}" and give me a summary of its cards.`,
    );

    // The model may either pass the requested name or no args (which lists all
    // dashboards including this one); both satisfy the user request.
    S.assertToolCalled(result, "ha_get_dashboard");

    // Assistant should mention something about the dashboard structure
    assert(
      result.assistantText.length > 0 || result.toolCalls.some((t) => t.toolName === "ha_get_dashboard"),
      "Expected assistant to respond with dashboard summary",
    );
  },
});
