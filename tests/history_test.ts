import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { buildBuckets, computeStats, parseHistoryPoints, pickAutoInterval } from "../tools.ts";

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
