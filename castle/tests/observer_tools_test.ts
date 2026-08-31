import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildObserverTools,
  OBSERVER_TOOL_NAMES,
  SnapshotBudget,
  type ObserverToolDeps,
} from "../observer-tools.ts";
import { MemoryStore } from "../observer-memory.ts";
import type { ObservationBody } from "../observer-store.ts";
import type { HAState } from "../ha-client.ts";

const T0 = Date.parse("2026-08-31T18:00:00Z");

/** HA stub that throws on anything that would mutate the house. The dry-run
 *  guarantee is the point of this file, so the fake enforces it rather than
 *  trusting the code under test. */
class ExplodingHAClient {
  states = new Map<string, HAState>();
  constructor(entityIds: string[]) {
    for (const id of entityIds) {
      this.states.set(id, {
        entity_id: id,
        state: "on",
        attributes: {},
        last_changed: new Date(T0).toISOString(),
        last_updated: new Date(T0).toISOString(),
      });
    }
  }
  getState(id: string): HAState | undefined {
    return this.states.get(id);
  }
  getAllStates(): HAState[] {
    return [...this.states.values()];
  }
  // deno-lint-ignore require-await
  async getServices(): Promise<Record<string, Record<string, unknown>>> {
    return { light: { turn_on: {}, turn_off: {} }, script: { turn_on: {} } };
  }
  callService(): never {
    throw new Error("callService must never be reachable from the observer");
  }
  restCall(): never {
    throw new Error("restCall must never be reachable from the observer");
  }
  call(): never {
    throw new Error("call must never be reachable from the observer");
  }
}

interface Harness {
  tools: ReturnType<typeof buildObserverTools>;
  emitted: ObservationBody[];
  memory: MemoryStore;
  budget: SnapshotBudget;
  suppress: { value: boolean };
  root: string;
}

async function harness(
  opts: { cameras?: string[]; multimodal?: boolean; entities?: string[]; now?: () => number } = {},
): Promise<Harness> {
  const root = await Deno.makeTempDir();
  const memory = new MemoryStore(root);
  await memory.init();
  const emitted: ObservationBody[] = [];
  const suppress = { value: false };
  const ha = new ExplodingHAClient(opts.entities ?? ["light.porch", "camera.front", "camera.side"]);
  const deps: ObserverToolDeps = {
    // deno-lint-ignore no-explicit-any
    ha: ha as any,
    memory,
    emit: (body) => {
      emitted.push(body);
      return Promise.resolve(suppress.value ? null : "obs_test1");
    },
    cameras: () => opts.cameras ?? [],
    multimodal: opts.multimodal ?? true,
    now: opts.now,
  };
  const budget = new SnapshotBudget(opts.now ?? (() => T0));
  return { tools: buildObserverTools(deps, budget), emitted, memory, budget, suppress, root };
}

// deno-lint-ignore no-explicit-any
function call(tools: any[], name: string, params: unknown): Promise<any> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool named ${name}`);
  return t.execute("call_1", params);
}

// deno-lint-ignore no-explicit-any
function textOf(result: any): string {
  return result.content.map((c: { text?: string }) => c.text ?? "").join("");
}

// --- the dry-run guarantee --------------------------------------------------

Deno.test("toolset is exactly the seven declared names and nothing else", async () => {
  const h = await harness({ multimodal: true });
  try {
    assertEquals(h.tools.map((t) => t.name).sort(), [...OBSERVER_TOOL_NAMES].sort());
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("no write-class Castle tool is reachable from the observer", async () => {
  const h = await harness();
  try {
    const names = new Set(h.tools.map((t) => t.name));
    for (
      const forbidden of [
        "ha_call_service",
        "ha_set_state",
        "ha_fire_event",
        "ha_create_automation",
        "ha_update_automation",
        "ha_edit_dashboard",
        "ha_manage",
        "ha_update_addon",
      ]
    ) {
      assert(!names.has(forbidden), `${forbidden} must not be registered`);
    }
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("perform_action records the intent and never touches HA", async () => {
  // The HA stub throws on callService/restCall/call, so reaching HA fails loudly.
  const h = await harness();
  try {
    const out = await call(h.tools, "perform_action", {
      domain: "light",
      action: "turn_off",
      entity_id: "light.porch",
      reason: "on 4h with nobody home",
    });
    assertStringIncludes(textOf(out), "DRY RUN");
    assertStringIncludes(textOf(out), "Do not retry");
    assertEquals(h.emitted.length, 1);
    const body = h.emitted[0];
    assertEquals(body.type, "proposal");
    // Recorded under the canonical tool + arg shape so live mode can replay it.
    assertEquals(body.type === "proposal" ? body.tool : null, "ha_call_service");
    assertEquals(body.type === "proposal" ? body.args : null, {
      domain: "light",
      service: "turn_off",
      entity_id: "light.porch",
    });
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("perform_action is marked as a shadow so the guarantee is assertable", async () => {
  const h = await harness();
  try {
    const t = h.tools.find((x) => x.name === "perform_action")!;
    assertEquals((t as unknown as { shadow?: boolean }).shadow, true);
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("perform_action refuses an action that could not really be made", async () => {
  const h = await harness();
  try {
    const unknownDomain = await call(h.tools, "perform_action", {
      domain: "nosuch",
      action: "turn_on",
      reason: "r",
    });
    assertStringIncludes(textOf(unknownDomain), "Unknown domain");

    const unknownAction = await call(h.tools, "perform_action", {
      domain: "light",
      action: "explode",
      reason: "r",
    });
    assertStringIncludes(textOf(unknownAction), "Unknown action");

    const unknownEntity = await call(h.tools, "perform_action", {
      domain: "light",
      action: "turn_on",
      entity_id: "light.invented",
      reason: "r",
    });
    assertStringIncludes(textOf(unknownEntity), "No such entity");

    assertEquals(h.emitted.length, 0);
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("perform_action tells the model to move on when already dismissed", async () => {
  const h = await harness();
  try {
    h.suppress.value = true;
    const out = await call(h.tools, "perform_action", {
      domain: "light",
      action: "turn_off",
      entity_id: "light.porch",
      reason: "r",
    });
    assertStringIncludes(textOf(out), "Already dismissed");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

// --- castle_flag ------------------------------------------------------------

Deno.test("castle_flag refuses to cite an entity HA does not have", async () => {
  const h = await harness();
  try {
    const out = await call(h.tools, "castle_flag", {
      severity: "warn",
      summary: "something is wrong",
      entities: ["light.porch", "light.hallucinated"],
    });
    assertStringIncludes(textOf(out), "No such entities: light.hallucinated");
    assertEquals(h.emitted.length, 0, "a finding naming a fake entity must not be created");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("castle_flag records a concern with its severity", async () => {
  const h = await harness();
  try {
    await call(h.tools, "castle_flag", {
      severity: "critical",
      summary: "porch light unavailable",
      entities: ["light.porch"],
    });
    assertEquals(h.emitted[0].type, "concern");
    assertEquals(h.emitted[0].type === "concern" ? h.emitted[0].severity : null, "critical");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

// --- camera gating ----------------------------------------------------------

Deno.test("camera tool is not registered at all on a text-only model", async () => {
  const h = await harness({ multimodal: false, cameras: ["camera.front"] });
  try {
    assert(!h.tools.some((t) => t.name === "get_camera_snapshot"));
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("camera refuses when the user has allowed none — vision is opt-in", async () => {
  const h = await harness({ cameras: [] });
  try {
    const out = await call(h.tools, "get_camera_snapshot", { entity_id: "camera.front" });
    assertStringIncludes(textOf(out), "No cameras are enabled");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("camera refuses one outside the allowlist", async () => {
  const h = await harness({ cameras: ["camera.front"] });
  try {
    const out = await call(h.tools, "get_camera_snapshot", { entity_id: "camera.side" });
    assertStringIncludes(textOf(out), "not one of the cameras enabled");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});

Deno.test("SnapshotBudget — one per pass, and reset re-arms it", () => {
  const b = new SnapshotBudget(() => T0);
  assertEquals(b.check("camera.front", ["camera.front"]), null);
  b.spend("camera.front");
  assertStringIncludes(b.check("camera.front", ["camera.front"])!, "budget for this pass");
  b.reset();
  // Same pass budget is back, but the per-camera cooldown still applies.
  assertStringIncludes(b.check("camera.front", ["camera.front"])!, "already checked recently");
});

Deno.test("SnapshotBudget — the per-camera cooldown expires", () => {
  let now = T0;
  const b = new SnapshotBudget(() => now);
  b.spend("camera.front");
  b.reset();
  now = T0 + 5 * 60_000 + 1;
  assertEquals(b.check("camera.front", ["camera.front"]), null);
});

Deno.test("SnapshotBudget — a cooldown on one camera does not block another", () => {
  const b = new SnapshotBudget(() => T0);
  b.spend("camera.front");
  b.reset();
  assertEquals(b.check("camera.side", ["camera.front", "camera.side"]), null);
});

// --- memory tools -----------------------------------------------------------

Deno.test("castle_remember and castle_forget round-trip through the store", async () => {
  const h = await harness();
  try {
    const saved = await call(h.tools, "castle_remember", {
      note: "Nobody home Tue daytime",
      section: "Household",
    });
    const id = textOf(saved).match(/m_[a-z0-9]+/)![0];
    assertEquals(h.memory.list().length, 1);

    const gone = await call(h.tools, "castle_forget", { id });
    assertStringIncludes(textOf(gone), "Forgot");
    assertEquals(h.memory.list().length, 0);

    const missing = await call(h.tools, "castle_forget", { id: "m_nope" });
    assertStringIncludes(textOf(missing), "No note with id");
  } finally {
    await Deno.remove(h.root, { recursive: true });
  }
});
