// Per-pass prompt assembly. Pure functions returning strings, so what the
// model is asked stays under test.
//
// Standing rules (observation mode, "silence is expected", token discipline)
// live in the observer's system prompt, not here — they must survive context
// compaction. This file carries only what changes per pass: the job for *this*
// kind of pass, the evidence, the memory block, and what is already open.

import type { ObserverSettings } from "./settings.ts";
import type { Observation, PassKind } from "./observer-store.ts";

/** Tool-call budget per pass. Not chat's runaway cap of 50 — this is a
 *  spending limit, and the observer is supposed to be quick. */
export const TOOL_BUDGET: Record<PassKind, number> = {
  reactive: 8,
  heartbeat: 6,
  review: 12,
};

function jobFor(kind: PassKind, scope: ObserverSettings["scope"]): string[] {
  const jobs: string[] = [];
  if (kind === "reactive") {
    if (scope.automationHealth) {
      jobs.push(
        "Automations that fired but did not achieve their effect, or fired far more often " +
          "than makes sense. You can see that an automation fired and what did or did not " +
          "change after it; you cannot see its trace. Report the symptom, do not guess the cause.",
      );
    }
    if (scope.deviceHealth) {
      jobs.push("Entities that went unavailable and have not recovered, or that are flapping.");
    }
    if (scope.suggestions) {
      jobs.push(
        "Anything in the batch that clearly warrants a mitigation — do it via perform_action.",
      );
    }
    jobs.push(
      "Security-relevant events: a door, window or motion sensor firing when nobody is home, " +
        "after dark, or at an hour that does not fit the household. You may take ONE camera " +
        "snapshot, and only when a specific event makes a specific camera worth looking at. " +
        "Describe only what you can actually see; if the image is dark, empty or unclear, say " +
        "so and stop. Never infer a person from an event alone.",
    );
    jobs.push(
      "NOT your job this pass: long-term habits or new automation ideas. The daily review " +
        "pass does those.",
    );
  } else if (kind === "heartbeat") {
    jobs.push(
      "This is a periodic health sweep, not an event response. Look at what is currently " +
        "broken or degraded and has stayed that way.",
    );
    if (scope.deviceHealth) {
      jobs.push("Entities that have been unavailable for a long time, or stopped updating.");
    }
    jobs.push("NOT your job this pass: individual events, habits, or automation ideas.");
  } else {
    jobs.push(
      "This is the periodic review. You are looking at weeks of behaviour, not an incident.",
    );
    if (scope.automationGaps) {
      jobs.push(
        "Repeated manual actions worth automating. The timing statistics below are computed " +
          "for you — use them, do not re-derive them. A pattern with no consistent time is not " +
          "a candidate for a time-triggered automation. If an automation already covers the " +
          "entity, say what is missing rather than proposing a duplicate.",
      );
    }
    jobs.push(
      "Anything chronically wrong that a single pass would not notice — something that has " +
        "been degraded for weeks.",
    );
    jobs.push("NOT your job this pass: reacting to individual events.");
  }
  return jobs;
}

function renderOpen(open: Observation[]): string | null {
  if (open.length === 0) return null;
  const lines = ["Already open — do NOT raise these again:"];
  for (const o of open.slice(0, 20)) {
    const what = o.body.type === "concern"
      ? o.body.summary
      : `would ${o.body.args.domain}.${o.body.args.service} ${o.body.args.entity_id ?? ""}`.trim();
    const seen = o.occurrences > 1 ? ` (seen ${o.occurrences}x)` : "";
    lines.push(`  ${o.id} [${o.body.type}] ${what}${seen}`);
  }
  return lines.join("\n");
}

export interface PassPromptInput {
  kind: PassKind;
  passId: string;
  /** Rendered event batch (reactive), health line (heartbeat), or pattern
   *  rollup (review). Null means there is nothing to look at. */
  evidence: string | null;
  memory: string | null;
  open: Observation[];
  scope: ObserverSettings["scope"];
}

/**
 * Build the pass prompt, or null when there is no evidence — which is what
 * makes "an empty window can never cost an LLM turn" structural rather than a
 * rule the scheduler has to remember.
 */
export function buildPassPrompt(input: PassPromptInput): string | null {
  if (!input.evidence) return null;

  const sections: string[] = [];
  sections.push(
    `Pass: ${input.kind} (${input.passId}). Budget: ${TOOL_BUDGET[input.kind]} tool calls, 90 seconds.`,
  );
  sections.push(
    "Your job for THIS pass, in priority order:\n" +
      jobFor(input.kind, input.scope).map((j, i) => `${i + 1}. ${j}`).join("\n"),
  );
  if (input.memory) {
    sections.push(`What you know about this household:\n${input.memory}`);
  }
  sections.push(input.evidence);
  const open = renderOpen(input.open);
  if (open) sections.push(open);
  sections.push(
    "Be terse. No preamble, no restating the above. If nothing warrants attention, " +
      "call no tools and reply with the single word: none",
  );
  return sections.join("\n\n");
}

/** Heartbeat evidence: what is broken right now, computed server-side. Null
 *  when the house is healthy, so a healthy house costs nothing. */
export function renderHealthSummary(
  unavailable: Array<{ entityId: string; sinceMs: number }>,
  now: number,
): string | null {
  if (unavailable.length === 0) return null;
  const lines = [`${unavailable.length} entities are currently unavailable or unknown:`];
  const sorted = [...unavailable].sort((a, b) => a.sinceMs - b.sinceMs);
  for (const u of sorted.slice(0, 40)) {
    const hours = Math.floor((now - u.sinceMs) / 3_600_000);
    const age = hours >= 24 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${hours}h` : "<1h";
    lines.push(`  ${u.entityId}  (for ${age})`);
  }
  if (sorted.length > 40) lines.push(`  ... and ${sorted.length - 40} more`);
  return lines.join("\n");
}
