import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  DISMISS_TTL_MS,
  fingerprintOf,
  normalizeSummary,
  ObservationStore,
  type ObservationBody,
  type PassRef,
} from "../observer-store.ts";

const T0 = Date.parse("2026-08-31T18:00:00Z");

const pass: PassRef = {
  id: "pass_1",
  kind: "reactive",
  startedAt: T0,
  durationMs: 1200,
  toolCalls: 2,
};

function concern(summary: string, entities: string[] = ["light.porch"]): ObservationBody {
  return { type: "concern", severity: "warn", summary, entities };
}

async function withStore(
  fn: (store: ObservationStore, root: string, setNow: (t: number) => void) => Promise<void>,
  max = 500,
): Promise<void> {
  const root = await Deno.makeTempDir();
  let now = T0;
  try {
    const store = new ObservationStore(root, max, () => now);
    await store.init();
    await fn(store, root, (t) => { now = t; });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// --- fingerprinting ---------------------------------------------------------

Deno.test("normalizeSummary — strips digits so a changing duration is the same finding", () => {
  assertEquals(
    normalizeSummary("Porch light unavailable for 3m"),
    normalizeSummary("Porch light unavailable for 47m"),
  );
});

Deno.test("normalizeSummary — ignores punctuation and case", () => {
  assertEquals(normalizeSummary("Porch light: UNAVAILABLE!"), normalizeSummary("porch light unavailable"));
});

Deno.test("fingerprintOf — concerns differ when the entities differ", async () => {
  const a = await fingerprintOf(concern("light unavailable", ["light.porch"]));
  const b = await fingerprintOf(concern("light unavailable", ["light.hall"]));
  assertNotEquals(a, b);
});

Deno.test("fingerprintOf — entity order does not change identity", async () => {
  const a = await fingerprintOf(concern("x", ["light.a", "light.b"]));
  const b = await fingerprintOf(concern("x", ["light.b", "light.a"]));
  assertEquals(a, b);
});

Deno.test("fingerprintOf — proposal identity ignores argument key order", async () => {
  const mk = (args: Record<string, unknown>): ObservationBody => ({
    type: "proposal",
    tool: "ha_call_service",
    args,
    reason: "r",
    entities: [],
  });
  const a = await fingerprintOf(mk({ domain: "light", service: "turn_off", entity_id: "light.a" }));
  const b = await fingerprintOf(mk({ entity_id: "light.a", service: "turn_off", domain: "light" }));
  assertEquals(a, b);
});

Deno.test("fingerprintOf — a proposal and a concern are never the same finding", async () => {
  const c = await fingerprintOf(concern("turn off the garage light"));
  const p = await fingerprintOf({
    type: "proposal",
    tool: "ha_call_service",
    args: { domain: "light", service: "turn_off" },
    reason: "r",
    entities: [],
  });
  assertNotEquals(c, p);
});

// --- dedup ------------------------------------------------------------------

Deno.test("raise — the same finding twice folds into one record", async () => {
  await withStore(async (store) => {
    const a = await store.raise(concern("Porch light unavailable for 3m"), pass);
    const b = await store.raise(concern("Porch light unavailable for 19m"), pass);
    assertEquals(a.deduped, false);
    assertEquals(b.deduped, true);
    assertEquals(b.observation.id, a.observation.id);
    assertEquals(b.observation.occurrences, 2);
    assertEquals(store.snapshot().length, 1);
  });
});

Deno.test("raise — distinct findings both land", async () => {
  await withStore(async (store) => {
    await store.raise(concern("Porch light unavailable", ["light.porch"]), pass);
    await store.raise(concern("Hall light unavailable", ["light.hall"]), pass);
    assertEquals(store.snapshot().length, 2);
  });
});

Deno.test("raise — a dismissed finding is suppressed, not re-raised", async () => {
  await withStore(async (store) => {
    const first = await store.raise(concern("Porch light unavailable"), pass);
    await store.setStatus(first.observation.id, "dismissed", "known flaky");
    const again = await store.raise(concern("Porch light unavailable"), pass);
    assert(again.suppressed);
    assertEquals(store.snapshot().length, 1);
    assertEquals(store.snapshot()[0].status, "dismissed");
  });
});

Deno.test("raise — a dismissal expires, so a recurrence is eventually reported again", async () => {
  await withStore(async (store, _root, setNow) => {
    const first = await store.raise(concern("Porch light unavailable"), pass);
    await store.setStatus(first.observation.id, "dismissed");
    setNow(T0 + DISMISS_TTL_MS + 1);
    const again = await store.raise(concern("Porch light unavailable"), pass);
    assertEquals(again.suppressed, false);
    assertEquals(again.deduped, false);
    assertEquals(store.snapshot().length, 2);
  });
});

Deno.test("raise — an acknowledged finding still absorbs recurrences", async () => {
  await withStore(async (store) => {
    const first = await store.raise(concern("Porch light unavailable"), pass);
    await store.setStatus(first.observation.id, "acknowledged");
    const again = await store.raise(concern("Porch light unavailable"), pass);
    assert(again.deduped);
    assertEquals(again.observation.occurrences, 2);
  });
});

Deno.test("openObservations — excludes dismissed and resolved", async () => {
  await withStore(async (store) => {
    const a = await store.raise(concern("A", ["light.a"]), pass);
    const b = await store.raise(concern("B", ["light.b"]), pass);
    await store.raise(concern("C", ["light.c"]), pass);
    await store.setStatus(a.observation.id, "dismissed");
    await store.setStatus(b.observation.id, "resolved");
    assertEquals(store.openObservations().map((o) => (o.body as { summary: string }).summary), ["C"]);
  });
});

// --- persistence ------------------------------------------------------------

Deno.test("init — replays the log and survives a restart", async () => {
  await withStore(async (store, root) => {
    await store.raise(concern("Porch light unavailable"), pass);
    const reopened = new ObservationStore(root, 500, () => T0);
    await reopened.init();
    assertEquals(reopened.snapshot().length, 1);
  });
});

Deno.test("init — a status change replayed last-write-wins, not duplicated", async () => {
  await withStore(async (store, root) => {
    const a = await store.raise(concern("Porch light unavailable"), pass);
    await store.setStatus(a.observation.id, "dismissed", "known");
    const reopened = new ObservationStore(root, 500, () => T0);
    await reopened.init();
    assertEquals(reopened.snapshot().length, 1);
    assertEquals(reopened.snapshot()[0].status, "dismissed");
    assertEquals(reopened.snapshot()[0].dismissReason, "known");
  });
});

Deno.test("init — a torn line from a crash mid-append does not lose the rest", async () => {
  await withStore(async (store, root) => {
    await store.raise(concern("A", ["light.a"]), pass);
    await Deno.writeTextFile(`${root}/observations.jsonl`, '{"id":"obs_x","broke\n', { append: true });
    await store.raise(concern("B", ["light.b"]), pass);
    const reopened = new ObservationStore(root, 500, () => T0);
    await reopened.init();
    assertEquals(reopened.snapshot().length, 2);
  });
});

Deno.test("init — a missing file is a normal empty start, not an error", async () => {
  const root = await Deno.makeTempDir();
  try {
    const store = new ObservationStore(root);
    await store.init();
    assertEquals(store.snapshot().length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("raise — retention drops the oldest once the cap is passed", async () => {
  await withStore(async (store, root, setNow) => {
    for (let i = 0; i < 5; i++) {
      setNow(T0 + i * 1000);
      await store.raise(concern(`finding ${String.fromCharCode(97 + i)}`, [`light.l${i}`]), pass);
    }
    assertEquals(store.snapshot().length, 3);
    const reopened = new ObservationStore(root, 3, () => T0);
    await reopened.init();
    assertEquals(reopened.snapshot().length, 3);
  }, 3);
});

Deno.test("snapshot — newest first", async () => {
  await withStore(async (store, _root, setNow) => {
    await store.raise(concern("first", ["light.a"]), pass);
    setNow(T0 + 5000);
    await store.raise(concern("second", ["light.b"]), pass);
    assertEquals((store.snapshot()[0].body as { summary: string }).summary, "second");
  });
});

Deno.test("subscribe — fires on create and on status change, and unsubscribes", async () => {
  await withStore(async (store) => {
    const seen: string[] = [];
    const off = store.subscribe((o) => seen.push(o.status));
    const a = await store.raise(concern("A"), pass);
    await store.setStatus(a.observation.id, "dismissed");
    off();
    await store.raise(concern("B", ["light.b"]), pass);
    assertEquals(seen, ["open", "dismissed"]);
  });
});

Deno.test("raise — concurrent raises are serialized and all land", async () => {
  await withStore(async (store) => {
    await Promise.all([
      store.raise(concern("A", ["light.a"]), pass),
      store.raise(concern("B", ["light.b"]), pass),
      store.raise(concern("C", ["light.c"]), pass),
    ]);
    assertEquals(store.snapshot().length, 3);
  });
});

Deno.test("raise — concurrent identical raises dedup to one record", async () => {
  await withStore(async (store) => {
    await Promise.all([
      store.raise(concern("Porch light unavailable"), pass),
      store.raise(concern("Porch light unavailable"), pass),
    ]);
    assertEquals(store.snapshot().length, 1);
    assertEquals(store.snapshot()[0].occurrences, 2);
  });
});

Deno.test("raise — repeated raises replay to the final occurrence count", async () => {
  await withStore(async (store, root) => {
    for (let i = 0; i < 6; i++) await store.raise(concern("Porch light unavailable"), pass);
    const reopened = new ObservationStore(root, 500, () => T0);
    await reopened.init();
    assertEquals(reopened.snapshot()[0].occurrences, 6);
  });
});
