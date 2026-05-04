import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyDashboardOps, type DashboardOp, walkPath, walkToParent } from "../tools.ts";

function sampleConfig() {
  return {
    title: "Home",
    views: [
      {
        title: "Overview",
        cards: [
          { type: "entities", entities: ["light.kitchen"] },
          { type: "weather-forecast", entity: "weather.home" },
        ],
      },
      {
        title: "Bedroom",
        cards: [{ type: "light", entity: "light.bedroom" }],
      },
    ],
  };
}

Deno.test("walkToParent — object key", () => {
  const r = walkToParent(sampleConfig(), "views.0.title");
  assert(r);
  assertEquals(r!.key, "title");
  assertEquals((r!.parent as any).title, "Overview");
});

Deno.test("walkToParent — array index", () => {
  const r = walkToParent(sampleConfig(), "views.0.cards.1");
  assert(r);
  assertEquals(r!.key, "1");
  assertEquals(Array.isArray(r!.parent), true);
});

Deno.test("walkToParent — bad path returns null", () => {
  assertEquals(walkToParent(sampleConfig(), "views.5.title"), null);
  assertEquals(walkToParent(sampleConfig(), ""), null);
});

Deno.test("applyDashboardOps — set replaces an existing leaf", () => {
  const ops: DashboardOp[] = [{ op: "set", path: "views.0.title", value: "Living Room" }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  assertEquals((config as any).views[0].title, "Living Room");
});

Deno.test("applyDashboardOps — set adds a new key on an object", () => {
  const ops: DashboardOp[] = [{ op: "set", path: "views.0.theme", value: "midnight" }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  assertEquals((config as any).views[0].theme, "midnight");
});

Deno.test("applyDashboardOps — set on missing parent path errors", () => {
  const ops: DashboardOp[] = [{ op: "set", path: "views.5.title", value: "X" }];
  const { errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("does not exist"));
});

Deno.test("applyDashboardOps — set at array length appends", () => {
  const ops: DashboardOp[] = [{
    op: "set",
    path: "views.0.cards.2",
    value: { type: "markdown", content: "hi" },
  }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  assertEquals((config as any).views[0].cards.length, 3);
  assertEquals((config as any).views[0].cards[2].type, "markdown");
});

Deno.test("applyDashboardOps — set past array length errors (no holes)", () => {
  const ops: DashboardOp[] = [{
    op: "set",
    path: "views.0.cards.10",
    value: { type: "markdown" },
  }];
  const { errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("out of range"));
});

Deno.test("applyDashboardOps — delete removes object key", () => {
  const ops: DashboardOp[] = [{ op: "delete", path: "views.0.title" }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  assertEquals((config as any).views[0].title, undefined);
  assertEquals("title" in (config as any).views[0], false);
});

Deno.test("applyDashboardOps — delete splices array element", () => {
  const ops: DashboardOp[] = [{ op: "delete", path: "views.0.cards.0" }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  // First card was the entities card; should now be the weather card at index 0.
  assertEquals((config as any).views[0].cards.length, 1);
  assertEquals((config as any).views[0].cards[0].type, "weather-forecast");
});

Deno.test("applyDashboardOps — delete missing key errors", () => {
  const ops: DashboardOp[] = [{ op: "delete", path: "views.0.nonexistent" }];
  const { errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("not present"));
});

Deno.test("applyDashboardOps — insert appends to array by default", () => {
  const ops: DashboardOp[] = [{
    op: "insert",
    path: "views.0.cards",
    value: { type: "button" },
  }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  const cards = (config as any).views[0].cards;
  assertEquals(cards.length, 3);
  assertEquals(cards[2].type, "button");
});

Deno.test("applyDashboardOps — insert at explicit index", () => {
  const ops: DashboardOp[] = [{
    op: "insert",
    path: "views.0.cards",
    value: { type: "button" },
    index: 1,
  }];
  const { config, errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors, []);
  const cards = (config as any).views[0].cards;
  assertEquals(cards.map((c: any) => c.type), ["entities", "button", "weather-forecast"]);
});

Deno.test("applyDashboardOps — insert into non-array errors", () => {
  const ops: DashboardOp[] = [{
    op: "insert",
    path: "views.0.title",
    value: "x",
  }];
  const { errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("not an array"));
});

Deno.test("applyDashboardOps — multiple ops apply in order, leave original config untouched", () => {
  const original = sampleConfig();
  const ops: DashboardOp[] = [
    { op: "set", path: "views.0.title", value: "Living Room" },
    { op: "insert", path: "views.0.cards", value: { type: "markdown" }, index: 0 },
    { op: "delete", path: "views.1" }, // also test array-element delete
  ];
  const { config, errors } = applyDashboardOps(original, ops);
  assertEquals(errors, []);
  // original mutated? No — applyDashboardOps clones before applying.
  assertEquals(original.views[0].title, "Overview");
  assertEquals(original.views.length, 2);
  // result has the cumulative effect.
  const result = config as any;
  assertEquals(result.views[0].title, "Living Room");
  assertEquals(result.views[0].cards[0].type, "markdown");
  assertEquals(result.views.length, 1);
});

Deno.test("applyDashboardOps — collects errors instead of throwing; first failure does not block subsequent op evaluation", () => {
  const ops: DashboardOp[] = [
    { op: "set", path: "views.99.title", value: "Bad" },          // invalid
    { op: "set", path: "views.0.title", value: "Living Room" },   // valid
  ];
  const { errors } = applyDashboardOps(sampleConfig(), ops);
  assertEquals(errors.length, 1);
  assert(errors[0].startsWith("op[0]"));
});

Deno.test("walkPath still works after the new helpers landed alongside", () => {
  // Sanity check that the existing dashboard-summary path traversal didn't regress.
  const r = walkPath(sampleConfig(), "views.0.cards.0.entities.0");
  assertEquals(r.found, true);
  assertEquals(r.value, "light.kitchen");
});
