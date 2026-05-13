import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { diffConfigs, ResourceHistoryStore } from "../resource-history.ts";

async function tempRoot(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "castle-history-test-" });
}

Deno.test("record — first append creates the file and assigns version 1", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const rec = await store.record("auto-1", {
      config: { alias: "Test", trigger: [] },
      source: "castle",
    });
    assertEquals(rec.version, 1);
    assertEquals(rec.source, "castle");
    assertEquals(rec.kind, "automation");
    assertEquals(rec.id, "auto-1");
    assertStringIncludes(rec.hash, "sha256:");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — versions increment monotonically per id", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const a = await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    const b = await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    const c = await store.record("auto-1", { config: { v: 3 }, source: "castle" });
    assertEquals(a.version, 1);
    assertEquals(b.version, 2);
    assertEquals(c.version, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — distinct ids get independent version counters", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const a1 = await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    const b1 = await store.record("auto-2", { config: { v: 1 }, source: "castle" });
    const a2 = await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    assertEquals(a1.version, 1);
    assertEquals(b1.version, 1);
    assertEquals(a2.version, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — hash is stable across object key reorderings", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const a = await store.record("auto-1", {
      config: { alias: "A", trigger: { platform: "time", at: "08:00" } },
      source: "castle",
    });
    const b = await store.record("auto-1", {
      // Same config, keys reordered.
      config: { trigger: { at: "08:00", platform: "time" }, alias: "A" },
      source: "castle",
    });
    assertEquals(a.hash, b.hash);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — different configs produce different hashes", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const a = await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    const b = await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    assertNotEquals(a.hash, b.hash);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — concurrent appends to same id don't collide on version", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.record("auto-1", { config: { v: i }, source: "castle" }),
    );
    const results = await Promise.all(writes);
    const versions = results.map((r) => r.version).sort((a, b) => a - b);
    assertEquals(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The persisted file should reflect all 10 records (per-id lock prevents
    // any from being lost).
    const list = await store.list("auto-1");
    assertEquals(list.length, 10);
    assertEquals(list.map((m) => m.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("list — omits the config body but keeps version + metadata", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    await store.record("auto-1", {
      alias_at_save: "Morning lights",
      config: { alias: "Morning lights", trigger: [{ platform: "time", at: "08:00" }] },
      source: "castle",
    });
    const list = await store.list("auto-1");
    assertEquals(list.length, 1);
    assertEquals(list[0].alias_at_save, "Morning lights");
    // No `config` field on metadata.
    assert(!("config" in list[0]), "list() must not include config body");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("list — unknown id returns empty array, not throw", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    assertEquals(await store.list("never-saved"), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("get — returns full record with config body", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    const r2 = await store.get("auto-1", 2);
    assert(r2);
    assertEquals(r2.version, 2);
    assertEquals(r2.config, { v: 2 });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("get — missing version returns null", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    assertEquals(await store.get("auto-1", 99), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retention — caps file at maxVersions, drops oldest", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 3, root);
    for (let i = 0; i < 5; i++) {
      await store.record("auto-1", { config: { v: i }, source: "castle" });
    }
    const list = await store.list("auto-1");
    assertEquals(list.length, 3);
    // After 5 records with cap=3, versions 3/4/5 survive — version counter
    // does NOT reset, so we preserve the linear history.
    assertEquals(list.map((m) => m.version), [3, 4, 5]);
    // Body of the oldest surviving version is intact.
    const r3 = await store.get("auto-1", 3);
    assertEquals(r3?.config, { v: 2 });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retention — version counter keeps growing after a trim", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 2, root);
    await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    await store.record("auto-1", { config: { v: 3 }, source: "castle" }); // trims v1
    const r4 = await store.record("auto-1", { config: { v: 4 }, source: "castle" });
    assertEquals(r4.version, 4, "version must monotonically grow past trims");
    const list = await store.list("auto-1");
    assertEquals(list.map((m) => m.version), [3, 4]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("record — rollback source carries parent_version", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    const r = await store.record("auto-1", {
      config: { v: 1 },
      source: "rollback",
      parent_version: 1,
    });
    assertEquals(r.source, "rollback");
    assertEquals(r.parent_version, 1);
    // List preserves parent_version on the meta entry.
    const list = await store.list("auto-1");
    assertEquals(list[2].parent_version, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ids with slashes/special characters are stored safely", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("dashboard", 50, root);
    // Dashboard url_paths can include slashes in theory; ours must not break.
    const tricky = "lovelace/sub view";
    await store.record(tricky, { config: { title: "X" }, source: "castle" });
    const list = await store.list(tricky);
    assertEquals(list.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("lastHash — returns most recent hash, or null when empty", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    assertEquals(await store.lastHash("auto-1"), null);
    const rec = await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    assertEquals(await store.lastHash("auto-1"), rec.hash);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hashOf — matches the hash record() persists for the same config", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    const cfg = { alias: "X", trigger: { platform: "time", at: "08:00" } };
    const want = await ResourceHistoryStore.hashOf(cfg);
    const rec = await store.record("auto-1", { config: cfg, source: "castle" });
    assertEquals(rec.hash, want);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAll — skips a corrupt line but recovers the others", async () => {
  const root = await tempRoot();
  try {
    const store = new ResourceHistoryStore("automation", 50, root);
    await store.record("auto-1", { config: { v: 1 }, source: "castle" });
    // Simulate a mid-write crash by injecting garbage between two good lines.
    const file = `${root}/automation/${encodeURIComponent("auto-1")}.jsonl`;
    await Deno.writeTextFile(file, "GARBAGE NOT JSON\n", { append: true });
    await store.record("auto-1", { config: { v: 2 }, source: "castle" });
    const list = await store.list("auto-1");
    assertEquals(list.length, 2);
    assertEquals(list.map((m) => m.version), [1, 2]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("diffConfigs — identical configs produce a context-only diff", () => {
  const out = diffConfigs({ a: 1 }, { a: 1 });
  // Every line prefixed with a leading space (context only).
  for (const line of out.split("\n")) assertStringIncludes(line.slice(0, 1), " ");
});

Deno.test("diffConfigs — additions show as + lines, removals as -", () => {
  const out = diffConfigs({ a: 1 }, { a: 1, b: 2 });
  assertStringIncludes(out, "+");
  assert(out.split("\n").some((l) => l.startsWith("+")), "should have a + line");
});

Deno.test("diffConfigs — order changes within arrays show as both - and +", () => {
  const out = diffConfigs([1, 2, 3], [3, 2, 1]);
  assert(out.includes("+") && out.includes("-"), "swap should mark both sides");
});
