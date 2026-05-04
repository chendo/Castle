import { assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  alignBucketStart,
  buildBuckets,
  classifyHistory,
  computeStats,
  formatHistorySummary,
  formatStateChangeSummary,
  isNumericState,
  parseHistoryPoints,
  parseStateChanges,
  pickAutoInterval,
  STATE_CHANGE_PER_LINE_LIMIT,
} from "../tools.ts";

Deno.test("parseHistoryPoints — modern WS shape (object keyed by entity, abbreviated keys, epoch seconds)", () => {
  const raw = {
    "sensor.office_temperature": [
      { s: "20.1", lu: 1714521600 },     // 2024-05-01T00:00:00Z
      { s: "20.5", lu: 1714521900 },     // +5min
      { s: "off", lu: 1714522200 },      // non-numeric — skipped
      { s: "21.0", lu: 1714522500 },
    ],
  };
  const pts = parseHistoryPoints(raw);
  assertExists(pts);
  assertEquals(pts.length, 3);
  assertEquals(pts[0].value, 20.1);
  assertEquals(pts[0].timestamp.toISOString(), "2024-05-01T00:00:00.000Z");
  assertEquals(pts[2].value, 21.0);
});

Deno.test("parseHistoryPoints — legacy REST shape (array of arrays, full keys, ISO strings)", () => {
  const raw = [[
    { state: "20.1", last_changed: "2024-05-01T00:00:00Z" },
    { state: "20.5", last_changed: "2024-05-01T00:05:00Z" },
  ]];
  const pts = parseHistoryPoints(raw);
  assertExists(pts);
  assertEquals(pts.length, 2);
  assertEquals(pts[1].value, 20.5);
});

Deno.test("parseHistoryPoints — null/empty/malformed return null", () => {
  assertEquals(parseHistoryPoints(null), null);
  assertEquals(parseHistoryPoints(undefined), null);
  assertEquals(parseHistoryPoints({}), null);
  assertEquals(parseHistoryPoints([]), null);
  assertEquals(parseHistoryPoints({ foo: "bar" }), null);
  // All values non-numeric → null
  assertEquals(parseHistoryPoints({ "sensor.x": [{ s: "on", lu: 1714521600 }] }), null);
});

Deno.test("computeStats — basic min/max/avg/trend", () => {
  const pts = [
    { value: 10, timestamp: new Date("2024-05-01T00:00Z"), rawIso: "2024-05-01T00:00Z" },
    { value: 20, timestamp: new Date("2024-05-01T01:00Z"), rawIso: "2024-05-01T01:00Z" },
    { value: 15, timestamp: new Date("2024-05-01T02:00Z"), rawIso: "2024-05-01T02:00Z" },
  ];
  const s = computeStats(pts);
  assertEquals(s.min, 10);
  assertEquals(s.max, 20);
  assertEquals(s.last, 15);
  assertEquals(s.count, 3);
  assertEquals(s.trendDelta, 5);
  assertEquals(s.trendDir, "rising"); // 5 / range(10) = 0.5 > 0.15
});

Deno.test("computeStats — stable trend when delta is small relative to range", () => {
  const pts = [
    { value: 10, timestamp: new Date("2024-05-01T00:00Z"), rawIso: "2024-05-01T00:00Z" },
    { value: 30, timestamp: new Date("2024-05-01T01:00Z"), rawIso: "2024-05-01T01:00Z" },
    { value: 11, timestamp: new Date("2024-05-01T02:00Z"), rawIso: "2024-05-01T02:00Z" },
  ];
  const s = computeStats(pts);
  // delta = 1, range = 20, ratio 0.05 → stable
  assertEquals(s.trendDir, "stable");
});

Deno.test("buildBuckets — aligns to rangeStart, distributes points by index", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T00:30:00Z");
  const intervalMs = 5 * 60_000;
  const pts = [
    // bucket 0 (00:00–00:05): 2 points
    { value: 10, timestamp: new Date("2024-05-01T00:00:30Z"), rawIso: "" },
    { value: 11, timestamp: new Date("2024-05-01T00:04:00Z"), rawIso: "" },
    // bucket 2 (00:10–00:15): 1 point
    { value: 12, timestamp: new Date("2024-05-01T00:12:00Z"), rawIso: "" },
    // bucket 5 (00:25–00:30): 1 point
    { value: 13, timestamp: new Date("2024-05-01T00:28:00Z"), rawIso: "" },
  ];
  const buckets = buildBuckets(pts, start, end, intervalMs);
  assertEquals(buckets.length, 6);
  assertEquals(buckets[0].values, [10, 11]);
  assertEquals(buckets[1].values, []);
  assertEquals(buckets[2].values, [12]);
  assertEquals(buckets[3].values, []);
  assertEquals(buckets[4].values, []);
  assertEquals(buckets[5].values, [13]);
});

Deno.test("alignBucketStart — floors to interval boundary", () => {
  const ts = new Date("2024-05-01T14:42:37Z");
  // 5min: 14:40, 30min: 14:30, 60min: 14:00
  assertEquals(alignBucketStart(ts, 5 * 60_000).toISOString(), "2024-05-01T14:40:00.000Z");
  assertEquals(alignBucketStart(ts, 30 * 60_000).toISOString(), "2024-05-01T14:30:00.000Z");
  assertEquals(alignBucketStart(ts, 60 * 60_000).toISOString(), "2024-05-01T14:00:00.000Z");
  // Already aligned — no change.
  const aligned = new Date("2024-05-01T14:00:00Z");
  assertEquals(alignBucketStart(aligned, 5 * 60_000).toISOString(), "2024-05-01T14:00:00.000Z");
});

Deno.test("buildBuckets — aligns to wall-clock when rangeStart is unaligned", () => {
  // rangeStart is 14:42 (between 14:40 and 14:45). Buckets should snap to :40.
  const start = new Date("2024-05-01T14:42:00Z");
  const end = new Date("2024-05-01T14:55:00Z");
  const intervalMs = 5 * 60_000;
  const pts = [
    { value: 1, timestamp: new Date("2024-05-01T14:43:00Z"), rawIso: "" }, // bucket 0 (14:40-14:45)
    { value: 2, timestamp: new Date("2024-05-01T14:47:00Z"), rawIso: "" }, // bucket 1 (14:45-14:50)
    { value: 3, timestamp: new Date("2024-05-01T14:52:00Z"), rawIso: "" }, // bucket 2 (14:50-14:55)
  ];
  const buckets = buildBuckets(pts, start, end, intervalMs);
  // alignedStart = 14:40, end = 14:55 → buckets at 14:40, 14:45, 14:50 = 3 buckets.
  assertEquals(buckets.length, 3);
  assertEquals(buckets[0].start.toISOString(), "2024-05-01T14:40:00.000Z");
  assertEquals(buckets[0].values, [1]);
  assertEquals(buckets[1].values, [2]);
  assertEquals(buckets[2].values, [3]);
});

Deno.test("buildBuckets — points outside range are dropped", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T00:10:00Z");
  const pts = [
    { value: 1, timestamp: new Date("2024-04-30T23:55:00Z"), rawIso: "" }, // before
    { value: 2, timestamp: new Date("2024-05-01T00:05:00Z"), rawIso: "" }, // bucket 1
    { value: 3, timestamp: new Date("2024-05-01T00:15:00Z"), rawIso: "" }, // after
  ];
  const buckets = buildBuckets(pts, start, end, 5 * 60_000);
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].values, []);
  assertEquals(buckets[1].values, [2]);
});

Deno.test("isNumericState — sentinels and edge cases", () => {
  assertEquals(isNumericState("20.5"), true);
  assertEquals(isNumericState("-3"), true);
  assertEquals(isNumericState("0"), true);
  assertEquals(isNumericState("on"), false);
  assertEquals(isNumericState("off"), false);
  assertEquals(isNumericState("unknown"), false);
  assertEquals(isNumericState("unavailable"), false);
  assertEquals(isNumericState(""), false);
});

Deno.test("parseStateChanges — keeps every state, sorted chronologically", () => {
  const raw = {
    "binary_sensor.front_door": [
      { s: "off", lu: 1714521600 },     // 2024-05-01T00:00:00Z
      { s: "on",  lu: 1714521630 },     // +30s
      { s: "off", lu: 1714521900 },     // +5min
      { s: "on",  lu: 1714521700 },     // out-of-order — should be sorted in
    ],
  };
  const cs = parseStateChanges(raw);
  assertEquals(cs.length, 4);
  assertEquals(cs.map((c) => c.state), ["off", "on", "on", "off"]);
  assertEquals(cs[0].timestamp.toISOString(), "2024-05-01T00:00:00.000Z");
  assertEquals(cs[3].timestamp.toISOString(), "2024-05-01T00:05:00.000Z");
});

Deno.test("parseStateChanges — legacy REST shape with full keys + ISO strings", () => {
  const raw = [[
    { state: "closed", last_changed: "2024-05-01T00:00:00Z" },
    { state: "open",   last_changed: "2024-05-01T00:01:00Z" },
  ]];
  const cs = parseStateChanges(raw);
  assertEquals(cs.length, 2);
  assertEquals(cs[1].state, "open");
});

Deno.test("parseStateChanges — empty / malformed return []", () => {
  assertEquals(parseStateChanges(null), []);
  assertEquals(parseStateChanges(undefined), []);
  assertEquals(parseStateChanges({}), []);
  assertEquals(parseStateChanges([]), []);
  assertEquals(parseStateChanges({ foo: "bar" }), []);
});

Deno.test("classifyHistory — numeric sensor", () => {
  const cs = parseStateChanges({
    "sensor.t": [
      { s: "20.1", lu: 1714521600 },
      { s: "20.2", lu: 1714521660 },
      { s: "unknown", lu: 1714521720 }, // sentinel — ignored
      { s: "20.3", lu: 1714521780 },
    ],
  });
  assertEquals(classifyHistory(cs), "numeric");
});

Deno.test("classifyHistory — binary sensor (categorical)", () => {
  const cs = parseStateChanges({
    "binary_sensor.x": [
      { s: "off", lu: 1714521600 },
      { s: "on",  lu: 1714521660 },
      { s: "off", lu: 1714521720 },
    ],
  });
  assertEquals(classifyHistory(cs), "state");
});

Deno.test("classifyHistory — empty", () => {
  assertEquals(classifyHistory([]), "empty");
});

Deno.test("classifyHistory — only sentinels falls back to state", () => {
  const cs = parseStateChanges({
    "sensor.x": [
      { s: "unknown", lu: 1714521600 },
      { s: "unavailable", lu: 1714521660 },
    ],
  });
  assertEquals(classifyHistory(cs), "state");
});

Deno.test("formatStateChangeSummary — sparse list emits prev → new with full date timestamps", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T01:00:00Z");
  const changes = [
    { state: "off", timestamp: new Date("2024-05-01T00:00:30Z"), rawIso: "" },
    { state: "on",  timestamp: new Date("2024-05-01T00:00:45Z"), rawIso: "" },
    { state: "off", timestamp: new Date("2024-05-01T00:05:12Z"), rawIso: "" },
  ];
  const out = formatStateChangeSummary("binary_sensor.door", changes, start, end, "UTC");
  assertEquals(out.includes("binary_sensor.door"), true);
  // 3 records → 2 transitions (off→on, on→off). compact[0]=off is the entering state.
  assertEquals(out.includes("2 transitions"), true);
  assertEquals(out.includes("last=off"), true);
  assertEquals(out.includes("Distribution: off=2 on=1"), true);
  // Transitions with full date + seconds + arrow form
  assertEquals(/2024-05-01 00:00:45 off → on/.test(out), true);
  assertEquals(/2024-05-01 00:05:12 on → off/.test(out), true);
  // The very first record (off) is NOT emitted as a transition — only as the
  // entering state via the header — so there should be no "2024-05-01 00:00:30" line.
  assertEquals(out.includes("00:00:30 "), false);
});

Deno.test("formatStateChangeSummary — collapses consecutive duplicates", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T01:00:00Z");
  const changes = [
    { state: "off", timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { state: "off", timestamp: new Date("2024-05-01T00:01:00Z"), rawIso: "" },
    { state: "on",  timestamp: new Date("2024-05-01T00:02:00Z"), rawIso: "" },
    { state: "on",  timestamp: new Date("2024-05-01T00:03:00Z"), rawIso: "" },
  ];
  const out = formatStateChangeSummary("binary_sensor.door", changes, start, end, "UTC");
  // 4 records → 2 distinct states → 1 transition (off→on)
  assertEquals(out.includes("1 transition"), true);
});

Deno.test("formatStateChangeSummary — held-throughout window has no transition lines", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T01:00:00Z");
  const changes = [
    { state: "off", timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
  ];
  const out = formatStateChangeSummary("binary_sensor.door", changes, start, end, "UTC");
  assertEquals(out.includes("0 transitions"), true);
  assertEquals(out.includes("held at off throughout"), true);
});

Deno.test("formatStateChangeSummary — dense series hour-buckets and skips 0-transition hours", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T03:00:00Z");
  const changes: Array<{ state: string; timestamp: Date; rawIso: string }> = [];
  const total = STATE_CHANGE_PER_LINE_LIMIT + 30;
  for (let i = 0; i < total; i++) {
    const ts = new Date(start.getTime() + i * 60_000);
    changes.push({ state: i % 2 === 0 ? "off" : "on", timestamp: ts, rawIso: "" });
  }
  const out = formatStateChangeSummary("binary_sensor.dense", changes, start, end, "UTC");
  assertEquals(out.includes("(many transitions — hour-bucketed"), true);
  // Bucket lines look like: "2024-05-01 00:00–01:00  N changes, ended <state>"
  const bucketLines = out.split("\n").filter((l) => /\d+ changes?, ended /.test(l));
  assertEquals(bucketLines.length >= 1, true);
  assertEquals(bucketLines.length <= 3, true);
  // Sanity: timestamps include the date prefix so cross-midnight ranges are unambiguous.
  for (const l of bucketLines) {
    assertEquals(/^2024-05-01 \d{2}:\d{2}–\d{2}:\d{2}/.test(l), true);
  }
});

Deno.test("formatHistorySummary — single-value bucket vs varying min–max, avg", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T01:00:00Z");
  // Two 5-min buckets: [00:00] stable at 18.5; [00:05] varies 18.5→18.9.
  const points = [
    { value: 18.5, timestamp: new Date("2024-05-01T00:00:30Z"), rawIso: "" },
    { value: 18.5, timestamp: new Date("2024-05-01T00:01:00Z"), rawIso: "" },
    { value: 18.5, timestamp: new Date("2024-05-01T00:05:00Z"), rawIso: "" },
    { value: 18.7, timestamp: new Date("2024-05-01T00:06:00Z"), rawIso: "" },
    { value: 18.9, timestamp: new Date("2024-05-01T00:08:00Z"), rawIso: "" },
  ];
  const out = formatHistorySummary("sensor.t", points, [], start, end, 5, "UTC");
  // Single-value bucket uses just the number
  assertEquals(/2024-05-01 00:00=18\.5/.test(out), true);
  // Varying bucket uses "min–max, avg X"
  assertEquals(/2024-05-01 00:05=18\.5–18\.9, avg 18\.7/.test(out), true);
});

Deno.test("formatHistorySummary — collapses runs of identical bucket values", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T00:30:00Z");
  // 4 buckets all stable at 0, then a brief spike, then a second sample
  // sustaining 0 — to confirm both leading runs and post-spike runs collapse.
  const points = [
    { value: 0, timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { value: 0, timestamp: new Date("2024-05-01T00:05:00Z"), rawIso: "" },
    { value: 0, timestamp: new Date("2024-05-01T00:10:00Z"), rawIso: "" },
    { value: 0, timestamp: new Date("2024-05-01T00:15:00Z"), rawIso: "" },
    { value: 2400, timestamp: new Date("2024-05-01T00:20:00Z"), rawIso: "" },
    { value: 0, timestamp: new Date("2024-05-01T00:25:00Z"), rawIso: "" },
  ];
  const out = formatHistorySummary("sensor.power", points, [], start, end, 5, "UTC");
  const bucketLines = out.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}=/.test(l));
  const valueLines = bucketLines.map((l) => l.split("=")[1]);
  // 00:00=0 (initial), 00:20=2400 (spike), 00:25=0 (back to idle). The leading
  // runs of "0" collapse to one line.
  assertEquals(valueLines, ["0", "2400", "0"]);
});

Deno.test("formatHistorySummary — surfaces unavailable + unknown stretches in header", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T01:00:00Z");
  const points = [
    { value: 20.0, timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { value: 21.0, timestamp: new Date("2024-05-01T00:30:00Z"), rawIso: "" },
  ];
  const changes = [
    { state: "20.0", timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { state: "unavailable", timestamp: new Date("2024-05-01T00:10:00Z"), rawIso: "" },
    { state: "20.5", timestamp: new Date("2024-05-01T00:25:00Z"), rawIso: "" },
    { state: "unknown", timestamp: new Date("2024-05-01T00:40:00Z"), rawIso: "" },
    { state: "21.0", timestamp: new Date("2024-05-01T00:45:00Z"), rawIso: "" },
  ];
  const out = formatHistorySummary("sensor.t", points, changes, start, end, 5, "UTC");
  assertEquals(/Unavailable: 2024-05-01 00:10–2024-05-01 00:25 \(15min\)/.test(out), true);
  assertEquals(/Unknown: 2024-05-01 00:40–2024-05-01 00:45 \(5min\)/.test(out), true);
});

Deno.test("formatHistorySummary — empty bucket inside an unavailable stretch renders 'unavail'", () => {
  const start = new Date("2024-05-01T00:00:00Z");
  const end = new Date("2024-05-01T00:30:00Z");
  // Numeric data only at 00:00 and 00:25; the buckets in between have no
  // numeric points but the changes list says we were unavailable across them.
  const points = [
    { value: 18.5, timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { value: 18.7, timestamp: new Date("2024-05-01T00:25:00Z"), rawIso: "" },
  ];
  const changes = [
    { state: "18.5", timestamp: new Date("2024-05-01T00:00:00Z"), rawIso: "" },
    { state: "unavailable", timestamp: new Date("2024-05-01T00:08:00Z"), rawIso: "" },
    { state: "18.7", timestamp: new Date("2024-05-01T00:25:00Z"), rawIso: "" },
  ];
  const out = formatHistorySummary("sensor.t", points, changes, start, end, 5, "UTC");
  // Bucket starting at 00:05 and 00:10 should mark unavail rather than `_`.
  // (Skip-if-unchanged collapses them to a single line.)
  assertEquals(/2024-05-01 00:05=unavail/.test(out), true);
  // The 00:10/00:15/00:20 buckets are skipped because their rendered value
  // ("unavail") matches the previous emitted bucket.
  assertEquals((out.match(/=unavail/g) ?? []).length, 1);
});

Deno.test("pickAutoInterval — duration thresholds", () => {
  const h = (n: number) => n * 3_600_000;
  assertEquals(pickAutoInterval(h(1)), 5);
  assertEquals(pickAutoInterval(h(2)), 5);
  assertEquals(pickAutoInterval(h(3)), 10);
  assertEquals(pickAutoInterval(h(6)), 10);
  assertEquals(pickAutoInterval(h(7)), 15);
  assertEquals(pickAutoInterval(h(12)), 15);
  assertEquals(pickAutoInterval(h(24)), 30);
  assertEquals(pickAutoInterval(h(36)), 30);
  assertEquals(pickAutoInterval(h(72)), 60);
});
