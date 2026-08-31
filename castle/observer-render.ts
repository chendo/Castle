// Renders an EventBatch into the prompt text an observer pass reads.
//
// Pure: no clock, no HA, no I/O. That keeps the exact bytes the model sees
// under test, which matters more here than usual — this text *is* the
// observer's evidence, and every regression in it shows up as a worse
// observation rather than a stack trace.
//
// Three shaping decisions, all in service of latency:
//
//  - Grouped by kind with a fixed section order, so the model can skim rather
//    than parse a chronological interleave.
//  - Entity ids, not friendly names. The system prompt already carries the
//    catalog that maps one to the other, and ids are what every tool call and
//    every observation must cite. Names would be duplicated tokens that also
//    invite the model to cite something uncallable.
//  - Hard byte cap, cutting whole lines and saying how many went. A truncated
//    final line would be indistinguishable from a real entity id.

import type { EventBatch } from "./observer-events.ts";
import { domainOf } from "./observer-events.ts";

/** Matches the tool-output budget the observer runs with; a batch that
 *  outgrows this is a sample, and the footer says so. */
const MAX_BYTES = 4 * 1024;
/** Held back from the line budget so the "this is a sample" footer — the whole
 *  point of which is to be there when we ran out of room — always fits. */
const FOOTER_RESERVE = 128;

const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

function clock(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(ts));
  } catch {
    // An unknown/garbage tz from HA's config shouldn't cost us the whole batch.
    return new Date(ts).toISOString().slice(11, 19);
  }
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
}

/** Pad so the entity-id column lines up, but never truncate an id. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

interface Section {
  title: string;
  lines: string[];
}

function buildSections(batch: EventBatch, tz: string): Section[] {
  const automations: string[] = [];
  const health: string[] = [];
  const manual: string[] = [];
  const other: string[] = [];

  // An automation firing repeatedly inside one window is a signal in itself
  // ("fires 40x/day"), so annotate the repeats rather than making the model
  // count lines.
  const fireCounts = new Map<string, number>();
  for (const e of batch.events) {
    if (e.kind === "automation_triggered") {
      fireCounts.set(e.entityId, (fireCounts.get(e.entityId) ?? 0) + 1);
    }
  }
  const seenFires = new Map<string, number>();

  const width = Math.min(
    38,
    Math.max(24, ...batch.events.map((e) => e.entityId.length)),
  );

  for (const e of batch.events) {
    const at = clock(e.ts, tz);
    switch (e.kind) {
      case "automation_triggered":
      case "script_started": {
        const n = (seenFires.get(e.entityId) ?? 0) + 1;
        seenFires.set(e.entityId, n);
        const total = fireCounts.get(e.entityId) ?? 1;
        const repeat = e.kind === "automation_triggered" && total > 1 ? `  (fire ${n} of ${total})` : "";
        const verb = e.kind === "automation_triggered" ? "triggered" : "started";
        automations.push(`  ${at}  ${pad(e.entityId, width)} ${verb}  "${e.name}"${repeat}`);
        break;
      }
      case "unavailable":
        health.push(`  ${at}  ${pad(e.entityId, width)} -> unavailable  (was ${e.from})`);
        break;
      case "recovered":
        health.push(
          `  ${at}  ${pad(e.entityId, width)} -> ${e.to}  recovered after ${humanDuration(e.downForMs)}`,
        );
        break;
      case "transition": {
        const line = `  ${at}  ${pad(e.entityId, width)} ${e.from} -> ${e.to}`;
        if (e.cause === "manual") manual.push(line);
        else other.push(`${line}${e.cause === "automated" ? "  (by automation)" : ""}`);
        break;
      }
    }
  }

  // Suppression counts ride in their own section rather than annotating the
  // one surviving line, because the entity that got suppressed hardest is
  // often not in `events` at all after the per-entity cap.
  const suppressed: string[] = [];
  for (const [entityId, n] of [...batch.suppressed].sort((a, b) => b[1] - a[1])) {
    const window = domainOf(entityId) === "binary_sensor" ? "30s" : "5s";
    suppressed.push(`  ${pad(entityId, width)} +${n} more within the ${window} cooldown`);
  }

  return [
    { title: "AUTOMATIONS / SCRIPTS FIRED", lines: automations },
    { title: "UNAVAILABLE / RECOVERED", lines: health },
    { title: "MANUAL (a person did this)", lines: manual },
    { title: "AUTOMATED / DEVICE", lines: other },
    { title: "REPEATED (suppressed, count only)", lines: suppressed },
  ].filter((s) => s.lines.length > 0);
}

/**
 * Render a batch for the prompt, or null when there is nothing to say.
 *
 * Returning null rather than an empty string is load-bearing: it is what makes
 * "an empty batch can never trigger a pass" a property of the type rather than
 * a rule the scheduler has to remember.
 */
export function renderBatch(batch: EventBatch, timeZone = "UTC"): string | null {
  if (batch.events.length === 0) return null;

  const span = humanDuration(Math.max(0, batch.windowEnd - batch.windowStart));
  const header = `${batch.events.length} events over ${span} ` +
    `(${clock(batch.windowStart, timeZone)} - ${clock(batch.windowEnd, timeZone)}, ${timeZone})`;

  const sections = buildSections(batch, timeZone);

  const budget = MAX_BYTES - FOOTER_RESERVE;
  const out: string[] = [header];
  let used = byteLen(header) + 1;
  let elided = 0;
  let capped = false;

  for (const section of sections) {
    const title = `\n${section.title}`;
    // Don't spend the budget on a heading whose rows won't fit under it.
    if (capped || used + byteLen(title) + byteLen(section.lines[0]) + 2 > budget) {
      elided += section.lines.length;
      capped = true;
      continue;
    }
    out.push(title);
    used += byteLen(title) + 1;
    for (const line of section.lines) {
      const cost = byteLen(line) + 1;
      if (used + cost > budget) {
        elided++;
        capped = true;
        continue;
      }
      out.push(line);
      used += cost;
    }
  }

  if (batch.dropped > 0 || elided > 0) {
    const parts: string[] = [];
    if (elided > 0) parts.push(`${elided} lines cut to fit`);
    if (batch.dropped > 0) parts.push(`${batch.dropped} events lost to the buffer cap`);
    out.push(`\n[${parts.join("; ")} — this is a sample, not everything that happened]`);
  }

  return out.join("\n");
}
