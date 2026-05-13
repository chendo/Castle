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
    return [];
  }
  async getServices(): Promise<Record<string, Record<string, unknown>>> {
    return { switch: { turn_on: {}, turn_off: {} } };
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
  // deno-lint-ignore no-explicit-any
  return buildTools(ha as any, { historyRoot: root });
}

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
