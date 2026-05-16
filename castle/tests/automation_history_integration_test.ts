// Integration test for the automation/dashboard history wrappers in tools.ts.
// Uses a hand-rolled FakeHAClient that satisfies just the surface buildTools
// touches — restCall, call, getAllStates, getServices, isExposed, getState.
//
// The fake stores automation/dashboard configs in-memory and serves them via
// restCall/call so the tool wrappers exercise the real recording + read +
// write flow end-to-end without a real HA.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildTools } from "../tools.ts";

class FakeHAClient {
  automations: Record<string, Record<string, unknown>> = {};
  dashboards: Record<string, unknown> = {};
  /** Settable entity universe for validation tests. Default is empty,
   *  which the existing tests rely on (no entity_ids → no warnings). */
  knownEntityIds: string[] = [];
  /** Settable service universe; defaults cover the switch/light cases the
   *  bulk of tests use. Extend per-test for more exotic services. */
  knownServices: Record<string, Record<string, unknown>> = {
    switch: { turn_on: {}, turn_off: {} },
    light: { turn_on: {}, turn_off: {}, toggle: {} },
    persistent_notification: { create: {} },
  };

  async restCall(path: string, init: RequestInit = {}): Promise<Response> {
    const m = /^\/api\/config\/automation\/config\/([^/?#]+)/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (init.method === "POST") {
        const body = typeof init.body === "string" ? init.body : "";
        this.automations[id] = JSON.parse(body);
        return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
      }
      const cfg = this.automations[id];
      if (!cfg) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(cfg), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not stubbed", { status: 404 });
  }

  // deno-lint-ignore no-explicit-any
  async call<T = unknown>(payload: any): Promise<T> {
    if (payload.type === "lovelace/config") {
      const name = payload.url_path === null ? "(default)" : payload.url_path;
      const cfg = this.dashboards[name];
      if (!cfg) throw new Error(`dashboard not found: ${name}`);
      return cfg as T;
    }
    if (payload.type === "lovelace/config/save") {
      const name = payload.url_path === null ? "(default)" : payload.url_path;
      this.dashboards[name] = payload.config;
      return undefined as T;
    }
    throw new Error(`unstubbed call: ${payload.type}`);
  }

  getAllStates(): Array<{ entity_id: string; attributes?: Record<string, unknown> }> {
    return this.knownEntityIds.map((id) => ({ entity_id: id }));
  }
  async getServices(): Promise<Record<string, Record<string, unknown>>> {
    return this.knownServices;
  }
  isExposed(_entityId: string): boolean { return true; }
  getState(_entityId: string): undefined { return undefined; }
}

/**
 * Each test gets its own tempdir and passes it as `historyRoot` to
 * `buildTools`. We can't use `CASTLE_DATA_DIR` for isolation here — paths.ts
 * captures it at module init, before any test runs.
 */
async function withFreshRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "castle-history-int-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

// deno-lint-ignore no-explicit-any
function findTool(tools: ReturnType<typeof buildTools>, name: string): { execute: (...args: any[]) => Promise<any> } {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  // The Tool union has heterogeneous execute() arities (some take AbortSignal,
  // most don't), inflating the inferred type to require the widest arg list.
  // Loosen here so tests call execute(id, params) like a human-readable example.
  // deno-lint-ignore no-explicit-any
  return t as any;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

// deno-lint-ignore no-explicit-any
function makeTools(ha: FakeHAClient, root: string) {
  // Pre-mark the best-practices skill as loaded so the write-class
  // automation/dashboard tools accept calls in isolation tests. The
  // skillGate is exercised separately in the unit suite where we
  // explicitly pass an empty Set.
  const loadedSkills = new Set<string>(["ha_best_practices"]);
  // deno-lint-ignore no-explicit-any
  return buildTools(ha as any, { historyRoot: root, loadedSkills });
}

Deno.test("ha_create_automation — refuses when ha_skill hasn't loaded", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    // Default empty set — no skill loaded.
    // deno-lint-ignore no-explicit-any
    const tools = buildTools(ha as any, { historyRoot: root });
    const create = findTool(tools, "ha_create_automation");
    const out = await create.execute("c1", {
      automation_id: "new-1",
      config: {
        alias: "x",
        trigger: [{ platform: "state", entity_id: "lock.front_door", to: "unlocked" }],
        action: [{ action: "persistent_notification.create" }],
      },
    });
    assertStringIncludes(resultText(out), "load the Home Assistant best-practices skill first");
    // Confirm HA wasn't touched.
    assertEquals(ha.automations["new-1"], undefined);
  }));

Deno.test("ha_edit_dashboard — refuses when ha_skill hasn't loaded", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    // deno-lint-ignore no-explicit-any
    const tools = buildTools(ha as any, { historyRoot: root });
    const edit = findTool(tools, "ha_edit_dashboard");
    const out = await edit.execute("d1", {
      name: "(default)",
      ops: [{ op: "set", path: "title", value: "x" }],
    });
    assertStringIncludes(resultText(out), "load the Home Assistant best-practices skill first");
  }));

Deno.test("ha_create_automation — writes new automation + records v1", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    const tools = makeTools(ha, root);
    const create = findTool(tools, "ha_create_automation");
    const list = findTool(tools, "ha_list_automation_versions");

    const cfg = {
      alias: "Front door notify",
      trigger: [{ platform: "state", entity_id: "lock.front_door", to: "unlocked" }],
      action: [{ action: "persistent_notification.create", data: { message: "Door opened" } }],
    };
    const out = await create.execute("c1", { automation_id: "new-1", config: cfg });
    assertStringIncludes(resultText(out), "Automation new-1 created");
    assertStringIncludes(resultText(out), "Saved as version 1");
    assertEquals(ha.automations["new-1"], cfg);

    const listOut = resultText(await list.execute("c2", { automation_id: "new-1" }));
    assertStringIncludes(listOut, "v1");
  }));

Deno.test("ha_create_automation — refuses when id already exists", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["existing"] = { alias: "Already here", trigger: [], action: [] };
    const tools = makeTools(ha, root);
    const create = findTool(tools, "ha_create_automation");

    const out = await create.execute("c1", {
      automation_id: "existing",
      config: {
        alias: "Different",
        trigger: [{ platform: "time", at: "08:00" }],
        action: [{ action: "light.turn_on", target: { entity_id: "light.bed_light" } }],
      },
    });
    assertStringIncludes(resultText(out), "already exists");
    // HA's stored config is unchanged.
    assertEquals((ha.automations["existing"] as { alias: string }).alias, "Already here");
  }));

Deno.test("ha_create_automation — auto-generates id when omitted", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    const tools = makeTools(ha, root);
    const create = findTool(tools, "ha_create_automation");

    const out = await create.execute("c1", {
      config: {
        alias: "Generated id",
        trigger: [{ platform: "time", at: "09:00" }],
        action: [{ action: "switch.turn_on", target: { entity_id: "switch.ac" } }],
      },
    });
    assertStringIncludes(resultText(out), "created");
    // Exactly one automation, with a generated id (millisecond timestamp).
    const ids = Object.keys(ha.automations);
    assertEquals(ids.length, 1);
    assert(/^\d+$/.test(ids[0]), `expected numeric generated id, got ${ids[0]}`);
  }));

Deno.test("ha_create_automation — refuses when required fields missing", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    const tools = makeTools(ha, root);
    const create = findTool(tools, "ha_create_automation");

    // No trigger.
    const out = await create.execute("c1", {
      automation_id: "missing-trigger",
      config: { alias: "X", action: [{ action: "light.turn_on" }] },
    });
    assertStringIncludes(resultText(out), "Missing required fields");
    assertStringIncludes(resultText(out), "trigger");
    assertEquals(ha.automations["missing-trigger"], undefined);
  }));

Deno.test("ha_update_automation — first edit records baseline + new version", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-A"] = { alias: "Before", trigger: [{ platform: "time", at: "07:00" }], action: [] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const list = findTool(tools, "ha_list_automation_versions");

    const out = await update.execute("call-1", {
      automation_id: "auto-A",
      config: { alias: "After", trigger: [{ platform: "time", at: "08:00" }], action: [] },
    });
    assertStringIncludes(resultText(out), "Automation auto-A updated");
    assertStringIncludes(resultText(out), "Saved as version 2");

    // History should now have v1 = baseline, v2 = new config.
    const listOut = resultText(await list.execute("call-2", { automation_id: "auto-A" }));
    assertStringIncludes(listOut, "v1");
    assertStringIncludes(listOut, "v2");
    // Newest-first ordering — v2 appears before v1 in the body.
    assert(listOut.indexOf("v2") < listOut.indexOf("v1"));
  }));

Deno.test("ha_update_automation — subsequent edits don't re-capture baseline", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-B"] = { alias: "v0", trigger: [], action: [] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const list = findTool(tools, "ha_list_automation_versions");

    await update.execute("c1", { automation_id: "auto-B", config: { alias: "v1", trigger: [], action: [] } });
    await update.execute("c2", { automation_id: "auto-B", config: { alias: "v2", trigger: [], action: [] } });
    await update.execute("c3", { automation_id: "auto-B", config: { alias: "v3", trigger: [], action: [] } });

    // Captured: baseline (v1) + three edits (v2, v3, v4) = 4 entries.
    const listOut = resultText(await list.execute("c4", { automation_id: "auto-B" }));
    for (const v of ["v1", "v2", "v3", "v4"]) assertStringIncludes(listOut, v);
  }));

Deno.test("ha_diff_automation_versions — shows what changed between two versions", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-C"] = { alias: "First", action: ["a"] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const diff = findTool(tools, "ha_diff_automation_versions");

    await update.execute("c1", { automation_id: "auto-C", config: { alias: "Second", action: ["b"] } });

    const out = resultText(await diff.execute("c2", { automation_id: "auto-C", from: 1, to: 2 }));
    assertStringIncludes(out, `-  "alias": "First"`);
    assertStringIncludes(out, `+  "alias": "Second"`);
  }));

Deno.test("ha_rollback_automation — writes target config back to HA + records rollback", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-D"] = { alias: "Original", action: ["orig"] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const rollback = findTool(tools, "ha_rollback_automation");
    const list = findTool(tools, "ha_list_automation_versions");

    // Two edits: v1 = baseline, v2 = first edit, v3 = second edit.
    await update.execute("c1", { automation_id: "auto-D", config: { alias: "First edit", action: ["a"] } });
    await update.execute("c2", { automation_id: "auto-D", config: { alias: "Second edit", action: ["b"] } });
    assertEquals(ha.automations["auto-D"], { alias: "Second edit", action: ["b"] });

    const out = resultText(await rollback.execute("c3", { automation_id: "auto-D", version: 1 }));
    assertStringIncludes(out, "Rolled back automation auto-D to v1");

    // HA now holds the original config again.
    assertEquals(ha.automations["auto-D"], { alias: "Original", action: ["orig"] });

    // History grew by a rollback entry with parent_version = 1.
    const listOut = resultText(await list.execute("c4", { automation_id: "auto-D" }));
    assertStringIncludes(listOut, "rollback");
    assertStringIncludes(listOut, "←v1");
    for (const v of ["v1", "v2", "v3", "v4"]) assertStringIncludes(listOut, v);
  }));

Deno.test("ha_rollback_automation — dry_run shows diff without writing", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-E"] = { alias: "Baseline" };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const rollback = findTool(tools, "ha_rollback_automation");

    await update.execute("c1", { automation_id: "auto-E", config: { alias: "Edited" } });
    assertEquals(ha.automations["auto-E"], { alias: "Edited" });

    const out = resultText(await rollback.execute("c2", { automation_id: "auto-E", version: 1, dry_run: true }));
    assertStringIncludes(out, "Dry run");
    // HA must NOT have been written to.
    assertEquals(ha.automations["auto-E"], { alias: "Edited" });
  }));

Deno.test("ha_rollback_automation — refuses rolling back to current latest", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-F"] = { alias: "Only" };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const rollback = findTool(tools, "ha_rollback_automation");
    const list = findTool(tools, "ha_list_automation_versions");

    await update.execute("c1", { automation_id: "auto-F", config: { alias: "Edited" } });
    const listOut = resultText(await list.execute("c2", { automation_id: "auto-F" }));
    const latest = Number(/v(\d+)/.exec(listOut)?.[1]);
    const out = resultText(await rollback.execute("c3", { automation_id: "auto-F", version: latest }));
    assertStringIncludes(out, "already at v" + latest);
  }));

Deno.test("ha_edit_dashboard — records baseline + new version", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.dashboards["test-dash"] = { title: "Old", views: [{ title: "v", cards: [{ type: "entity" }] }] };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");
    const list = findTool(tools, "ha_list_dashboard_versions");

    const out = await edit.execute("c1", {
      name: "test-dash",
      ops: [{ op: "set", path: "title", value: "New" }],
    });
    assertStringIncludes(resultText(out), `Dashboard "test-dash" updated`);
    assertStringIncludes(resultText(out), "Saved as version 2");
    assertEquals((ha.dashboards["test-dash"] as { title: string }).title, "New");

    const listOut = resultText(await list.execute("c2", { name: "test-dash" }));
    assertStringIncludes(listOut, "v1");
    assertStringIncludes(listOut, "v2");
  }));

Deno.test("ha_rollback_dashboard — restores prior version via lovelace/config/save", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.dashboards["d2"] = { title: "Original", views: [{ title: "v", cards: [] }] };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");
    const rollback = findTool(tools, "ha_rollback_dashboard");

    await edit.execute("c1", { name: "d2", ops: [{ op: "set", path: "title", value: "Edited" }] });
    assertEquals((ha.dashboards["d2"] as { title: string }).title, "Edited");

    const out = resultText(await rollback.execute("c2", { name: "d2", version: 1 }));
    assertStringIncludes(out, `Rolled back dashboard "d2" to v1`);
    assertEquals((ha.dashboards["d2"] as { title: string }).title, "Original");
  }));

// ── Automation: complex scenarios ─────────────────────────────────────────────

Deno.test("ha_update_automation — strict=true refuses on unknown entity; HA untouched", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["light.kitchen"]; // light.bedroom is intentionally unknown
    const baseline = {
      alias: "Baseline",
      trigger: [{ platform: "time", at: "06:00" }],
      action: [{ action: "light.turn_on", target: { entity_id: "light.kitchen" } }],
    };
    ha.automations["auto-strict"] = { ...baseline };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");

    const out = await update.execute("c1", {
      automation_id: "auto-strict",
      strict: true,
      config: {
        alias: "Should refuse",
        trigger: [{ platform: "time", at: "07:00" }],
        action: [{ action: "light.turn_on", target: { entity_id: "light.bedroom" } }],
      },
    });
    assertStringIncludes(resultText(out), "Refused (strict mode)");
    assertStringIncludes(resultText(out), "light.bedroom");
    // HA still holds the original config — strict refusal is atomic.
    assertEquals((ha.automations["auto-strict"] as { alias: string }).alias, "Baseline");
  }));

Deno.test("ha_update_automation — non-strict surfaces validation warnings but writes", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["light.kitchen"];
    ha.automations["auto-warn"] = { alias: "v0", trigger: [], action: [] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");

    const out = await update.execute("c1", {
      automation_id: "auto-warn",
      config: {
        alias: "warns",
        trigger: [{ platform: "time", at: "08:00" }],
        action: [{ action: "light.turn_on", target: { entity_id: "light.bedroom" } }],
      },
    });
    const text = resultText(out);
    assertStringIncludes(text, "updated");
    assertStringIncludes(text, "warning(s) (saved anyway, strict=false)");
    assertStringIncludes(text, "light.bedroom");
    // Write still landed.
    assertEquals((ha.automations["auto-warn"] as { alias: string }).alias, "warns");
  }));

Deno.test("ha_update_automation — preserves nested choose/sequence through baseline + diff", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["binary_sensor.front_door", "light.hallway", "light.porch"];
    const nestedConfig = {
      alias: "Front door logic",
      mode: "restart",
      trigger: [{ platform: "state", entity_id: "binary_sensor.front_door", to: "on" }],
      action: [{
        choose: [{
          conditions: [{ condition: "state", entity_id: "binary_sensor.front_door", state: "on" }],
          sequence: [
            { action: "light.turn_on", target: { entity_id: "light.hallway" } },
            { action: "light.turn_on", target: { entity_id: "light.porch" } },
          ],
        }],
        default: [{ action: "light.turn_off", target: { entity_id: "light.hallway" } }],
      }],
    };
    ha.automations["auto-nested"] = { alias: "stub" };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const diff = findTool(tools, "ha_diff_automation_versions");

    await update.execute("c1", { automation_id: "auto-nested", config: nestedConfig });

    // Round-trip: HA holds exactly what we sent (no normalization in the tool layer).
    assertEquals(ha.automations["auto-nested"], nestedConfig);

    // Diff v1 (baseline `stub`) vs v2 (nested config) should surface the
    // structural additions: choose, sequence, default branches.
    const diffOut = resultText(await diff.execute("c2", { automation_id: "auto-nested", from: 1, to: 2 }));
    assertStringIncludes(diffOut, "choose");
    assertStringIncludes(diffOut, "sequence");
    assertStringIncludes(diffOut, "default");
    assertStringIncludes(diffOut, "light.hallway");
  }));

Deno.test("ha_diff_automation_versions — surfaces action array growth (+/- lines)", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["light.a", "light.b"];
    ha.automations["auto-grow"] = {
      alias: "G",
      trigger: [{ platform: "time", at: "09:00" }],
      action: [{ action: "light.turn_on", target: { entity_id: "light.a" } }],
    };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const diff = findTool(tools, "ha_diff_automation_versions");

    await update.execute("c1", {
      automation_id: "auto-grow",
      config: {
        alias: "G",
        trigger: [{ platform: "time", at: "09:00" }],
        action: [
          { action: "light.turn_on", target: { entity_id: "light.a" } },
          { action: "light.turn_on", target: { entity_id: "light.b" } },
        ],
      },
    });

    const out = resultText(await diff.execute("c2", { automation_id: "auto-grow", from: 1, to: 2 }));
    // The added action line shows up as a `+`-prefixed entry mentioning light.b.
    assert(/^\+.*light\.b/m.test(out), `Expected '+ ... light.b' line in diff; got:\n${out}`);
  }));

Deno.test("ha_rollback_automation — restores complex structure (mode + nested actions)", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["light.x", "light.y"];
    const baseline = {
      alias: "Complex baseline",
      mode: "restart",
      trigger: [{ platform: "time", at: "06:00" }],
      condition: [{ condition: "state", entity_id: "light.x", state: "off" }],
      action: [
        { action: "light.turn_on", target: { entity_id: "light.x" } },
        { action: "light.turn_on", target: { entity_id: "light.y" } },
      ],
    };
    ha.automations["auto-complex"] = { ...baseline };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const rollback = findTool(tools, "ha_rollback_automation");

    // Mutate to a much simpler config.
    await update.execute("c1", {
      automation_id: "auto-complex",
      config: { alias: "Stripped", trigger: [{ platform: "time", at: "07:00" }], action: [] },
    });
    assertEquals((ha.automations["auto-complex"] as { alias: string }).alias, "Stripped");

    // Roll back to the baseline (v1) — confirm every field comes back, not
    // just the top-level alias.
    await rollback.execute("c2", { automation_id: "auto-complex", version: 1 });
    assertEquals(ha.automations["auto-complex"], baseline);
  }));

Deno.test("ha_rollback_automation — rolls back to a mid-history version", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.automations["auto-mid"] = { alias: "v0", trigger: [], action: [] };
    const tools = makeTools(ha, root);
    const update = findTool(tools, "ha_update_automation");
    const rollback = findTool(tools, "ha_rollback_automation");

    // Three edits — history grows to v1=baseline, v2, v3, v4.
    await update.execute("c1", { automation_id: "auto-mid", config: { alias: "v2", trigger: [], action: [] } });
    await update.execute("c2", { automation_id: "auto-mid", config: { alias: "v3", trigger: [], action: [] } });
    await update.execute("c3", { automation_id: "auto-mid", config: { alias: "v4", trigger: [], action: [] } });
    assertEquals((ha.automations["auto-mid"] as { alias: string }).alias, "v4");

    // Roll back to v3 specifically — not the latest, not the baseline.
    const out = resultText(await rollback.execute("c4", { automation_id: "auto-mid", version: 3 }));
    assertStringIncludes(out, "Rolled back automation auto-mid to v3");
    assertEquals((ha.automations["auto-mid"] as { alias: string }).alias, "v3");
  }));

// ── Dashboard: complex scenarios ──────────────────────────────────────────────

Deno.test("ha_edit_dashboard — atomic: one bad op aborts the whole batch", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    const original = {
      title: "Original",
      views: [{ title: "v1", cards: [{ type: "entity", entity: "light.a" }] }],
    };
    ha.dashboards["d-atom"] = { ...original };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");

    const out = await edit.execute("c1", {
      name: "d-atom",
      ops: [
        // Valid: rename the title.
        { op: "set", path: "title", value: "Renamed" },
        // Invalid: path doesn't resolve. applyDashboardOps should collect this
        // as an error and the tool should refuse the whole batch.
        { op: "set", path: "views.5.title", value: "Nope" },
      ],
    });
    assertStringIncludes(resultText(out), "Refused");
    // HA still has the original; no partial application.
    assertEquals((ha.dashboards["d-atom"] as { title: string }).title, "Original");
  }));

Deno.test("ha_edit_dashboard — multi-op chain applies in declared order", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.dashboards["d-chain"] = {
      title: "Chain",
      views: [{ title: "v", cards: [{ type: "entity", entity: "light.first" }] }],
    };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");

    // Three ops, order matters:
    //   1. insert a card AT the end
    //   2. set the view title
    //   3. delete the first card (which was light.first)
    await edit.execute("c1", {
      name: "d-chain",
      ops: [
        { op: "insert", path: "views.0.cards", value: { type: "entity", entity: "light.second" } },
        { op: "set", path: "views.0.title", value: "Renamed" },
        { op: "delete", path: "views.0.cards.0" },
      ],
    });

    // Final state: title renamed, only the inserted card remains.
    // deno-lint-ignore no-explicit-any
    const final = ha.dashboards["d-chain"] as any;
    assertEquals(final.views[0].title, "Renamed");
    assertEquals(final.views[0].cards.length, 1);
    assertEquals(final.views[0].cards[0].entity, "light.second");
  }));

Deno.test("ha_edit_dashboard — refuses post-edit config with no views", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.dashboards["d-blank"] = {
      title: "Blank-prone",
      views: [{ title: "v", cards: [] }],
    };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");

    const out = await edit.execute("c1", {
      name: "d-blank",
      ops: [{ op: "delete", path: "views.0" }],
    });
    assertStringIncludes(resultText(out), "Refused");
    assertStringIncludes(resultText(out), "no views");
    // HA still has its view.
    // deno-lint-ignore no-explicit-any
    const cfg = ha.dashboards["d-blank"] as any;
    assertEquals(cfg.views.length, 1);
  }));

Deno.test("ha_edit_dashboard — surfaces validation warning for unknown entity in card tap_action", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.knownEntityIds = ["light.real"];
    ha.dashboards["d-warn"] = {
      title: "WarnDash",
      views: [{ title: "v", cards: [{ type: "entity", entity: "light.real" }] }],
    };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");

    // Most card types use the `entity` / `entities` key (which the shared
    // automation validator doesn't match — it looks for `entity_id`). The
    // tap_action service-call path DOES use `target.entity_id`, so unknowns
    // there surface as warnings — the realistic path for catching typos.
    const out = await edit.execute("c1", {
      name: "d-warn",
      ops: [{
        op: "insert",
        path: "views.0.cards",
        value: {
          type: "button",
          name: "Ghost button",
          tap_action: {
            action: "call-service",
            service: "light.turn_on",
            target: { entity_id: "light.ghost" },
          },
        },
      }],
    });
    const text = resultText(out);
    assertStringIncludes(text, "updated");
    assertStringIncludes(text, "validation warning(s):");
    assertStringIncludes(text, "light.ghost");
    // Edit still landed despite the warning (non-strict for dashboards).
    // deno-lint-ignore no-explicit-any
    const cfg = ha.dashboards["d-warn"] as any;
    assertEquals(cfg.views[0].cards.length, 2);
  }));

Deno.test("ha_diff_dashboard_versions — surfaces card additions and removals", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    ha.dashboards["d-diff"] = {
      title: "Diff",
      views: [{ title: "v", cards: [{ type: "entity", entity: "light.a" }] }],
    };
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");
    const diff = findTool(tools, "ha_diff_dashboard_versions");

    await edit.execute("c1", {
      name: "d-diff",
      ops: [{
        op: "insert",
        path: "views.0.cards",
        value: { type: "entity", entity: "light.b" },
      }],
    });

    const out = resultText(await diff.execute("c2", { name: "d-diff", from: 1, to: 2 }));
    // The inserted card surfaces as a `+` line mentioning light.b.
    assert(/^\+.*light\.b/m.test(out), `Expected '+ ... light.b' line in diff; got:\n${out}`);
  }));

Deno.test("ha_rollback_dashboard — restores multi-view structure exactly", () =>
  withFreshRoot(async (root) => {
    const ha = new FakeHAClient();
    const baseline = {
      title: "MultiView",
      views: [
        { title: "Overview", cards: [{ type: "entity", entity: "light.a" }, { type: "weather-forecast", entity: "weather.home" }] },
        { title: "Bedroom", cards: [{ type: "light", entity: "light.bed" }] },
      ],
    };
    ha.dashboards["d-multi"] = JSON.parse(JSON.stringify(baseline));
    const tools = makeTools(ha, root);
    const edit = findTool(tools, "ha_edit_dashboard");
    const rollback = findTool(tools, "ha_rollback_dashboard");

    // Mutate aggressively: delete the second view + rename the first.
    await edit.execute("c1", {
      name: "d-multi",
      ops: [
        { op: "delete", path: "views.1" },
        { op: "set", path: "views.0.title", value: "Renamed" },
      ],
    });
    // deno-lint-ignore no-explicit-any
    const afterEdit = ha.dashboards["d-multi"] as any;
    assertEquals(afterEdit.views.length, 1);
    assertEquals(afterEdit.views[0].title, "Renamed");

    // Roll back to v1.
    await rollback.execute("c2", { name: "d-multi", version: 1 });
    // Full structure restored — second view back, first title back.
    assertEquals(ha.dashboards["d-multi"], baseline);
  }));
