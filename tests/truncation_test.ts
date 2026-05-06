import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { dashboardStubLine, formatEntityStateLine, okText, okList, renderDashboardNode, summarizeDashboard, walkPath } from "../tools.ts";

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

Deno.test("summarizeDashboard — lists views with title and card count (legacy/masonry shape)", () => {
  const cfg = {
    title: "Main",
    views: [
      { title: "Home", path: "home", cards: [1, 2, 3], badges: [1] },
      { title: "Office", cards: [{}, {}] },
    ],
  };
  const summary = summarizeDashboard(cfg);
  assertStringIncludes(summary, "views (2):");
  assertStringIncludes(summary, '"Home"');
  assertStringIncludes(summary, "3 cards top-level");
  assertStringIncludes(summary, "1 badge");
  assertStringIncludes(summary, '"Office"');
  assertStringIncludes(summary, "2 cards top-level");
  assertStringIncludes(summary, "title:");
  assertStringIncludes(summary, "path=");
});

Deno.test("summarizeDashboard — section views report sections + total cards", () => {
  const cfg = {
    views: [{
      title: "Home",
      path: "home",
      sections: [
        { type: "grid", cards: [{}, {}, {}, {}, {}, {}, {}, {}, {}] }, // 9 cards
        { type: "grid", cards: [{}, {}] }, // 2 cards
      ],
    }],
  };
  const summary = summarizeDashboard(cfg);
  assertStringIncludes(summary, "2 sections");
  assertStringIncludes(summary, "11 cards");
});

Deno.test("summarizeDashboard — handles missing views gracefully", () => {
  const summary = summarizeDashboard({ foo: "bar" });
  assertStringIncludes(summary, "foo:");
});

Deno.test("dashboardStubLine — picks type + identifying field + array counts", () => {
  const out = dashboardStubLine(
    { type: "area", area: "office", display_type: "compact", features: [{}, {}] },
    "views.0.sections.0.cards.1",
  );
  assertStringIncludes(out, "area");
  assertStringIncludes(out, "area=office");
  assertStringIncludes(out, "2 features");
  assertStringIncludes(out, "drill: views.0.sections.0.cards.1");
});

Deno.test("dashboardStubLine — falls back to (object) when no characteristic fields exist", () => {
  const out = dashboardStubLine({}, "views.0");
  assertStringIncludes(out, "(object)");
  assertStringIncludes(out, "drill: views.0");
});

Deno.test("renderDashboardNode — small subtree renders verbatim", () => {
  const card = { type: "entities", entities: ["light.kitchen"] };
  const out = renderDashboardNode(card, "views.0.cards.0");
  // No stub markers; full JSON is emitted.
  const parsed = JSON.parse(out);
  assertEquals(parsed.type, "entities");
  assertEquals(parsed.entities, ["light.kitchen"]);
});

Deno.test("renderDashboardNode — oversized array children become stub strings", () => {
  // Build a section's cards array large enough to blow the leaf budget but
  // with each card individually large enough to also stub.
  const bigCard = (n: number) => ({
    type: "area",
    area: `room_${n}`,
    alert_classes: ["motion", "moisture", "occupancy"],
    sensor_classes: ["temperature", "humidity", "carbon_dioxide", "pm25"],
    display_type: "compact",
    features_position: "inline",
    grid_options: { columns: "full", rows: 1 },
    tap_action: { action: "navigate", navigation_path: `/home/areas-room-${n}` },
    features: [{ type: "area-controls", controls: ["light"] }],
  });
  const section = {
    type: "grid",
    cards: Array.from({ length: 6 }, (_, i) => bigCard(i)),
  };
  const out = renderDashboardNode(section, "views.0.sections.0");
  const parsed = JSON.parse(out);
  // type stays verbatim.
  assertEquals(parsed.type, "grid");
  // cards becomes an array of stub strings, each with its drill path.
  assertEquals(parsed.cards.length, 6);
  for (let i = 0; i < 6; i++) {
    const stub = parsed.cards[i];
    assertEquals(typeof stub, "string");
    assertStringIncludes(stub, `drill: views.0.sections.0.cards.${i}`);
    assertStringIncludes(stub, `area=room_${i}`);
  }
});

Deno.test("renderDashboardNode — once stubbing kicks in, all complex children stub (consistent drill view)", () => {
  // Bigger total → stubbing engaged. A tiny card and a verbose one should both
  // appear as stub strings in the cards array, so the agent gets a uniform list.
  const tiny = { type: "button", entity: "switch.a" };
  const big = {
    type: "area",
    area: "office",
    alert_classes: Array.from({ length: 100 }, (_, i) => `class_${i}_padding`),
  };
  const out = renderDashboardNode({ type: "grid", cards: [tiny, big] }, "views.0.sections.0");
  const parsed = JSON.parse(out);
  assertEquals(typeof parsed.cards[0], "string");
  assertEquals(typeof parsed.cards[1], "string");
  assertStringIncludes(parsed.cards[0], "button");
  assertStringIncludes(parsed.cards[0], "drill: views.0.sections.0.cards.0");
  assertStringIncludes(parsed.cards[1], "area=office");
  assertStringIncludes(parsed.cards[1], "drill: views.0.sections.0.cards.1");
});

Deno.test("renderDashboardNode — oversized non-array object child stubs to one string", () => {
  // tap_action is a small object on every card and would be inlined; but if
  // someone shoves a huge nested object in there it should stub instead.
  const big = {
    type: "area",
    massive_field: { padding: "x".repeat(2000) },
  };
  const out = renderDashboardNode(big, "views.0.sections.0.cards.0");
  const parsed = JSON.parse(out);
  // The container's small fields stay; the oversized child stubs.
  assertEquals(parsed.type, "area");
  assertEquals(typeof parsed.massive_field, "string");
  assertStringIncludes(parsed.massive_field, "drill: views.0.sections.0.cards.0.massive_field");
});

Deno.test("formatEntityStateLine — appends unit_of_measurement when state is numeric", () => {
  const line = formatEntityStateLine({
    entity_id: "sensor.outdoor_temperature",
    state: "21.5",
    attributes: { friendly_name: "Outdoor Temperature", unit_of_measurement: "°C" },
  });
  assertEquals(line, "sensor.outdoor_temperature (Outdoor Temperature): 21.5 °C");
});

Deno.test("formatEntityStateLine — omits unit when state is non-numeric (unavailable)", () => {
  const line = formatEntityStateLine({
    entity_id: "sensor.broken",
    state: "unavailable",
    attributes: { friendly_name: "Broken", unit_of_measurement: "°C" },
  });
  assertEquals(line, "sensor.broken (Broken): unavailable");
});

Deno.test("formatEntityStateLine — no unit attribute leaves state untouched", () => {
  const line = formatEntityStateLine({
    entity_id: "light.kitchen",
    state: "on",
    attributes: { friendly_name: "Kitchen Light" },
  });
  assertEquals(line, "light.kitchen (Kitchen Light): on");
});

Deno.test("formatEntityStateLine — drops friendly_name when it equals entity_id", () => {
  const line = formatEntityStateLine({
    entity_id: "sensor.x",
    state: "7",
    attributes: { friendly_name: "sensor.x", unit_of_measurement: "kWh" },
  });
  assertEquals(line, "sensor.x: 7 kWh");
});
