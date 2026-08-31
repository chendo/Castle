import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  circularMedianMinute,
  formatMinuteOfDay,
  ManualActionLog,
  type ManualAction,
  renderPatterns,
  rollupManualActions,
} from "../observer-patterns.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-31T12:00:00Z");

/** One action per day at the given UTC time, `days` days back from NOW. */
function daily(
  entityId: string,
  to: string,
  hhmm: string,
  days: number,
  jitterMinutes: (i: number) => number = () => 0,
): ManualAction[] {
  const [h, m] = hhmm.split(":").map(Number);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(NOW - (i + 1) * DAY);
    d.setUTCHours(h, m + jitterMinutes(i), 0, 0);
    return { ts: d.getTime(), entityId, to };
  });
}

// --- circular median --------------------------------------------------------

Deno.test("circularMedianMinute — ordinary daytime cluster", () => {
  assertEquals(circularMedianMinute([600, 610, 620]), 610);
});

Deno.test("circularMedianMinute — a cluster spanning midnight does not land at noon", () => {
  // 23:50, 23:58, 00:06, 00:14 — a linear median would report ~12:00, which
  // would make every late-night habit look like a lunchtime one.
  const med = circularMedianMinute([1430, 1438, 6, 14]);
  assert(med > 1400 || med < 40, `expected a near-midnight median, got ${med}`);
});

Deno.test("circularMedianMinute — empty input is zero, not NaN", () => {
  assertEquals(circularMedianMinute([]), 0);
});

Deno.test("formatMinuteOfDay — pads and wraps", () => {
  assertEquals(formatMinuteOfDay(0), "00:00");
  assertEquals(formatMinuteOfDay(1367), "22:47");
});

// --- rollup -----------------------------------------------------------------

Deno.test("rollup — a nightly habit is described with its median and spread", () => {
  const rows = daily("light.bedroom_lamp", "on", "22:47", 13, (i) => (i % 5) - 2);
  const [p] = rollupManualActions(rows, NOW, { timeZone: "UTC" });
  assertEquals(p.entityId, "light.bedroom_lamp");
  assertEquals(p.to, "on");
  assertEquals(p.count, 13);
  assertEquals(p.distinctDays, 13);
  assert(Math.abs(p.medianMinuteOfDay - 1367) <= 3, `median was ${p.medianMinuteOfDay}`);
  assert(p.madMinutes <= 3, `expected a tight spread, got ${p.madMinutes}`);
});

Deno.test("rollup — scattered timings report a wide spread", () => {
  const rows = daily("switch.random", "on", "12:00", 12, (i) => i * 47);
  const [p] = rollupManualActions(rows, NOW, { timeZone: "UTC" });
  assert(p.madMinutes > 45, `expected a wide spread, got ${p.madMinutes}`);
});

Deno.test("rollup — a coincidence is not reported as a habit", () => {
  // Three actions is not a pattern; showing it would invite over-reading.
  assertEquals(rollupManualActions(daily("light.a", "on", "20:00", 3), NOW).length, 0);
});

Deno.test("rollup — many actions crammed into two days is not a habit either", () => {
  const rows: ManualAction[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ ts: NOW - DAY - i * 60_000, entityId: "light.a", to: "on" });
  }
  assertEquals(rollupManualActions(rows, NOW).length, 0, "needs distinct days, not just volume");
});

Deno.test("rollup — actions outside the window are excluded", () => {
  const recent = daily("light.a", "on", "20:00", 6);
  const old = daily("light.a", "on", "20:00", 6).map((r) => ({ ...r, ts: r.ts - 30 * DAY }));
  const [p] = rollupManualActions([...recent, ...old], NOW, { timeZone: "UTC" });
  assertEquals(p.count, 6);
});

Deno.test("rollup — the same entity to different states are separate patterns", () => {
  const out = rollupManualActions(
    [...daily("cover.blind", "close", "17:20", 9), ...daily("cover.blind", "open", "07:10", 9)],
    NOW,
    { timeZone: "UTC" },
  );
  assertEquals(out.length, 2);
  assertEquals(new Set(out.map((p) => p.to)), new Set(["open", "close"]));
});

Deno.test("rollup — strongest habits come first", () => {
  const out = rollupManualActions(
    [...daily("light.a", "on", "20:00", 6), ...daily("light.b", "on", "21:00", 12)],
    NOW,
    { timeZone: "UTC" },
  );
  assertEquals(out[0].entityId, "light.b");
});

Deno.test("rollup — timezone shifts the reported time of day", () => {
  const rows = daily("light.a", "on", "22:00", 10);
  const utc = rollupManualActions(rows, NOW, { timeZone: "UTC" })[0];
  const syd = rollupManualActions(rows, NOW, { timeZone: "Australia/Sydney" })[0];
  assertEquals(utc.medianMinuteOfDay, 22 * 60);
  assert(syd.medianMinuteOfDay !== utc.medianMinuteOfDay);
});

Deno.test("rollup — a garbage timezone degrades to UTC instead of throwing", () => {
  const out = rollupManualActions(daily("light.a", "on", "20:00", 8), NOW, { timeZone: "Not/AZone" });
  assertEquals(out[0].medianMinuteOfDay, 20 * 60);
});

// --- rendering --------------------------------------------------------------

Deno.test("renderPatterns — nothing to review renders nothing", () => {
  assertEquals(renderPatterns([], new Map()), null);
});

Deno.test("renderPatterns — a tight habit shows a time, a loose one says so", () => {
  const tight = rollupManualActions(daily("light.a", "on", "22:47", 12), NOW, { timeZone: "UTC" });
  const loose = rollupManualActions(daily("light.b", "on", "12:00", 12, (i) => i * 47), NOW, {
    timeZone: "UTC",
  });
  assertStringIncludes(renderPatterns(tight, new Map())!, "typical 22:47");
  // Without this the model proposes a time-triggered automation for something
  // that has no consistent time.
  assertStringIncludes(renderPatterns(loose, new Map())!, "no consistent time");
});

Deno.test("renderPatterns — existing automation coverage is stated, not guessed", () => {
  // The observer has no ha_get_automation tool, so this fact has to be handed
  // to it or it will speculate about whether something is already automated.
  const patterns = rollupManualActions(daily("cover.blind", "close", "17:20", 9), NOW, {
    timeZone: "UTC",
  });
  const out = renderPatterns(patterns, new Map([["cover.blind", ["automation.evening_blinds"]]]))!;
  assertStringIncludes(out, "already reference these entities");
  assertStringIncludes(out, "automation.evening_blinds");
});

Deno.test("renderPatterns — omits the coverage section when there is none", () => {
  const patterns = rollupManualActions(daily("light.a", "on", "20:00", 8), NOW, { timeZone: "UTC" });
  assertEquals(renderPatterns(patterns, new Map())!.includes("already reference"), false);
});

// --- the log ----------------------------------------------------------------

async function withLog(fn: (log: ManualActionLog, root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const log = new ManualActionLog(root, () => NOW);
    await log.init();
    await fn(log, root);
    log.stop();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("ManualActionLog — records survive a flush and reload", async () => {
  await withLog(async (log, root) => {
    log.record({ ts: NOW - DAY, entityId: "light.a", to: "on" });
    await log.flush();
    const reopened = new ManualActionLog(root, () => NOW);
    await reopened.init();
    assertEquals(reopened.all().length, 1);
  });
});

Deno.test("ManualActionLog — retention drops rows outside the window on load", async () => {
  await withLog(async (log, root) => {
    log.record({ ts: NOW - 30 * DAY, entityId: "light.old", to: "on" });
    log.record({ ts: NOW - DAY, entityId: "light.new", to: "on" });
    await log.flush();
    const reopened = new ManualActionLog(root, () => NOW);
    await reopened.init();
    assertEquals(reopened.all().map((r) => r.entityId), ["light.new"]);
  });
});

Deno.test("ManualActionLog — a torn line does not lose the rest", async () => {
  await withLog(async (log, root) => {
    log.record({ ts: NOW - DAY, entityId: "light.a", to: "on" });
    await log.flush();
    await Deno.writeTextFile(`${root}/manual-actions.jsonl`, '{"ts":123,"bro\n', { append: true });
    const reopened = new ManualActionLog(root, () => NOW);
    await reopened.init();
    assertEquals(reopened.all().length, 1);
  });
});

Deno.test("ManualActionLog — a missing file is a normal empty start", async () => {
  const root = await Deno.makeTempDir();
  try {
    const log = new ManualActionLog(root, () => NOW);
    await log.init();
    assertEquals(log.all().length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ManualActionLog — stop cancels the pending write so nothing leaks", async () => {
  await withLog(async (log) => {
    log.record({ ts: NOW, entityId: "light.a", to: "on" });
    log.stop();
    // If the debounce timer were still armed, Deno's sanitizer would fail the
    // test with a leaked-timer error.
  });
});
