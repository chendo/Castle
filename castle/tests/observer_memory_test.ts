import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { MemoryStore, parseMemory, renderMemory } from "../observer-memory.ts";

async function withStore(fn: (store: MemoryStore, root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const store = new MemoryStore(root);
    await store.init();
    await fn(store, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("parseMemory — reads ids and section headings", () => {
  const notes = parseMemory(`## Household
- [m_a3f] Nobody home Tue/Thu daytime
- [m_b81] Garage sensor is known-flaky

## Preferences learned
- [m_c02] Hallway light overnight is intentional
`);
  assertEquals(notes.length, 3);
  assertEquals(notes[0], { id: "m_a3f", section: "Household", text: "Nobody home Tue/Thu daytime" });
  assertEquals(notes[2].section, "Preferences learned");
});

Deno.test("parseMemory — a hand-written bullet without an id still counts", () => {
  const notes = parseMemory("## Household\n- the cat opens the back door\n");
  assertEquals(notes.length, 1);
  assertMatch(notes[0].id, /^m_[a-z0-9]+$/);
  assertEquals(notes[0].text, "the cat opens the back door");
});

Deno.test("parseMemory — prose and blank lines are skipped, not treated as notes", () => {
  const notes = parseMemory("Some preamble\n\n## Household\n\n- real note\n\nmore prose\n");
  assertEquals(notes.length, 1);
  assertEquals(notes[0].text, "real note");
});

Deno.test("parseMemory — notes before any heading land in a default section", () => {
  const notes = parseMemory("- orphan note\n");
  assertEquals(notes[0].section, "Notes");
});

Deno.test("renderMemory — groups by section and round-trips", () => {
  const notes = parseMemory("## A\n- [m_1] one\n## B\n- [m_2] two\n");
  const text = renderMemory(notes);
  assertEquals(parseMemory(text), notes);
});

Deno.test("renderMemory — empty notes render to nothing", () => {
  assertEquals(renderMemory([]), "");
});

Deno.test("remember — persists and survives a reload", async () => {
  await withStore(async (store, root) => {
    await store.remember("Nobody home Tue daytime", "Household");
    const reopened = new MemoryStore(root);
    await reopened.init();
    assertEquals(reopened.list().length, 1);
    assertEquals(reopened.list()[0].text, "Nobody home Tue daytime");
    assertEquals(reopened.list()[0].section, "Household");
  });
});

Deno.test("forget — removes by id and reports whether it matched", async () => {
  await withStore(async (store) => {
    const note = await store.remember("temporary");
    assertEquals(await store.forget(note.id), true);
    assertEquals(store.list().length, 0);
    assertEquals(await store.forget(note.id), false);
    assertEquals(await store.forget("m_nonexistent"), false);
  });
});

Deno.test("init — assigns ids to hand-edited lines and writes them back", async () => {
  await withStore(async (_store, root) => {
    // The user opened MEMORY.md and typed a bullet by hand.
    await Deno.writeTextFile(`${root}/MEMORY.md`, "## Household\n- the cat opens the back door\n");
    const store = new MemoryStore(root);
    await store.init();
    const id = store.list()[0].id;
    // The id has to be on disk too, or castle_forget could not name it.
    const onDisk = await Deno.readTextFile(`${root}/MEMORY.md`);
    assertStringIncludes(onDisk, `[${id}]`);
    assertEquals(await store.forget(id), true);
  });
});

Deno.test("init — a missing file is a normal empty start", async () => {
  const root = await Deno.makeTempDir();
  try {
    const store = new MemoryStore(root);
    await store.init();
    assertEquals(store.list().length, 0);
    assertEquals(store.render(), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("remember — the cap bounds prompt cost by dropping oldest", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 45; i++) await store.remember(`note ${i}`);
    assertEquals(store.list().length, 40);
    assertEquals(store.list()[0].text, "note 5");
    assertEquals(store.list().at(-1)?.text, "note 44");
  });
});

Deno.test("render — null when empty so the prompt can omit the whole section", async () => {
  await withStore(async (store) => {
    assertEquals(store.render(), null);
    await store.remember("something", "Household");
    const block = store.render()!;
    assertStringIncludes(block, "## Household");
    assertStringIncludes(block, "something");
    assert(!block.endsWith("\n"), "trailing newline would add a blank line to the prompt");
  });
});

Deno.test("clear — forgets everything and persists that", async () => {
  await withStore(async (store, root) => {
    await store.remember("a");
    await store.remember("b");
    await store.clear();
    const reopened = new MemoryStore(root);
    await reopened.init();
    assertEquals(reopened.list().length, 0);
  });
});
