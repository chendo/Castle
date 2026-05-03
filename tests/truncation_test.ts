import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { okText, okList, walkPath, summarizeDashboard } from "../tools.ts";

Deno.test("okText — under budget passes through unchanged", () => {
  const r = okText("hello world", { maxBytes: 1024 });
  assertEquals(r.content, [{ type: "text", text: "hello world" }]);
  assertEquals(r.details.truncated, undefined);
});

Deno.test("okText — over budget truncates with footer + details", () => {
  const long = "x".repeat(5000);
  const r = okText(long, { maxBytes: 1000 });
  const text = (r.content[0] as { type: "text"; text: string }).text;
  assert(text.length < long.length, "text should be shorter than input");
  assertStringIncludes(text, "[truncated:");
  const t = r.details.truncated as { bytes_elided: number; total_bytes: number };
  assert(t, "truncated details should be set");
  assertEquals(t.total_bytes, 5000);
  assert(t.bytes_elided > 0);
});

Deno.test("okText — prefers a newline boundary when one is in the second half", () => {
  // Build a string where there's a newline right before maxBytes.
  const head = "line one\nline two\nline three\n";
  const tail = "x".repeat(2000);
  const r = okText(head + tail, { maxBytes: head.length + 5 });
  const text = (r.content[0] as { type: "text"; text: string }).text;
  // Cut should be at the newline after "line three", not mid-line.
  assertStringIncludes(text, "line three\n");
  // Should not contain the tail's `x` padding.
  assertEquals(text.includes("xxxxx"), false);
});

Deno.test("okList — under budget joins all items, no truncation", () => {
  const items = ["a", "b", "c"];
  const r = okList("", items, { maxBytes: 1024 });
  assertEquals((r.content[0] as { type: "text"; text: string }).text, "a\nb\nc");
  assertEquals(r.details.truncated, undefined);
});

Deno.test("okList — over budget keeps whole items only and reports counts", () => {
  const items = Array.from({ length: 100 }, (_, i) => `item-${i.toString().padStart(3, "0")}`);
  const r = okList("", items, { maxBytes: 200 });
  const text = (r.content[0] as { type: "text"; text: string }).text;
  // Every line must be a complete `item-NNN` — no partial item at the cut.
  for (const line of text.split("\n")) {
    if (line.startsWith("[truncated") || line === "") continue;
    assert(/^item-\d{3}$/.test(line), `expected complete item, got: ${line}`);
  }
  const t = r.details.truncated as { items_elided: number; total_items: number };
  assertEquals(t.total_items, 100);
  assert(t.items_elided > 0);
  assertEquals(t.total_items - t.items_elided + t.items_elided, 100);
});

Deno.test("okList — header is preserved when truncating", () => {
  const items = Array.from({ length: 50 }, () => "x".repeat(50));
  const r = okList("HEADER", items, { maxBytes: 200 });
  const text = (r.content[0] as { type: "text"; text: string }).text;
  assertStringIncludes(text, "HEADER\n");
  assertStringIncludes(text, "[truncated:");
});

Deno.test("walkPath — empty path returns root", () => {
  const root = { a: 1 };
  const { value, found } = walkPath(root, "");
  assertEquals(found, true);
  assertEquals(value, root);
});

Deno.test("walkPath — object then array index", () => {
  const root = { views: [{ title: "Home" }, { title: "Office" }] };
  const r = walkPath(root, "views.1.title");
  assertEquals(r.found, true);
  assertEquals(r.value, "Office");
});

Deno.test("walkPath — missing key returns found=false", () => {
  const r = walkPath({ a: 1 }, "b");
  assertEquals(r.found, false);
});

Deno.test("walkPath — array index out of range returns found=false", () => {
  const r = walkPath({ a: [1, 2] }, "a.5");
  assertEquals(r.found, false);
});

Deno.test("walkPath — non-numeric segment on array returns found=false", () => {
  const r = walkPath({ a: [1, 2] }, "a.x");
  assertEquals(r.found, false);
});

Deno.test("summarizeDashboard — lists views with title and card count", () => {
  const cfg = {
    title: "Main",
    views: [
      { title: "Home", path: "home", cards: [1, 2, 3], badges: [1] },
      { title: "Office", cards: [{}, {}] },
    ],
  };
  const summary = summarizeDashboard(cfg);
  assertStringIncludes(summary, "views (2):");
  assertStringIncludes(summary, "views.0");
  assertStringIncludes(summary, '"Home"');
  assertStringIncludes(summary, "3 cards");
  assertStringIncludes(summary, "1 badges");
  assertStringIncludes(summary, "views.1");
  assertStringIncludes(summary, '"Office"');
  assertStringIncludes(summary, "2 cards");
  // Top-level non-views key surfaces too.
  assertStringIncludes(summary, "title:");
  // Drill-down hint mentions `path=`.
  assertStringIncludes(summary, "path=");
});

Deno.test("summarizeDashboard — handles missing views gracefully", () => {
  const summary = summarizeDashboard({ foo: "bar" });
  assertStringIncludes(summary, "foo:");
});
