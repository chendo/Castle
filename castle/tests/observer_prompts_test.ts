import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildPassPrompt, renderHealthSummary, TOOL_BUDGET } from "../observer-prompts.ts";
import type { Observation } from "../observer-store.ts";
import { OBSERVER_DEFAULTS } from "../settings.ts";

const SCOPE = OBSERVER_DEFAULTS.scope;
const NOW = Date.parse("2026-08-31T18:00:00Z");

function base(overrides: Partial<Parameters<typeof buildPassPrompt>[0]> = {}) {
  return {
    kind: "reactive" as const,
    passId: "pass_x",
    evidence: "3 events over 1m\n  18:00:00 light.a off -> on",
    memory: null,
    open: [] as Observation[],
    scope: SCOPE,
    ...overrides,
  };
}

Deno.test("buildPassPrompt — no evidence means no prompt, so no LLM turn", () => {
  // Structural: an empty window cannot cost a turn, rather than the scheduler
  // having to remember not to fire one.
  assertEquals(buildPassPrompt(base({ evidence: null })), null);
});

Deno.test("buildPassPrompt — states the pass id and budget", () => {
  const p = buildPassPrompt(base())!;
  assertStringIncludes(p, "pass_x");
  assertStringIncludes(p, `${TOOL_BUDGET.reactive} tool calls`);
});

Deno.test("buildPassPrompt — always ends with the silence instruction", () => {
  const p = buildPassPrompt(base())!;
  assertStringIncludes(p, "reply with the single word: none");
});

Deno.test("buildPassPrompt — reactive is told not to do the review pass's job", () => {
  const p = buildPassPrompt(base())!;
  assertStringIncludes(p, "NOT your job this pass: long-term habits");
});

Deno.test("buildPassPrompt — review is told not to react to individual events", () => {
  const p = buildPassPrompt(base({ kind: "review" }))!;
  assertStringIncludes(p, "NOT your job this pass: reacting to individual events");
  assertStringIncludes(p, "computed for you");
});

Deno.test("buildPassPrompt — heartbeat is scoped to standing faults", () => {
  const p = buildPassPrompt(base({ kind: "heartbeat" }))!;
  assertStringIncludes(p, "periodic health sweep");
  assertStringIncludes(p, "NOT your job this pass: individual events");
});

Deno.test("buildPassPrompt — scope flags remove whole instruction blocks", () => {
  const withGaps = buildPassPrompt(base({ kind: "review", scope: SCOPE }))!;
  const without = buildPassPrompt(
    base({ kind: "review", scope: { ...SCOPE, automationGaps: false } }),
  )!;
  assert(withGaps.includes("worth automating"));
  // Turning scope off is a prompt change, not a post-hoc filter, so it also
  // saves the tokens.
  assert(!without.includes("worth automating"));
  assert(without.length < withGaps.length);
});

Deno.test("buildPassPrompt — the camera rule is always present on reactive passes", () => {
  const p = buildPassPrompt(base())!;
  assertStringIncludes(p, "ONE camera snapshot");
  assertStringIncludes(p, "Never infer a person from an event alone");
});

Deno.test("buildPassPrompt — memory is included when present and omitted when not", () => {
  assert(!buildPassPrompt(base())!.includes("What you know about this household"));
  const p = buildPassPrompt(base({ memory: "## Household\n- [m_a] nobody home Tuesdays" }))!;
  assertStringIncludes(p, "What you know about this household");
  assertStringIncludes(p, "nobody home Tuesdays");
});

function obs(id: string, summary: string, occurrences = 1): Observation {
  return {
    id,
    createdAt: NOW,
    lastSeenAt: NOW,
    occurrences,
    pass: { id: "p", kind: "reactive", startedAt: NOW, durationMs: 1, toolCalls: 0 },
    fingerprint: "sha256:x",
    status: "open",
    body: { type: "concern", severity: "warn", summary, entities: ["light.a"] },
  };
}

Deno.test("buildPassPrompt — open findings are listed so they are not re-raised", () => {
  const p = buildPassPrompt(base({ open: [obs("obs_1", "porch light unavailable", 7)] }))!;
  assertStringIncludes(p, "Already open");
  assertStringIncludes(p, "obs_1");
  assertStringIncludes(p, "seen 7x");
});

Deno.test("buildPassPrompt — the open list is capped so it cannot dominate", () => {
  const open = Array.from({ length: 40 }, (_, i) => obs(`obs_${i}`, `finding ${i}`));
  const p = buildPassPrompt(base({ open }))!;
  assert(p.includes("obs_19"));
  assert(!p.includes("obs_25"));
});

Deno.test("buildPassPrompt — an open proposal is described as an action, not a summary", () => {
  const proposal: Observation = {
    ...obs("obs_p", "unused"),
    body: {
      type: "proposal",
      tool: "ha_call_service",
      args: { domain: "light", service: "turn_off", entity_id: "light.garage" },
      reason: "on 4h",
      entities: ["light.garage"],
    },
  };
  const p = buildPassPrompt(base({ open: [proposal] }))!;
  assertStringIncludes(p, "would light.turn_off light.garage");
});

// --- heartbeat evidence -----------------------------------------------------

Deno.test("renderHealthSummary — a healthy house costs nothing", () => {
  assertEquals(renderHealthSummary([], NOW), null);
});

Deno.test("renderHealthSummary — lists what is down and for how long", () => {
  const out = renderHealthSummary([
    { entityId: "sensor.garage", sinceMs: NOW - 3 * 3_600_000 },
    { entityId: "light.shed", sinceMs: NOW - 50 * 3_600_000 },
  ], NOW)!;
  assertStringIncludes(out, "2 entities have gone unavailable");
  assertStringIncludes(out, "sensor.garage  (for 3h)");
  assertStringIncludes(out, "light.shed  (for 2d)");
});

Deno.test("renderHealthSummary — a house with only chronic faults costs nothing", () => {
  // Observed on a real install: 305 unavailable entities, nearly all from
  // devices removed a month ago. Reporting that every 30 minutes is noise and
  // would crowd out the thing that actually broke this morning.
  const dead = Array.from({ length: 305 }, (_, i) => ({
    entityId: `sensor.removed_${i}`,
    sinceMs: NOW - 30 * 24 * 3_600_000,
  }));
  assertEquals(renderHealthSummary(dead, NOW), null);
});

Deno.test("renderHealthSummary — chronic faults are counted, not listed", () => {
  const out = renderHealthSummary([
    { entityId: "sensor.broke_today", sinceMs: NOW - 2 * 3_600_000 },
    ...Array.from({ length: 40 }, (_, i) => ({
      entityId: `sensor.long_gone_${i}`,
      sinceMs: NOW - 30 * 24 * 3_600_000,
    })),
  ], NOW)!;
  assertStringIncludes(out, "sensor.broke_today");
  assert(!out.includes("sensor.long_gone_0"), "chronic entities must not be listed");
  assertStringIncludes(out, "40 further entities have been down for over a week");
});

Deno.test("renderHealthSummary — longest-down first, and the list is capped", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    entityId: `sensor.s${i}`,
    sinceMs: NOW - (60 - i) * 3_600_000,
  }));
  const out = renderHealthSummary(many, NOW)!;
  // s0 has been down longest, so it leads; s39 is past the cap and absent.
  assert(out.indexOf("sensor.s0") < out.indexOf("sensor.s10"));
  assert(!out.includes("sensor.s39"));
  assertStringIncludes(out, "and 35 more");
});
