import { Type } from "npm:@sinclair/typebox";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import type { HAClient } from "./ha-client.ts";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type TruncationInfo = {
  bytes_elided: number;
  total_bytes: number;
  items_elided?: number;
  total_items?: number;
  hint?: string;
};
type ToolResult = { content: ToolContent[]; details: Record<string, unknown> };

const BYTES_PER_KB = 1024;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function fmtKB(bytes: number): string {
  return bytes < BYTES_PER_KB ? `${bytes}B` : `${(bytes / BYTES_PER_KB).toFixed(1)}kB`;
}

function withTruncationFooter(text: string, info: TruncationInfo): string {
  const parts: string[] = [];
  if (info.items_elided && info.total_items) {
    parts.push(`${info.total_items - info.items_elided} of ${info.total_items} items shown`);
  }
  parts.push(`${fmtKB(info.bytes_elided)} elided of ${fmtKB(info.total_bytes)} total`);
  if (info.hint) parts.push(info.hint);
  return `${text}\n\n[truncated: ${parts.join(" — ")}]`;
}

/**
 * Plain-text response. Truncates at the last newline that fits inside maxBytes,
 * appends a footer naming the byte count cut, and surfaces the same info on
 * `details.truncated` so the renderer can show a warning badge.
 */
export function okText(text: string, opts: { maxBytes?: number; details?: Record<string, unknown>; hint?: string } = {}): ToolResult {
  const max = opts.maxBytes ?? 8 * BYTES_PER_KB;
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= max) {
    return { content: [{ type: "text", text }], details: opts.details ?? {} };
  }
  // Walk back from `max` to the previous newline so we don't cut mid-line.
  // (Approximation: most strings here are ASCII so byte ≈ char; for multibyte
  // we may stop slightly under max, which is fine.)
  let cutoff = max;
  const newlineIdx = text.lastIndexOf("\n", cutoff);
  if (newlineIdx > max / 2) cutoff = newlineIdx;
  const head = text.slice(0, cutoff);
  const info: TruncationInfo = {
    bytes_elided: totalBytes - utf8Bytes(head),
    total_bytes: totalBytes,
    hint: opts.hint,
  };
  return {
    content: [{ type: "text", text: withTruncationFooter(head, info) }],
    details: { ...(opts.details ?? {}), truncated: info },
  };
}

/**
 * List of items joined by `\n` (or custom separator). Cuts whole items, never
 * mid-item. Reports both byte and item counts in the footer/details.
 */
export function okList(
  header: string,
  items: string[],
  opts: { maxBytes?: number; separator?: string; details?: Record<string, unknown>; hint?: string } = {},
): ToolResult {
  const max = opts.maxBytes ?? 8 * BYTES_PER_KB;
  const sep = opts.separator ?? "\n";
  const headerBytes = utf8Bytes(header ? header + sep : "");

  let used = headerBytes;
  let kept = 0;
  for (const item of items) {
    const cost = utf8Bytes(item) + (kept > 0 ? sep.length : 0);
    if (used + cost > max) break;
    used += cost;
    kept++;
  }

  const fullText = (header ? header + sep : "") + items.join(sep);
  const totalBytes = utf8Bytes(fullText);
  if (kept === items.length) {
    return { content: [{ type: "text", text: fullText }], details: opts.details ?? {} };
  }
  const head = (header ? header + sep : "") + items.slice(0, kept).join(sep);
  const info: TruncationInfo = {
    bytes_elided: totalBytes - utf8Bytes(head),
    total_bytes: totalBytes,
    items_elided: items.length - kept,
    total_items: items.length,
    hint: opts.hint,
  };
  return {
    content: [{ type: "text", text: withTruncationFooter(head, info) }],
    details: { ...(opts.details ?? {}), truncated: info },
  };
}

// Backwards-compatible default: existing call sites that just used `ok(text)`
// keep working but now get a much higher cap (8kB) and a real truncation
// footer instead of silent slice. New code should prefer okText/okList.
function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return okText(text, { details });
}

// Cache HA timezone once per session
let cachedTimezone: string | null = null;

async function getHATimezone(ha: HAClient): Promise<string> {
  if (cachedTimezone) return cachedTimezone;
  try {
    const states = ha.getAllStates();
    const haEntity = states.find(s => s.entity_id === "homeassistant");
    if (haEntity?.attributes?.time_zone) {
      cachedTimezone = haEntity.attributes.time_zone as string;
      return cachedTimezone;
    }
  } catch { /* fall through to config API */ }
  // Fallback: try config API
  try {
    const tz = await ha.call<{ time_zone: string }>({ type: "get_config" });
    if (tz?.time_zone) {
      cachedTimezone = tz.time_zone;
      return cachedTimezone;
    }
  } catch { /* fall through to system tz */ }
  cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return cachedTimezone;
}

function formatTimestamp(iso: string, tz: string): string {
  return formatYMDHM(new Date(iso), tz);
}

// Pull individual time parts in HA's timezone via Intl, so we get an
// unambiguous YYYY-MM-DD HH:MM[:SS] regardless of the runtime's locale.
function tzParts(date: Date, tz: string, includeSeconds: boolean): {
  year: string; month: string; day: string; hour: string; minute: string; second: string;
} {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (includeSeconds) opts.second = "2-digit";
  const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Intl with `hour12:false` can return "24" for midnight in some locales; normalise.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** YYYY-MM-DD HH:MM in HA's timezone. */
function formatYMDHM(date: Date, tz: string): string {
  const p = tzParts(date, tz, false);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD HH:MM:SS in HA's timezone. */
function formatYMDHMS(date: Date, tz: string): string {
  const p = tzParts(date, tz, true);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const ALLOWED_INTERVALS = [1, 5, 10, 15, 30, 60];

export function pickAutoInterval(durationMs: number): number {
  const hours = durationMs / 3_600_000;
  if (hours <= 2) return 5;
  if (hours <= 6) return 10;
  if (hours <= 12) return 15;
  if (hours <= 36) return 30;
  return 60;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface HistoryPoint { value: number; timestamp: Date; rawIso: string }
export interface StateChange { state: string; timestamp: Date; rawIso: string }

// Sentinels HA emits when a sensor is offline / starting up. They aren't real
// readings, so we exclude them from numeric-vs-state classification.
const STATE_SENTINELS = new Set(["unknown", "unavailable", "none", ""]);

export function isNumericState(s: string): boolean {
  if (STATE_SENTINELS.has(s)) return false;
  const n = parseFloat(s);
  return !isNaN(n) && isFinite(n);
}

/**
 * Parse HA history into ordered state changes. Accepts both the modern WS
 * shape ({ "<entity_id>": [{ s, lu, ... }] }) and the legacy REST shape
 * (array of per-entity arrays with `state` / `last_changed`). Returns every
 * recorded change — numeric or not — sorted chronologically.
 */
export function parseStateChanges(raw: unknown): StateChange[] {
  if (!raw || typeof raw !== "object") return [];

  let pointArrays: unknown[] = [];
  if (Array.isArray(raw)) pointArrays = raw;
  else pointArrays = Object.values(raw as Record<string, unknown>);

  const out: StateChange[] = [];
  for (const arr of pointArrays) {
    if (!Array.isArray(arr)) continue;
    for (const pt of arr) {
      if (typeof pt !== "object" || pt === null) continue;
      const p = pt as Record<string, unknown>;

      const stateRaw = p.s ?? p.state;
      let stateStr: string | undefined;
      if (typeof stateRaw === "string") stateStr = stateRaw;
      else if (typeof stateRaw === "number") stateStr = String(stateRaw);
      else if (typeof stateRaw === "boolean") stateStr = stateRaw ? "on" : "off";

      const tsRaw = p.lu ?? p.lc ?? p.last_updated ?? p.last_changed;
      let lcStr: string | undefined;
      if (typeof tsRaw === "string") lcStr = tsRaw;
      else if (typeof tsRaw === "number") lcStr = new Date(tsRaw * 1000).toISOString();
      else if (tsRaw instanceof Date) lcStr = tsRaw.toISOString();

      if (stateStr == null || !lcStr) continue;
      out.push({ state: stateStr, timestamp: new Date(lcStr), rawIso: lcStr });
    }
  }
  out.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return out;
}

/**
 * Decide whether a series should be summarised as numeric buckets or as
 * state-change events. Returns "numeric" when the bulk of valid (non-sentinel)
 * samples parse as finite numbers, else "state". `[]` returns "empty".
 */
export function classifyHistory(changes: StateChange[]): "numeric" | "state" | "empty" {
  if (changes.length === 0) return "empty";
  const valid = changes.filter((c) => !STATE_SENTINELS.has(c.state));
  if (valid.length === 0) return "state";
  const numeric = valid.filter((c) => isNumericState(c.state)).length;
  // 70% threshold: tolerate the occasional "unknown" mid-stream while still
  // catching truly categorical sensors (e.g. a string-valued select).
  return numeric / valid.length >= 0.7 ? "numeric" : "state";
}

export function parseHistoryPoints(raw: unknown): HistoryPoint[] | null {
  const changes = parseStateChanges(raw);
  const points: HistoryPoint[] = [];
  for (const c of changes) {
    if (!isNumericState(c.state)) continue;
    points.push({ value: parseFloat(c.state), timestamp: c.timestamp, rawIso: c.rawIso });
  }
  return points.length > 0 ? points : null;
}

export function computeStats(points: HistoryPoint[]): {
  min: number; max: number; avg: number; last: number; count: number;
  minAt: string; maxAt: string; trendDir: "rising" | "falling" | "stable"; trendDelta: number;
} {
  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const values = sorted.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const last = values[values.length - 1];
  const first = values[0];
  const trendDelta = last - first;

  let minPt = sorted[0], maxPt = sorted[0];
  for (const p of sorted) {
    if (p.value < minPt.value) minPt = p;
    if (p.value > maxPt.value) maxPt = p;
  }

  const absDelta = Math.abs(trendDelta);
  const range = max - min || 1;
  let trendDir: "rising" | "falling" | "stable";
  if (absDelta / range < 0.15) trendDir = "stable";
  else if (trendDelta > 0) trendDir = "rising";
  else trendDir = "falling";

  return { min, max, avg: Math.round(avg * 10) / 10, last, count: points.length, minAt: minPt.rawIso, maxAt: maxPt.rawIso, trendDir, trendDelta: Math.round(trendDelta * 10) / 10 };
}

export interface Bucket {
  start: Date;
  values: number[];
}

export function buildBuckets(points: HistoryPoint[], rangeStart: Date, rangeEnd: Date, intervalMs: number): Bucket[] {
  const buckets: Bucket[] = [];
  // Anchor the first bucket to rangeStart and step forward by intervalMs.
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += intervalMs) {
    buckets.push({ start: new Date(t), values: [] });
  }
  if (buckets.length === 0) return buckets;

  for (const p of points) {
    const offset = p.timestamp.getTime() - rangeStart.getTime();
    if (offset < 0) continue;
    const idx = Math.floor(offset / intervalMs);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].values.push(p.value);
    }
  }
  return buckets;
}

// Beyond this many state changes we collapse to one line per hour. Picked so a
// busy binary sensor (motion, door) over a day still fits comfortably.
export const STATE_CHANGE_PER_LINE_LIMIT = 60;

function formatHumanDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}min`;
}

/**
 * Render a state-change history (binary sensors, enums, anything non-numeric).
 * Sparse case: emit one line per transition with `prev → new` so the agent
 * sees the actual flip, not just "what state did it land on".
 * Dense case: hour-bucket and report only buckets with at least one transition,
 * so long quiet stretches collapse and the reader infers held state from the
 * gap. Skip-if-unchanged is implicit in the "≥1 transition" rule.
 */
export function formatStateChangeSummary(
  entityId: string,
  changes: StateChange[],
  rangeStart: Date,
  rangeEnd: Date,
  tz: string,
): string {
  const durationMs = rangeEnd.getTime() - rangeStart.getTime();

  // Collapse consecutive duplicates — HA usually only stores real transitions,
  // but `last_updated`-driven entries can repeat when only attributes changed.
  const compact: StateChange[] = [];
  for (const c of changes) {
    if (compact.length === 0 || compact[compact.length - 1].state !== c.state) {
      compact.push(c);
    }
  }

  const counts = new Map<string, number>();
  for (const c of compact) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const distribution = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}=${n}`)
    .join(" ");

  const lines: string[] = [];
  lines.push(entityId);
  const last = compact.length > 0 ? compact[compact.length - 1].state : "(none)";
  // `compact[0]` is the first change INSIDE the window. Its predecessor is
  // whatever state was active going into the window, which HA returns as the
  // first record in the raw response. We pluck that from the un-collapsed
  // changes list when present.
  const initialState = changes.length > 0
    ? changes[0].state
    : "(unknown)";
  lines.push(
    `${formatYMDHM(rangeStart, tz)} → ${formatYMDHM(rangeEnd, tz)} (${formatHumanDuration(durationMs)}, ${compact.length - 1 < 0 ? 0 : compact.length - 1} transitions, last=${last})`,
  );
  lines.push("");
  if (distribution) {
    lines.push(`Distribution: ${distribution}`);
    lines.push("");
  }

  if (compact.length === 0) return lines.join("\n");

  // Sparse: one line per transition.
  // The "transitions" the agent cares about are state[i-1] → state[i] for
  // i >= 1 within `compact`. compact[0] is the entering state — already
  // surfaced via the header — so we don't emit a row for it.
  const transitionCount = Math.max(0, compact.length - 1);

  if (transitionCount === 0) {
    lines.push(`(no transitions in window; held at ${initialState} throughout)`);
    return lines.join("\n");
  }

  if (transitionCount <= STATE_CHANGE_PER_LINE_LIMIT) {
    for (let i = 1; i < compact.length; i++) {
      const prev = compact[i - 1].state;
      const cur = compact[i];
      lines.push(`${formatYMDHMS(cur.timestamp, tz)} ${prev} → ${cur.state}`);
    }
    return lines.join("\n");
  }

  // Dense: hour-bucket. Insertion order of the Map matches chronological order
  // because `compact` is sorted ascending and we only insert on first sighting.
  lines.push(`(many transitions — hour-bucketed; only hours with ≥1 transition shown, gaps mean state held)`);
  type Bucket = { startMs: number; bucketStart: Date; count: number; ending: string };
  const buckets = new Map<string, Bucket>();
  // Walk transitions (i >= 1). Each transition belongs to the hour of cur.
  for (let i = 1; i < compact.length; i++) {
    const cur = compact[i];
    const p = tzParts(cur.timestamp, tz, false);
    const key = `${p.year}-${p.month}-${p.day}T${p.hour}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
      existing.ending = cur.state;
    } else {
      // Truncate to the start of the hour for the displayed timestamp.
      const startDate = new Date(cur.timestamp);
      startDate.setUTCMilliseconds(0); startDate.setUTCSeconds(0); startDate.setUTCMinutes(0);
      // Note: setUTCMinutes(0) is approximate when tz != UTC, but the displayed
      // string comes back through tzParts so it's still correct in HA's tz.
      buckets.set(key, { startMs: startDate.getTime(), bucketStart: startDate, count: 1, ending: cur.state });
    }
  }
  for (const b of buckets.values()) {
    const startStr = formatYMDHM(b.bucketStart, tz);
    // Bucket end = bucketStart + 1h, formatted as HH:MM only (date already on the start).
    const endDate = new Date(b.bucketStart.getTime() + 60 * 60_000);
    const endParts = tzParts(endDate, tz, false);
    const endStr = `${endParts.hour}:${endParts.minute}`;
    lines.push(`${startStr}–${endStr}  ${b.count} change${b.count === 1 ? "" : "s"}, ended ${b.ending}`);
  }
  return lines.join("\n");
}

/**
 * Detect contiguous stretches in `changes` whose state matches `predicate`.
 * Used to surface "Unavailable: 14:50–15:05 (15min)" lines in the numeric
 * header, since sentinel periods are otherwise invisible once we drop them
 * from the numeric points.
 */
function findSentinelStretches(
  changes: StateChange[],
  rangeStart: Date,
  rangeEnd: Date,
  predicate: (state: string) => boolean,
): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  let activeStart: Date | null = null;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.timestamp.getTime() < rangeStart.getTime()) continue;
    if (c.timestamp.getTime() >= rangeEnd.getTime()) break;
    if (predicate(c.state)) {
      if (activeStart === null) activeStart = c.timestamp;
    } else {
      if (activeStart !== null) {
        out.push({ start: activeStart, end: c.timestamp });
        activeStart = null;
      }
    }
  }
  if (activeStart !== null) out.push({ start: activeStart, end: rangeEnd });
  return out;
}

function summariseStretches(stretches: Array<{ start: Date; end: Date }>, tz: string): string {
  return stretches.map((s) => {
    const ms = s.end.getTime() - s.start.getTime();
    return `${formatYMDHM(s.start, tz)}–${formatYMDHM(s.end, tz)} (${formatHumanDuration(ms)})`;
  }).join(", ");
}

export function formatHistorySummary(
  entityId: string,
  points: HistoryPoint[],
  changes: StateChange[],
  rangeStart: Date,
  rangeEnd: Date,
  intervalMin: number,
  tz: string,
): string {
  const durationMs = rangeEnd.getTime() - rangeStart.getTime();
  const intervalMs = intervalMin * 60_000;
  const numericBuckets = buildBuckets(points, rangeStart, rangeEnd, intervalMs);

  // Sentinel buckets — buckets whose period contained at least one
  // unavailable / unknown event. Computed in parallel so we can mark a bucket
  // as `unavail` / `unknown` instead of `_`.
  const unavailBuckets = new Set<number>();
  const unknownBuckets = new Set<number>();
  for (const c of changes) {
    if (c.timestamp.getTime() < rangeStart.getTime()) continue;
    if (c.timestamp.getTime() >= rangeEnd.getTime()) continue;
    const idx = Math.floor((c.timestamp.getTime() - rangeStart.getTime()) / intervalMs);
    if (c.state === "unavailable") unavailBuckets.add(idx);
    else if (c.state === "unknown") unknownBuckets.add(idx);
  }

  const stats = computeStats(points);
  const lines: string[] = [];

  lines.push(`${entityId}`);
  lines.push(`${formatYMDHM(rangeStart, tz)} → ${formatYMDHM(rangeEnd, tz)} (${formatHumanDuration(durationMs)} @ ${intervalMin}min, ${numericBuckets.length} buckets, ${stats.count} samples)`);
  lines.push(`Stats: min=${stats.min} max=${stats.max} avg=${stats.avg} last=${stats.last} ${stats.trendDelta >= 0 ? "+" : ""}${stats.trendDelta} (${stats.trendDir})`);

  const unavailStretches = findSentinelStretches(changes, rangeStart, rangeEnd, (s) => s === "unavailable");
  const unknownStretches = findSentinelStretches(changes, rangeStart, rangeEnd, (s) => s === "unknown");
  if (unavailStretches.length > 0) lines.push(`Unavailable: ${summariseStretches(unavailStretches, tz)}`);
  if (unknownStretches.length > 0) lines.push(`Unknown: ${summariseStretches(unknownStretches, tz)}`);
  lines.push("");

  // Render each bucket; collapse runs of identical values by skipping any
  // bucket whose rendered string matches the previously-emitted one. The
  // agent infers "value held since last shown timestamp."
  let lastEmitted: string | null = null;
  for (let i = 0; i < numericBuckets.length; i++) {
    const b = numericBuckets[i];
    let value: string;
    if (b.values.length === 0) {
      if (unavailBuckets.has(i)) value = "unavail";
      else if (unknownBuckets.has(i)) value = "unknown";
      else value = "_";
    } else {
      const min = round1(Math.min(...b.values));
      const max = round1(Math.max(...b.values));
      if (min === max) {
        value = String(min);
      } else {
        const avg = round1(b.values.reduce((s, v) => s + v, 0) / b.values.length);
        value = `${min}–${max}, avg ${avg}`;
      }
    }
    if (value === lastEmitted) continue;
    lines.push(`${formatYMDHM(b.start, tz)}=${value}`);
    lastEmitted = value;
  }
  return lines.join("\n");
}

function splitPath(path: string): string[] {
  return path.split(".").filter((s) => s.length > 0);
}

/**
 * Walk to the PARENT of `path` and return that parent plus the final key.
 * Used by set/delete to address a leaf inside a container.
 *
 * Returns null when the path is empty or the parent doesn't exist.
 */
// deno-lint-ignore no-explicit-any
export function walkToParent(root: any, path: string): { parent: any; key: string } | null {
  const segs = splitPath(path);
  if (segs.length === 0) return null;
  const key = segs[segs.length - 1];
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur == null || typeof cur !== "object") return null;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
    } else {
      if (!(seg in cur)) return null;
      cur = cur[seg];
    }
  }
  return { parent: cur, key };
}

/** A single mutation against a dashboard config tree. */
export type DashboardOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "delete"; path: string }
  | { op: "insert"; path: string; value: unknown; index?: number };

/**
 * Apply one op in place. Throws Error with a path-prefixed message on
 * any failure. Callers should pre-clone if they want atomicity across
 * multiple ops; applyDashboardOps does this for them.
 */
function applyOp(root: unknown, op: DashboardOp): void {
  if (op.op === "set") {
    const target = walkToParent(root, op.path);
    if (!target) throw new Error(`set: parent path "${parentPath(op.path)}" does not exist`);
    if (Array.isArray(target.parent)) {
      const idx = Number(target.key);
      if (!Number.isInteger(idx) || idx < 0) throw new Error(`set: array index "${target.key}" is not a non-negative integer`);
      // Allow setting at length to append; further out is rejected so we
      // don't silently grow arrays with holes.
      if (idx > target.parent.length) {
        throw new Error(`set: array index ${idx} out of range (length=${target.parent.length}); use 'insert' to append`);
      }
      target.parent[idx] = op.value;
    } else if (target.parent && typeof target.parent === "object") {
      (target.parent as Record<string, unknown>)[target.key] = op.value;
    } else {
      throw new Error(`set: parent path "${parentPath(op.path)}" is not an object/array`);
    }
    return;
  }
  if (op.op === "delete") {
    const target = walkToParent(root, op.path);
    if (!target) throw new Error(`delete: path "${op.path}" does not exist`);
    if (Array.isArray(target.parent)) {
      const idx = Number(target.key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= target.parent.length) {
        throw new Error(`delete: array index ${target.key} out of range (length=${target.parent.length})`);
      }
      target.parent.splice(idx, 1);
    } else if (target.parent && typeof target.parent === "object") {
      const obj = target.parent as Record<string, unknown>;
      if (!(target.key in obj)) throw new Error(`delete: key "${target.key}" not present at parent`);
      delete obj[target.key];
    } else {
      throw new Error(`delete: parent of "${op.path}" is not an object/array`);
    }
    return;
  }
  if (op.op === "insert") {
    // `path` points at the array itself (not a leaf). Walk and validate.
    const { value: arr, found } = walkPath(root, op.path);
    if (!found) throw new Error(`insert: path "${op.path}" does not exist`);
    if (!Array.isArray(arr)) throw new Error(`insert: path "${op.path}" is not an array`);
    const idx = op.index ?? arr.length;
    if (!Number.isInteger(idx) || idx < 0 || idx > arr.length) {
      throw new Error(`insert: index ${idx} out of range (length=${arr.length})`);
    }
    arr.splice(idx, 0, op.value);
    return;
  }
  // deno-lint-ignore no-explicit-any
  throw new Error(`unknown op: ${(op as any).op}`);
}

function parentPath(path: string): string {
  const segs = splitPath(path);
  return segs.slice(0, -1).join(".") || "(root)";
}

function truncateJson(v: unknown, max: number): string {
  const s = JSON.stringify(v, null, 2);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Render OpDiff[] as a human-readable verification block — one section per op,
 * showing before/after of the parent container so the agent can confirm the
 * mutation landed where intended. Each side is JSON-pretty-printed and
 * trimmed to keep the total response within tool-output budgets.
 */
export function formatDashboardDiffs(diffs: OpDiff[]): string {
  if (diffs.length === 0) return "(no diffs)";
  const PER_SIDE = 600; // bytes
  const lines: string[] = [];
  for (const d of diffs) {
    const opLabel = d.op.op === "insert"
      ? `insert ${d.op.path}${(d.op as { index?: number }).index !== undefined ? `@${(d.op as { index?: number }).index}` : ""}`
      : `${d.op.op} ${d.op.path}`;
    lines.push(`op[${d.index}] ${opLabel}  (parent: ${d.parentPath})`);
    lines.push("before:");
    lines.push(truncateJson(d.before, PER_SIDE));
    lines.push("after:");
    lines.push(truncateJson(d.after, PER_SIDE));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export interface OpDiff {
  index: number;
  op: DashboardOp;
  /** Path of the parent container the diff is rooted at — usually one level up from op.path. */
  parentPath: string;
  /** Snapshot of parentPath BEFORE this op (deep-cloned, captures effects of previous ops). */
  before: unknown;
  /** Snapshot of parentPath AFTER this op. */
  after: unknown;
}

/**
 * Apply a sequence of ops to a dashboard config. Returns a NEW config object
 * (deep-cloned before any mutation) so failures leave the original untouched.
 * Errors are returned in `errors` instead of thrown so the caller can surface
 * all problems at once. `diffs` carries a before/after snapshot of each op's
 * parent container so the agent (and the user) can verify what changed.
 */
export function applyDashboardOps(
  config: unknown,
  ops: DashboardOp[],
): { config: unknown; errors: string[]; diffs: OpDiff[] } {
  const cloned = JSON.parse(JSON.stringify(config));
  const errors: string[] = [];
  const diffs: OpDiff[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    // Per-op diff is rooted at the parent of the path. For insert the path
    // already points at the array, so "one level up" lands you at the
    // array's container — same containing scope a reader needs to verify
    // a card landed where they expected.
    const pp = parentPath(op.path);
    const beforeParent = snapshotAt(cloned, pp);
    try {
      applyOp(cloned, op);
      const afterParent = snapshotAt(cloned, pp);
      diffs.push({ index: i, op, parentPath: pp, before: beforeParent, after: afterParent });
    } catch (err) {
      errors.push(`op[${i}] (${op.op} ${("path" in op ? op.path : "")}): ${(err as Error).message}`);
    }
  }
  return { config: cloned, errors, diffs };
}

/** Walk to `path` and return a deep clone of the value, or null when missing. */
function snapshotAt(root: unknown, path: string): unknown {
  if (path === "(root)") return JSON.parse(JSON.stringify(root));
  const { value, found } = walkPath(root, path);
  if (!found) return null;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Walk a dot-separated path into a JSON tree. Numeric segments index arrays.
 * Returns { value, found } so callers can distinguish "missing" from "null".
 */
export function walkPath(root: unknown, path: string): { value: unknown; found: boolean } {
  if (!path) return { value: root, found: true };
  const segments = path.split(".").filter((s) => s.length > 0);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return { value: undefined, found: false };
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { value: undefined, found: false };
      cur = cur[idx];
    } else {
      const obj = cur as Record<string, unknown>;
      if (!(seg in obj)) return { value: undefined, found: false };
      cur = obj[seg];
    }
  }
  return { value: cur, found: true };
}

/**
 * Render a top-level dashboard config as a compact summary so the model can
 * navigate without dragging the whole tree into context. Lists each view's
 * title, path, and card / section / badge counts.
 *
 * Handles both layouts:
 *  - Legacy / "masonry" view: cards live at view.cards[]
 *  - Newer "sections" view: cards live at view.sections[].cards[]
 *
 * Both shapes are reported when present (rare but possible to mix).
 */
export function summarizeDashboard(config: unknown): string {
  if (config == null || typeof config !== "object") return JSON.stringify(config);
  const obj = config as Record<string, unknown>;
  const lines: string[] = [];
  const views = Array.isArray(obj.views) ? obj.views : null;
  if (views) {
    lines.push(`views (${views.length}):`);
    views.forEach((v, i) => {
      const view = v as Record<string, unknown>;
      const title = view.title ?? "(untitled)";
      const path = view.path ? ` [${view.path}]` : "";
      const directCards = Array.isArray(view.cards) ? view.cards.length : 0;
      const badges = Array.isArray(view.badges) ? view.badges.length : 0;
      const sections = Array.isArray(view.sections) ? view.sections : null;
      const sectionCards = sections
        ? sections.reduce((acc, s) => acc + (Array.isArray((s as Record<string, unknown>)?.cards) ? ((s as Record<string, unknown>).cards as unknown[]).length : 0), 0)
        : 0;

      const parts: string[] = [];
      if (sections) parts.push(`${sections.length} section${sections.length === 1 ? "" : "s"} (${sectionCards} card${sectionCards === 1 ? "" : "s"})`);
      if (directCards > 0) parts.push(`${directCards} card${directCards === 1 ? "" : "s"} top-level`);
      if (!sections && directCards === 0) parts.push("0 cards");
      if (badges > 0) parts.push(`${badges} badge${badges === 1 ? "" : "s"}`);

      lines.push(`  views.${i}${path}: "${title}" — ${parts.join(", ")}`);
    });
  }
  const topKeys = Object.keys(obj).filter((k) => k !== "views");
  if (topKeys.length > 0) {
    lines.push("");
    lines.push("other top-level keys:");
    for (const k of topKeys) {
      const v = obj[k];
      const sample = Array.isArray(v) ? `[${v.length} items]` : (v && typeof v === "object" ? `{${Object.keys(v).length} keys}` : JSON.stringify(v));
      lines.push(`  ${k}: ${sample}`);
    }
  }
  lines.push("");
  lines.push("To drill in, call again with `path=views.0` (or `views.0.sections.0.cards.3`, etc.).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stubbed dashboard drill-down renderer.
//
// At any drill path, render the value as JSON BUT collapse oversized child
// objects/arrays into one-line stub strings that include the drill path.
// Lets the agent walk N layers deep without dragging the whole subtree into
// context on every step.
// ---------------------------------------------------------------------------

const DASHBOARD_LEAF_BUDGET = 800; // bytes — anything below this is rendered verbatim
const DASHBOARD_STUB_MAX = 80;     // chars — per-stub line cap before truncation

/**
 * Build a one-line stub describing `value` at `path`. Used for child entries
 * inside an oversized container so the agent can decide whether to drill in.
 *
 * Picks a few characteristic fields (type + entity/area/title/name + nested
 * array counts) so the stub is informative without being huge.
 */
export function dashboardStubLine(value: unknown, path: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // Scalars / arrays at this level are rare; fall back to a short JSON cut.
    const s = JSON.stringify(value);
    return `<${truncate(s, DASHBOARD_STUB_MAX)} · drill: ${path}>`;
  }
  const obj = value as Record<string, unknown>;
  const fields: string[] = [];
  if (typeof obj.type === "string") fields.push(String(obj.type));

  const idKeys = ["entity", "area", "name", "title", "entity_id", "label"] as const;
  for (const k of idKeys) {
    const v = obj[k];
    if (typeof v === "string") {
      fields.push(`${k}=${truncate(v, 40)}`);
      break;
    }
  }

  // Surface array sizes — useful for sections/cards/entities/features.
  for (const k of ["sections", "cards", "entities", "features", "rows"]) {
    const v = obj[k];
    if (Array.isArray(v)) fields.push(`${v.length} ${k}`);
  }

  const summary = fields.length > 0 ? fields.join(" · ") : "(object)";
  return `<${truncate(summary, DASHBOARD_STUB_MAX)} · drill: ${path}>`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Recursive size-aware renderer. If the entire value JSON-stringifies under
 * the leaf budget, emit verbatim. Otherwise emit a JSON object/array where
 * children that are themselves over budget become stub strings.
 *
 * Result is a JSON string the agent can parse — stubs appear as string values
 * containing the drill path.
 */
export function renderDashboardNode(value: unknown, path: string): string {
  return JSON.stringify(stubify(value, path), null, 2);
}

function stubify(value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object") return value;
  const full = JSON.stringify(value);
  if (full.length <= DASHBOARD_LEAF_BUDGET) return value;

  // Past the budget — stub ALL complex children at this level (regardless of
  // individual size) so the agent gets a consistent "drill list" view.
  // Mixing inlined small cards with stubbed big ones makes the structure
  // harder to scan. Scalar fields and arrays-of-scalars stay verbatim because
  // they're cheap and informative.

  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item === null || typeof item !== "object") return item;
      const childPath = path ? `${path}.${i}` : String(i);
      return dashboardStubLine(item, childPath);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    if (v === null || typeof v !== "object") {
      out[k] = v;
      continue;
    }
    // Arrays of scalars stay verbatim — they're informative and cheap.
    if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.map((item, i) => {
        if (item === null || typeof item !== "object") return item;
        return dashboardStubLine(item, `${childPath}.${i}`);
      });
    } else {
      out[k] = dashboardStubLine(v, childPath);
    }
  }
  return out;
}

/**
 * Walk an automation config and collect every entity_id and service reference.
 * Skips template strings ({{ ... }}) since we can't statically resolve them.
 *
 * The walker is intentionally generic: HA's automation/script schema lets any
 * action key (`service`, `target.entity_id`, `entity_id`, `device_id`) appear
 * inside `choose[].sequence`, `repeat.sequence`, `if.then`, etc. Recursive
 * descent on arrays + objects catches everything without per-shape parsing.
 */
export function collectConfigReferences(config: unknown): { entityIds: string[]; services: string[] } {
  const entityIds = new Set<string>();
  const services = new Set<string>();

  const isTemplate = (s: string): boolean => /\{\{|\{%/.test(s);
  const addEntity = (v: unknown) => {
    if (typeof v === "string") {
      if (!isTemplate(v) && /^[a-z_]+\.[a-z0-9_]+$/i.test(v)) entityIds.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v) addEntity(x);
    }
  };
  const addService = (v: unknown) => {
    if (typeof v === "string" && !isTemplate(v) && /^[a-z_]+\.[a-z0-9_]+$/i.test(v)) {
      services.add(v);
    }
  };

  const walk = (node: unknown, parentKey?: string) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "entity_id") addEntity(v);
      else if (k === "service" || k === "action") addService(v);
      walk(v, k);
    }
  };

  walk(config);
  return { entityIds: [...entityIds], services: [...services] };
}

/**
 * Cross-reference what the config calls out against what HA actually has.
 * Returns warnings for unknowns; an empty list means the config looks valid.
 * "Warnings" not "errors" because templates can synthesize entity_ids/services
 * we can't see, and we'd rather not refuse a legitimate config.
 */
export function validateAutomationConfig(
  config: unknown,
  knownEntityIds: Set<string>,
  knownServices: Set<string>,
): { warnings: string[]; entityIds: string[]; services: string[] } {
  const { entityIds, services } = collectConfigReferences(config);
  const warnings: string[] = [];
  for (const id of entityIds) {
    if (!knownEntityIds.has(id)) warnings.push(`unknown entity_id: ${id}`);
  }
  for (const svc of services) {
    if (!knownServices.has(svc)) warnings.push(`unknown service: ${svc}`);
  }
  return { warnings, entityIds, services };
}

export interface TraceListEntry {
  run_id: string;
  state?: string;
  script_execution?: string;
  trigger?: string;
  timestamp?: { start?: string; finish?: string };
  last_step?: string;
}

function shortRunId(id: string, max = 30): string {
  return id.length <= max ? id : id.slice(0, max - 1) + "…";
}

function durationLabel(startIso: string | undefined, finishIso: string | undefined): string {
  if (!startIso || !finishIso) return "—";
  const s = new Date(startIso).getTime();
  const f = new Date(finishIso).getTime();
  if (isNaN(s) || isNaN(f) || f < s) return "—";
  const ms = f - s;
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`;
}

/**
 * Render a list of trace/list entries as a column-aligned table. Newest- /
 * oldest-first ordering is the caller's responsibility.
 */
export function renderTraceList(entries: TraceListEntry[], tz: string): string {
  if (entries.length === 0) return "(no runs)";
  const rows = entries.map((e) => {
    const start = e.timestamp?.start;
    const startLabel = start ? formatYMDHMS(new Date(start), tz) : "—";
    return [
      shortRunId(e.run_id),
      startLabel,
      durationLabel(e.timestamp?.start, e.timestamp?.finish),
      e.state ?? "—",
      e.script_execution ?? "—",
    ];
  });
  const headers = ["run_id", "started", "dur", "state", "execution"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

/**
 * Render a trace/get response into a compact human-readable summary. The raw
 * trace tree is large (every condition+action step at every nesting level)
 * and most of it is repeating the config the caller already has, so we only
 * surface what's interesting:
 *   - When the automation ran and how it terminated.
 *   - What triggered it (variables.trigger.platform / .description).
 *   - The ordered step list with each step's path, timestamp, and result/error.
 */
export function formatAutomationTrace(trace: Record<string, unknown>, tz: string = "UTC"): string {
  const lines: string[] = [];
  const ts = (trace.timestamp as { start?: string; finish?: string } | undefined) ?? {};
  const state = (trace.state as string | undefined) ?? "(unknown)";
  const scriptExec = (trace.script_execution as string | undefined) ?? "";
  const trigger = (trace.trigger as string | undefined) ?? "(unknown trigger)";

  // Render every timestamp in HA's timezone so the agent and user can correlate
  // a trace timeline with whatever else they're looking at (states, history,
  // log lines). HA returns timestamps as UTC ISO strings.
  const fmt = (iso: string | undefined): string => {
    if (!iso) return "?";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return formatYMDHMS(d, tz);
  };

  lines.push(`Automation ${trace.item_id ?? "?"} run ${trace.run_id ?? "?"}`);
  lines.push(`Started: ${fmt(ts.start)}${ts.finish ? `  Finished: ${fmt(ts.finish)}` : ""}  (${tz})`);
  lines.push(`State: ${state}${scriptExec ? `  ScriptExecution: ${scriptExec}` : ""}`);
  lines.push(`Trigger: ${trigger}`);
  if (trace.error) lines.push(`Error: ${String(trace.error)}`);
  lines.push("");

  // The trace map keys are dotted paths into the config — e.g. `trigger/0`,
  // `condition/0`, `action/2/choose/0/sequence/1`. Each value is an array of
  // step records (one per execution; `repeat` and parallel actions can yield
  // multiple). Walk in a stable order and surface the shortest-meaningful info.
  const traceMap = trace.trace as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!traceMap || typeof traceMap !== "object") {
    lines.push("(no step trace available)");
    return lines.join("\n");
  }
  const paths = Object.keys(traceMap).sort((a, b) => {
    // Order by first-step timestamp within each path so output is chronological.
    const aTs = traceMap[a]?.[0]?.timestamp as string | undefined;
    const bTs = traceMap[b]?.[0]?.timestamp as string | undefined;
    if (aTs && bTs) return aTs.localeCompare(bTs);
    return a.localeCompare(b);
  });

  lines.push(`Steps (${paths.length} paths):`);
  for (const path of paths) {
    const steps = traceMap[path];
    if (!Array.isArray(steps) || steps.length === 0) continue;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as Record<string, unknown>;
      const stepTs = step.timestamp as string | undefined;
      const result = step.result as Record<string, unknown> | undefined;
      const error = step.error as string | undefined;
      const changedVars = step.changed_variables as Record<string, unknown> | undefined;

      // HA emits step timestamps as UTC ISO strings. Convert to HA's tz +
      // append .SSS milliseconds (Intl APIs don't surface fractional seconds,
      // so pull them off the original string).
      let tsLabel = "?";
      if (stepTs) {
        const d = new Date(stepTs);
        if (!isNaN(d.getTime())) {
          const ms = /\.(\d{3})/.exec(stepTs)?.[1] ?? "000";
          const p = tzParts(d, tz, true);
          tsLabel = `${p.hour}:${p.minute}:${p.second}.${ms}`;
        } else {
          tsLabel = stepTs.slice(11, 23);
        }
      }
      const idxLabel = steps.length > 1 ? `[${i}]` : "";
      const resultBits: string[] = [];
      if (result) {
        // condition steps: { result: bool }
        if (typeof result.result === "boolean") resultBits.push(`condition=${result.result}`);
        // service-call: { params: {...}, running_script: bool }
        // wait/delay: { wait: { trigger: ..., remaining: ... } }
        if (result.params) resultBits.push("called");
        if (result.wait) resultBits.push("wait");
        if (result.choice !== undefined) resultBits.push(`choose=${result.choice}`);
        if (result.enabled === false) resultBits.push("disabled");
      }
      if (changedVars && changedVars.trigger) {
        const t = changedVars.trigger as Record<string, unknown>;
        const desc = t.description ?? `${t.platform}`;
        resultBits.push(`trigger:${desc}`);
      }
      const resultStr = resultBits.length ? ` ${resultBits.join(", ")}` : "";
      const errStr = error ? ` ERROR=${error}` : "";
      lines.push(`  ${tsLabel} ${path}${idxLabel}${resultStr}${errStr}`);
    }
  }
  return lines.join("\n");
}

export function buildTools(
  ha: HAClient,
  opts: { multimodal?: boolean; dashboardCache?: Map<string, unknown>; allowUnexposedWrites?: boolean } = {},
) {
  const isMultimodal = opts.multimodal === true;
  const dashboardCache = opts.dashboardCache ?? new Map<string, unknown>();
  const allowUnexposedWrites = opts.allowUnexposedWrites === true;

  // Collect every entity_id a service call would target — top-level entity_id
  // plus any in service_data (HA accepts string or array).
  function collectTargets(entityId: string | undefined, serviceData: Record<string, unknown> | undefined): string[] {
    const out: string[] = [];
    if (entityId) out.push(entityId);
    const sd = serviceData?.entity_id;
    if (typeof sd === "string") out.push(sd);
    else if (Array.isArray(sd)) {
      for (const v of sd) if (typeof v === "string") out.push(v);
    }
    return out;
  }

  function blockedNonExposed(targets: string[]): string[] {
    if (allowUnexposedWrites) return [];
    return targets.filter((id) => !ha.isExposed(id));
  }

  const REFUSAL_HINT = `Refused: not allowed to control non-exposed entities. The user can flip "Allow agent to control non-exposed entities" in Settings if this is intentional.`;
  return [
    {
      name: "ha_call_service",
      label: "Call Service",
      description: "Control a Home Assistant device or trigger a service. Set return_response=true for services that return data (weather.get_forecasts, calendar.get_events, conversation.process, etc.) — without it those services execute but return nothing useful.",
      parameters: Type.Object({
        domain: Type.String({ description: "e.g. light, switch, climate, cover, script, weather, calendar" }),
        service: Type.String({ description: "e.g. turn_on, turn_off, toggle, set_temperature, get_forecasts, get_events" }),
        entity_id: Type.Optional(Type.String({ description: "Target entity ID. Any HA entity is callable, but writes to entities not exposed to assistants are refused unless the user has flipped that setting on. If you don't know the exact ID, find it with ha_get_states first." })),
        service_data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "Extra data, e.g. {brightness_pct: 50} for lights, {type: 'daily'} for weather.get_forecasts",
        })),
        return_response: Type.Optional(Type.Boolean({ description: "Set true for services that return data (e.g. forecasts, events)" })),
      }),
      async execute(
        _id: string,
        params: { domain: string; service: string; entity_id?: string; service_data?: Record<string, unknown>; return_response?: boolean },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        // Refuse to call services on non-exposed entities unless the override is on.
        const blocked = blockedNonExposed(collectTargets(params.entity_id, params.service_data));
        if (blocked.length > 0) {
          return ok(`${REFUSAL_HINT}\nBlocked targets: ${blocked.join(", ")}`);
        }
        // Validate against the service registry. Block on unknown domain/service; warn on unknown args.
        const services = await ha.getServices();
        const domainServices = services[params.domain];
        if (!domainServices) {
          return ok(`Unknown domain "${params.domain}". Available domains: ${Object.keys(services).slice(0, 30).join(", ")}${Object.keys(services).length > 30 ? "…" : ""}`);
        }
        const def = domainServices[params.service];
        if (!def) {
          const known = Object.keys(domainServices).join(", ");
          return ok(`Unknown service "${params.domain}.${params.service}". Known ${params.domain} services: ${known}`);
        }

        const warnings: string[] = [];
        if (params.service_data && def.fields) {
          const known = new Set(Object.keys(def.fields));
          // entity_id is implicit via target; not always in fields. Don't warn on it.
          known.add("entity_id");
          for (const k of Object.keys(params.service_data)) {
            if (!known.has(k)) warnings.push(`unknown field "${k}" for ${params.domain}.${params.service}`);
          }
        }
        if (params.return_response && !def.response) {
          warnings.push(`${params.domain}.${params.service} does not return a response — return_response will error in HA`);
        }

        const result = await ha.callService(
          params.domain,
          params.service,
          params.entity_id ? { entity_id: params.entity_id } : undefined,
          params.service_data,
          params.return_response === true,
        );
        const target = params.entity_id ? ` on ${params.entity_id}` : "";
        const head = `Called ${params.domain}.${params.service}${target}`;
        const warningSuffix = warnings.length ? `\n\nWarnings:\n- ${warnings.join("\n- ")}` : "";
        if (params.return_response && result?.response !== undefined && result.response !== null) {
          return ok(`${head}${warningSuffix}\n\nResponse:\n${JSON.stringify(result.response, null, 2)}`);
        }
        return ok(head + warningSuffix);
      },
    },

    {
      name: "ha_get_states",
      label: "Get States",
      description: "Look up entity states. Searches across EVERY entity Home Assistant knows about — not only the ones in the catalog above. Use this whenever the user mentions something you don't see in the catalog: it might just be unexposed, not absent. Prefer the narrowest call possible: `entity_id` for one specific entity (returns full attributes), `filter` for a case-insensitive regex search across entity_id + friendly_name, `domain` to scope to one domain. Combine `filter` with `domain` to narrow further. Calling with no parameters dumps every entity and is almost never useful — reach for `filter` or `domain` first.",
      parameters: Type.Object({
        entity_id: Type.Optional(Type.String({ description: "Specific entity ID — returns state + every attribute" })),
        filter: Type.Optional(Type.String({
          description:
            "Case-insensitive JavaScript regex matched against entity_id AND friendly_name. " +
            "A bare word like `temperature` works because plain text is also valid regex. " +
            "Use `.*` to bridge gaps and `|` for alternation. " +
            "Examples: `temperature` (every temp sensor), `office.*temperature` (office + temperature in either order via `|` if needed), `^light\\.kitchen` (anchored), `motion|presence`, `front_door|back_door`. " +
            "If the regex is invalid you'll get an error back — don't escape special chars unless you mean them literally.",
        })),
        domain: Type.Optional(Type.String({ description: "Restrict to one domain (light, sensor, binary_sensor, switch, …). Combinable with `filter`." })),
      }),
      async execute(
        _id: string,
        params: { entity_id?: string; filter?: string; domain?: string },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        if (params.entity_id) {
          const s = ha.getState(params.entity_id);
          if (!s) return ok(`Unknown entity: ${params.entity_id}`);
          return okText(`${s.entity_id}: ${s.state}\nAttributes: ${JSON.stringify(s.attributes)}`, { maxBytes: 4 * 1024 });
        }
        let re: RegExp | null = null;
        if (params.filter && params.filter.trim().length > 0) {
          try {
            re = new RegExp(params.filter, "i");
          } catch (err) {
            return ok(`Invalid filter regex: ${(err as Error).message}. Filter is a JavaScript regex (e.g. \`temperature\`, \`office.*temp\`, \`^light\\.kitchen\`).`);
          }
        }
        const all = ha.getAllStates().filter((s) => {
          if (params.domain && !s.entity_id.startsWith(params.domain + ".")) return false;
          if (!re) return true;
          if (re.test(s.entity_id)) return true;
          const friendly = s.attributes.friendly_name as string | undefined;
          return friendly ? re.test(friendly) : false;
        });
        if (all.length === 0) {
          const scope = [params.domain && `domain=${params.domain}`, params.filter && `filter=/${params.filter}/i`].filter(Boolean).join(", ");
          if (!scope) return ok("No entities found");
          // Nudge the agent to broaden — small models tend to give up here.
          // The retry suggestions are concrete because abstract advice ("try a
          // different filter") doesn't survive small-model context.
          const tips: string[] = [];
          if (params.filter) tips.push(`try a shorter or alternate filter (e.g. one word, or \`a|b\` to OR-match)`);
          if (params.domain) tips.push(`drop \`domain\` and search with just \`filter\``);
          if (!params.filter && params.domain) tips.push(`add a \`filter\` to search by friendly_name within ${params.domain}`);
          return ok(`No entities match (${scope}). The catalog above is only exposed entities — this search covered every entity HA knows about, so this entity genuinely doesn't exist or your terms don't match it. Before giving up: ${tips.join("; ")}.`);
        }
        const lines = all.map((s) => {
          const friendly = s.attributes.friendly_name as string | undefined;
          const suffix = friendly && friendly !== s.entity_id ? ` (${friendly})` : "";
          return `${s.entity_id}${suffix}: ${s.state}`;
        });
        // Pick a hint that points the agent at the next narrower step.
        let hint: string;
        if (re) hint = `narrow with \`entity_id=<id>\` once you've spotted the right entity`;
        else if (params.domain) hint = `add \`filter=<regex>\` to search by name within this domain`;
        else hint = `add \`filter=<regex>\` (case-insensitive, matches entity_id + friendly_name) or \`domain=<name>\` — calling with no narrowing is almost never useful`;
        return okList("", lines, { maxBytes: 8 * 1024, hint });
      },
    },

    {
      name: "ha_fire_event",
      label: "Fire Event",
      description: "Fire a Home Assistant event with optional event_data. Use for triggering automations that listen on a specific event_type, or signaling other integrations.",
      parameters: Type.Object({
        event_type: Type.String({ description: "Event type, e.g. mydomain_event" }),
        event_data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional event payload",
        })),
      }),
      async execute(
        _id: string,
        params: { event_type: string; event_data?: Record<string, unknown> },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        await ha.call({
          type: "fire_event",
          event_type: params.event_type,
          event_data: params.event_data ?? {},
        });
        return ok(`Fired event ${params.event_type}`);
      },
    },

    {
      name: "ha_set_state",
      label: "Set State",
      description: "Set the state (and optionally attributes) of an entity in HA. NOTE: this updates HA's internal state only — it does NOT communicate with the underlying device. Use ha_call_service for device control. Useful for input_text, input_number, helpers, and template sensors.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity to update, e.g. input_text.note" }),
        state: Type.String({ description: "New state value" }),
        attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional attribute overrides",
        })),
      }),
      async execute(
        _id: string,
        params: { entity_id: string; state: string; attributes?: Record<string, unknown> },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        const blocked = blockedNonExposed([params.entity_id]);
        if (blocked.length > 0) {
          return ok(`${REFUSAL_HINT}\nBlocked target: ${params.entity_id}`);
        }
        // No WS command for set_state in modern HA; use the REST endpoint.
        const res = await ha.restCall(`/api/states/${encodeURIComponent(params.entity_id)}`, {
          method: "POST",
          body: JSON.stringify({ state: params.state, attributes: params.attributes ?? {} }),
        });
        if (!res.ok) {
          const text = await res.text();
          return ok(`Failed to set ${params.entity_id}: ${res.status} ${text.slice(0, 300)}`);
        }
        return ok(`Set ${params.entity_id} = ${params.state}`);
      },
    },

    {
      name: "ha_get_entity",
      label: "Get Entity",
      description: "Get full detail for a single entity: state, every attribute, last_changed, last_updated. Works for ANY HA entity, including ones not listed in the catalog above. Use this to inspect an entity's capabilities (e.g. supported_color_modes for a light, hvac_modes for a climate). Does not include history.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity to inspect" }),
      }),
      async execute(
        _id: string,
        params: { entity_id: string },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        const s = ha.getState(params.entity_id);
        if (!s) return ok(`Unknown entity: ${params.entity_id}`);
        const tz = await getHATimezone(ha);
        const lines: string[] = [];
        lines.push(`entity_id: ${s.entity_id}`);
        lines.push(`state: ${s.state}`);
        const attrs = s.attributes ?? {};
        const friendly = attrs.friendly_name;
        if (friendly) lines.push(`friendly_name: ${friendly}`);
        // deno-lint-ignore no-explicit-any
        const raw = s as unknown as Record<string, any>;
        if (raw.last_changed) lines.push(`last_changed: ${formatTimestamp(raw.last_changed, tz)}`);
        if (raw.last_updated) lines.push(`last_updated: ${formatTimestamp(raw.last_updated, tz)}`);
        lines.push("");
        lines.push("attributes:");
        for (const [k, v] of Object.entries(attrs)) {
          if (k === "friendly_name") continue;
          lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
        }
        return ok(lines.join("\n"));
      },
    },

    {
      name: "ha_get_camera_snapshot",
      label: "Camera Snapshot",
      description: isMultimodal
        ? "Capture a camera snapshot. The image is BOTH fed to YOU (so you can describe / identify / count) AND displayed inline in the chat for the user. Use whenever the user asks what's happening at a camera. For a continuous live view (no LLM analysis), prefer ha_show_camera."
        : "Capture a camera snapshot and display it inline in the chat for the user. The current model is text-only, so the image is NOT fed back to you. For a continuous live view, prefer ha_show_camera.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Camera entity ID (must start with camera.)" }),
      }),
      async execute(
        _id: string,
        params: { entity_id: string },
      ): Promise<ToolResult> {
        if (!params.entity_id.startsWith("camera.")) {
          return ok(`Not a camera entity: ${params.entity_id}`);
        }
        try {
          const res = await ha.restCall(`/api/camera_proxy/${encodeURIComponent(params.entity_id)}`);
          if (!res.ok) return ok(`Camera snapshot failed: ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          const mimeType = res.headers.get("content-type") ?? "image/jpeg";
          const sizeText = `${(buf.length / 1024).toFixed(1)} KB`;

          if (!isMultimodal) {
            return ok(
              `Snapshot captured for ${params.entity_id} (${sizeText}, ${mimeType}). ` +
              `The current model is text-only and can't see the image. ` +
              `Use ha_show_camera to display it to the user, or configure a multimodal model to enable visual reasoning.`,
            );
          }

          return {
            content: [
              { type: "text", text: `Snapshot of ${params.entity_id} (${sizeText})` },
              { type: "image", data: encodeBase64(buf), mimeType },
            ],
            details: { entity_id: params.entity_id, bytes: buf.length, multimodal: true },
          };
        } catch (err) {
          return ok(`Camera snapshot error: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_show_camera",
      label: "Show Camera",
      description: "Render a continuous live MJPEG feed of a camera entity inline in the chat for the USER to view (the browser pauses it when offscreen / tab inactive). This does NOT let YOU see the image — if you also need to look at it (e.g. to describe contents), call ha_get_camera_snapshot, which both displays the image AND feeds it to you. Use when the user asks to see/show/view/watch a camera.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Camera entity ID (must start with camera.)" }),
        title: Type.Optional(Type.String({ description: "Optional caption" })),
      }),
      execute(
        _id: string,
        params: { entity_id: string; title?: string },
      ): Promise<ToolResult> {
        if (!params.entity_id.startsWith("camera.")) {
          return Promise.resolve(ok(`Not a camera entity: ${params.entity_id}`));
        }
        return Promise.resolve(ok(`Showing ${params.entity_id} live feed inline.`));
      },
    },

    {
      name: "ha_render_chart",
      label: "Render Chart",
      description: "Render a line chart in the chat for one or more Home Assistant entities over a time range. The browser fetches the raw history and draws the chart. Use when the user asks to graph/plot/visualize sensor history. Pass either `hours` (relative to now) OR start_time+end_time (ISO 8601). Don't combine with ha_get_history — pick one based on whether the user wants to see (chart) or hear about (history) the data.",
      parameters: Type.Object({
        entity_ids: Type.Array(Type.String(), { description: "One or more entity IDs to plot together" }),
        title: Type.Optional(Type.String({ description: "Optional chart title" })),
        hours: Type.Optional(Type.Number({ description: "Hours of history ending now. Ignored if start_time/end_time set. Default 24." })),
        start_time: Type.Optional(Type.String({ description: "ISO 8601 start" })),
        end_time: Type.Optional(Type.String({ description: "ISO 8601 end" })),
      }),
      execute(
        _id: string,
        params: { entity_ids: string[]; title?: string; hours?: number; start_time?: string; end_time?: string },
      ): Promise<ToolResult> {
        const range = params.start_time
          ? `${params.start_time} → ${params.end_time ?? "now"}`
          : `${params.hours ?? 24}h`;
        const title = params.title ? ` "${params.title}"` : "";
        return Promise.resolve(ok(
          `Chart${title} prepared for [${params.entity_ids.join(", ")}] over ${range}. The chart renders inline in the chat.`,
        ));
      },
    },

    {
      name: "ha_get_logs",
      label: "Get Logs",
      description: "Recent Home Assistant log entries (up to 100 lines). type='error' returns the plaintext error log (warnings + errors from the current session); type='system' returns structured system_log entries. Optional case-insensitive regex filter.",
      parameters: Type.Object({
        type: Type.Union([Type.Literal("error"), Type.Literal("system")], { description: "error | system" }),
        filter: Type.Optional(Type.String({
          description: "Case-insensitive JavaScript regex matched against each line. Plain words work too (e.g. `zigbee`). Examples: `error|warn`, `\\bauth\\b`, `traceback`.",
        })),
      }),
      async execute(
        _id: string,
        params: { type: "error" | "system"; filter?: string },
      ): Promise<ToolResult> {
        let f: RegExp | null = null;
        if (params.filter && params.filter.trim().length > 0) {
          try {
            f = new RegExp(params.filter, "i");
          } catch (err) {
            return ok(`Invalid filter regex: ${(err as Error).message}. Filter is a JavaScript regex (e.g. \`error|warn\`, \`zigbee\`).`);
          }
        }
        if (params.type === "error") {
          try {
            const res = await ha.restCall("/api/error_log");
            if (!res.ok) return ok(`error_log failed: ${res.status}`);
            const text = await res.text();
            const lines = text.split("\n").filter((l) => l.trim());
            const filtered = f ? lines.filter((l) => f!.test(l)) : lines;
            // error_log is reverse-chronological: newest at the bottom. Show
            // the tail (most recent 100 lines) and let okList trim by bytes.
            const slice = filtered.slice(-100);
            if (slice.length === 0) return ok("(no matching log lines)");
            return okList("", slice, { maxBytes: 12 * 1024, hint: "tighten with `filter=<regex>`" });
          } catch (err) {
            return ok(`error_log fetch failed: ${(err as Error).message}`);
          }
        }
        try {
          const result = await ha.call<Array<Record<string, unknown>>>({ type: "system_log/list" });
          const items = Array.isArray(result) ? result : [];
          const tz = await getHATimezone(ha);
          const formatted = items.map((e) => {
            // HA's system_log entries carry timestamp as a Unix-seconds number.
            // Render in HA's timezone so log lines line up with state history.
            let ts: string;
            if (typeof e.timestamp === "number") {
              ts = formatYMDHMS(new Date(e.timestamp * 1000), tz);
            } else {
              ts = String(e.timestamp ?? "");
            }
            return `[${e.level ?? "?"}] ${ts} ${e.name ?? ""}: ${e.message ?? ""}`;
          });
          const filtered = f ? formatted.filter((l) => f!.test(l)) : formatted;
          const slice = filtered.slice(0, 100);
          if (slice.length === 0) return ok("(no matching entries)");
          return okList("", slice, { maxBytes: 12 * 1024, hint: "tighten with `filter=<regex>`" });
        } catch (err) {
          return ok(`system_log unavailable: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_notifications",
      label: "Get Notifications",
      description: "List active persistent notifications (the bell-icon ones in HA's UI). Returns id, title, message, created_at for each.",
      parameters: Type.Object({}),
      async execute(): Promise<ToolResult> {
        try {
          const result = await ha.call<Array<{ notification_id?: string; title?: string; message?: string; created_at?: string }>>({
            type: "persistent_notification/get",
          });
          const items = Array.isArray(result) ? result : [];
          if (items.length === 0) return ok("No active notifications.");
          const lines = items.map((n) => {
            const head = `[${n.notification_id ?? "?"}] ${n.title ?? "(no title)"}`;
            const body = n.message ? `\n  ${n.message.replace(/\n/g, "\n  ")}` : "";
            const when = n.created_at ? `\n  (created ${n.created_at})` : "";
            return head + body + when;
          });
          return okList("", lines, { maxBytes: 6 * 1024, separator: "\n\n" });
        } catch (err) {
          return ok(`Failed to fetch notifications: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_dashboard",
      label: "Get Dashboard",
      description: "List Lovelace dashboards (when name is omitted), get a dashboard's top-level summary (name only), or drill into a subtree (name + path). Path is dot-separated, numeric segments index arrays — e.g. `views.0`, `views.2.cards.3`. The full config is fetched once per agent turn and cached; drill-downs are free. Use `(default)` for the main dashboard.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "Dashboard url_path. Omit to list all. Use '(default)' for the main dashboard." })),
        path: Type.Optional(Type.String({ description: "Dot-separated path into the config (e.g. `views.0.cards.3`). Omit for top-level summary." })),
      }),
      async execute(
        _id: string,
        params: { name?: string; path?: string },
      ): Promise<ToolResult> {
        if (!params.name) {
          try {
            const list = await ha.call<Array<Record<string, unknown>>>({ type: "lovelace/dashboards/list" });
            const entries = Array.isArray(list) ? list : [];
            const lines = entries.map((d) => {
              const path = d.url_path ?? "(default)";
              const title = d.title ?? "(no title)";
              const mode = d.mode ? ` [${d.mode}]` : "";
              return `${path} — ${title}${mode}`;
            });
            if (!entries.find((d) => !d.url_path)) lines.unshift("(default) — main dashboard");
            return okList("", lines, { maxBytes: 4 * 1024 });
          } catch (err) {
            return ok(`Failed to list dashboards: ${(err as Error).message}`);
          }
        }
        try {
          let config = dashboardCache.get(params.name);
          if (config === undefined) {
            config = await ha.call<unknown>({
              type: "lovelace/config",
              url_path: params.name === "(default)" ? null : params.name,
            });
            dashboardCache.set(params.name, config);
          }
          if (!params.path) {
            return okText(summarizeDashboard(config), { maxBytes: 8 * 1024 });
          }
          const { value, found } = walkPath(config, params.path);
          if (!found) {
            return ok(`Path "${params.path}" not found in dashboard "${params.name}". Call without \`path\` for the top-level summary.`);
          }
          // Stubbed renderer: collapses oversized children to one-line stubs
          // with their drill paths so a deep dashboard doesn't blow context.
          // Stubs look like: "<area · area=office · drill: views.0.sections.0.cards.1>"
          const text = renderDashboardNode(value, params.path);
          return okText(text, {
            maxBytes: 16 * 1024,
            hint: "stubs ('<… · drill: <path>>') mark oversized children — pass that path to drill in",
          });
        } catch (err) {
          return ok(`Failed to fetch dashboard "${params.name}": ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_edit_dashboard",
      label: "Edit Dashboard",
      description: "Apply a list of partial edits to a dashboard. ALWAYS call ha_get_dashboard first so you know the current path layout. Each op uses the same dotted path syntax (e.g. `views.0.cards.3`) you used to drill in. Three op kinds:\n  - {op: 'set', path, value} — replace value at path; if parent is an array, key must be an existing index (use 'insert' to add).\n  - {op: 'delete', path} — remove the item at path. Object key, or array element (others shift down).\n  - {op: 'insert', path, value, index?} — insert into the array AT path (path itself points at the array). index defaults to end. Bounds: 0..array.length.\nOps apply in order, atomic — if any op fails, nothing is written. The response includes a per-op before/after diff of each op's parent so you can verify the change landed correctly without re-fetching. Top-level shape (must have at least one view) is checked after the ops apply. Entity_ids and service names referenced in the post-edit config are validated against the live registry; unknowns produce warnings (saved anyway). Use '(default)' for the main dashboard.",
      parameters: Type.Object({
        name: Type.String({ description: "Dashboard url_path. Use '(default)' for the main dashboard." }),
        ops: Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "Ordered list of edits (set/delete/insert)" }),
      }),
      async execute(
        _id: string,
        params: { name: string; ops: DashboardOp[] },
      ): Promise<ToolResult> {
        if (!Array.isArray(params.ops) || params.ops.length === 0) {
          return ok("ops must be a non-empty list");
        }
        try {
          // Always re-fetch so we apply against the freshest config; ignore any
          // per-turn cache from ha_get_dashboard (which is for read drill-downs).
          const config = await ha.call<unknown>({
            type: "lovelace/config",
            url_path: params.name === "(default)" ? null : params.name,
          });
          const { config: edited, errors, diffs } = applyDashboardOps(config, params.ops);
          if (errors.length > 0) {
            return ok(`Refused: ${errors.length} op error(s) — nothing written:\n- ${errors.join("\n- ")}`);
          }
          // Top-level sanity: dashboards need at least one view, otherwise HA
          // renders a blank UI that's painful to recover from in chat.
          // deno-lint-ignore no-explicit-any
          const cfg = edited as any;
          if (!Array.isArray(cfg?.views) || cfg.views.length === 0) {
            return ok(`Refused: post-edit config has no views[]. Aborting.`);
          }

          // Cross-reference entity_ids + services (same validator as automations).
          const knownEntityIds = new Set(ha.getAllStates().map((s) => s.entity_id));
          const services = await ha.getServices();
          const knownServices = new Set<string>();
          for (const [domain, svcs] of Object.entries(services)) {
            for (const name of Object.keys(svcs)) knownServices.add(`${domain}.${name}`);
          }
          const { warnings } = validateAutomationConfig(edited, knownEntityIds, knownServices);

          await ha.call({
            type: "lovelace/config/save",
            url_path: params.name === "(default)" ? null : params.name,
            config: edited,
          });
          dashboardCache.delete(params.name);

          const lines = [`Dashboard "${params.name}" updated (${params.ops.length} op${params.ops.length === 1 ? "" : "s"} applied).`];
          if (warnings.length > 0) {
            lines.push("");
            lines.push(`${warnings.length} validation warning(s):`);
            for (const w of warnings) lines.push(`- ${w}`);
          }
          // Per-op before/after so the agent can verify each change landed
          // where intended without a separate ha_get_dashboard round-trip.
          lines.push("");
          lines.push("--- diffs ---");
          lines.push(formatDashboardDiffs(diffs));
          return okText(lines.join("\n"), { maxBytes: 16 * 1024 });
        } catch (err) {
          return ok(`Failed to edit "${params.name}": ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_automation",
      label: "Get Automation",
      description: "Fetch the full config for one automation. `automation_id` is the numeric id from the entity's `attributes.id` (NOT the entity_id slug — e.g. for automation.morning_lights with attributes.id=1776352404227, pass 1776352404227). Returns the JSON config you'd see in HA's automation editor.",
      parameters: Type.Object({
        automation_id: Type.String({ description: "Numeric automation id (from attributes.id)" }),
      }),
      async execute(_id: string, params: { automation_id: string }): Promise<ToolResult> {
        try {
          const res = await ha.restCall(`/api/config/automation/config/${encodeURIComponent(params.automation_id)}`);
          if (!res.ok) {
            const body = await res.text();
            return ok(`Failed to fetch automation ${params.automation_id}: ${res.status} ${body.slice(0, 300)}`);
          }
          const json = await res.json();
          return okText(JSON.stringify(json, null, 2), { maxBytes: 16 * 1024, hint: "edit the config and pass it back to ha_update_automation with the same automation_id" });
        } catch (err) {
          return ok(`Failed to fetch automation ${params.automation_id}: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_update_automation",
      label: "Update Automation",
      description: "Replace the full config for one automation. ALWAYS call ha_get_automation first, edit the returned config, then pass the modified config back. Validates entity_ids and service names against the live registry — unknown ones produce warnings (templates and unknown-but-future entities are common false positives, so we warn rather than refuse). Pass strict=true to refuse on any warning.",
      parameters: Type.Object({
        automation_id: Type.String({ description: "Numeric automation id (from attributes.id)" }),
        config: Type.Record(Type.String(), Type.Unknown(), { description: "Complete automation config (alias, trigger, condition, action, mode, etc)" }),
        strict: Type.Optional(Type.Boolean({ description: "If true, refuse to save when validation produces any warning. Default false (save with warnings)." })),
      }),
      async execute(_id: string, params: { automation_id: string; config: Record<string, unknown>; strict?: boolean }): Promise<ToolResult> {
        // Build the validation universe from live HA state.
        const knownEntityIds = new Set(ha.getAllStates().map((s) => s.entity_id));
        const services = await ha.getServices();
        const knownServices = new Set<string>();
        for (const [domain, svcs] of Object.entries(services)) {
          for (const name of Object.keys(svcs)) knownServices.add(`${domain}.${name}`);
        }
        const { warnings, entityIds, services: refServices } = validateAutomationConfig(params.config, knownEntityIds, knownServices);
        if (params.strict && warnings.length > 0) {
          return ok(`Refused (strict mode): ${warnings.length} validation warning(s):\n- ${warnings.join("\n- ")}\nDrop strict=true to save anyway, or fix the config.`);
        }
        try {
          const res = await ha.restCall(`/api/config/automation/config/${encodeURIComponent(params.automation_id)}`, {
            method: "POST",
            body: JSON.stringify(params.config),
          });
          if (!res.ok) {
            const body = await res.text();
            return ok(`Failed to update automation ${params.automation_id}: ${res.status} ${body.slice(0, 500)}`);
          }
          const lines: string[] = [`Automation ${params.automation_id} updated. Referenced ${entityIds.length} entity_id(s), ${refServices.length} service(s).`];
          if (warnings.length > 0) {
            lines.push("");
            lines.push(`${warnings.length} warning(s) (saved anyway, strict=false):`);
            for (const w of warnings) lines.push(`- ${w}`);
          }
          return ok(lines.join("\n"));
        } catch (err) {
          return ok(`Failed to update automation ${params.automation_id}: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_automation_trace",
      label: "Automation Trace",
      description: "Inspect automation runs. Without run_id: lists up to 25 recent runs (run_id, start time, duration, state, script_execution) AND appends the full trace of the latest matching run. With run_id: returns just that run's trace. Use start_time/end_time (ISO 8601) to filter by window — list is then oldest-first (chronological reading of what happened in that window) and capped at 25; older matches above the cap are noted as elided. Without filters the list is newest-first.",
      parameters: Type.Object({
        automation_id: Type.String({ description: "Numeric automation id (from attributes.id)" }),
        run_id: Type.Optional(Type.String({ description: "Specific run id; omit to get a list + the latest trace" })),
        start_time: Type.Optional(Type.String({ description: "ISO 8601 start; only runs at-or-after are listed. Switches list ordering to oldest-first." })),
        end_time: Type.Optional(Type.String({ description: "ISO 8601 end; only runs before are listed. Defaults to now if start_time is set without end_time." })),
      }),
      async execute(
        _id: string,
        params: { automation_id: string; run_id?: string; start_time?: string; end_time?: string },
      ): Promise<ToolResult> {
        try {
          const tz = await getHATimezone(ha);

          // Specific run requested — render that run only.
          if (params.run_id) {
            const trace = await ha.call<Record<string, unknown>>({
              type: "trace/get",
              domain: "automation",
              item_id: params.automation_id,
              run_id: params.run_id,
            });
            return okText(formatAutomationTrace(trace, tz), {
              maxBytes: 16 * 1024,
              hint: "drop run_id to see the recent runs list",
            });
          }

          // Otherwise — list view + most-recent trace appended.
          const rawList = await ha.call<Array<TraceListEntry>>({
            type: "trace/list",
            domain: "automation",
            item_id: params.automation_id,
          });
          const list = Array.isArray(rawList) ? rawList : [];
          if (list.length === 0) {
            return ok(`No traces found for automation ${params.automation_id}. (Traces only exist after the automation has run since HA last started.)`);
          }

          // Resolve filter window if any.
          const filtered: { startMs: number; entry: TraceListEntry }[] = [];
          let startMs: number | undefined;
          let endMs: number | undefined;
          const filtering = params.start_time != null || params.end_time != null;
          if (filtering) {
            if (params.start_time) {
              const d = new Date(params.start_time);
              if (isNaN(d.getTime())) return ok(`Invalid start_time: ${params.start_time}`);
              startMs = d.getTime();
            }
            if (params.end_time) {
              const d = new Date(params.end_time);
              if (isNaN(d.getTime())) return ok(`Invalid end_time: ${params.end_time}`);
              endMs = d.getTime();
            } else if (startMs !== undefined) {
              endMs = Date.now();
            }
          }
          for (const entry of list) {
            const t = new Date(entry.timestamp?.start ?? "").getTime();
            if (isNaN(t)) continue;
            if (startMs !== undefined && t < startMs) continue;
            if (endMs !== undefined && t >= endMs) continue;
            filtered.push({ startMs: t, entry });
          }

          // Newest-first by default; oldest-first when filtering by window so
          // the agent reads runs chronologically within its requested span.
          filtered.sort((a, b) => filtering ? a.startMs - b.startMs : b.startMs - a.startMs);

          const LIMIT = 25;
          const matchedCount = filtered.length;
          const visible = filtered.slice(0, LIMIT);
          const elided = matchedCount - visible.length;

          // Latest run for the trailing trace block. When filtering this is
          // the most recent within the window; without filter, the most
          // recent overall (which is also visible[0] of newest-first sort).
          const latest = filtering
            ? filtered.reduce((acc, cur) => (cur.startMs > acc.startMs ? cur : acc), filtered[0])
            : visible[0];

          const lines: string[] = [];
          if (filtering) {
            const headStart = formatYMDHM(new Date(startMs ?? 0), tz);
            const headEnd = formatYMDHM(new Date(endMs ?? Date.now()), tz);
            lines.push(`Automation ${params.automation_id} — runs ${headStart} → ${headEnd} (${tz})`);
            if (matchedCount === 0) {
              lines.push(`  0 runs matched the requested window.`);
              lines.push("");
              lines.push(`(No latest run to show.)`);
              return okText(lines.join("\n"), { maxBytes: 16 * 1024 });
            }
            const showing = visible.length;
            const elidedNote = elided > 0
              ? `, showing ${showing} oldest first (${elided} newer runs elided — narrow start_time/end_time to see them)`
              : `, showing all ${showing} oldest first`;
            lines.push(`  matched ${matchedCount} run${matchedCount === 1 ? "" : "s"}${elidedNote}`);
          } else {
            lines.push(`Automation ${params.automation_id} — ${visible.length} most recent run${visible.length === 1 ? "" : "s"} (${tz})`);
          }
          lines.push("");
          lines.push(renderTraceList(visible.map((v) => v.entry), tz));
          lines.push("");

          if (latest) {
            lines.push(`Pass run_id=<id> for a different run. Latest${filtering ? " (in window)" : ""} run trace below:`);
            lines.push("");
            lines.push("--- latest run ---");
            const trace = await ha.call<Record<string, unknown>>({
              type: "trace/get",
              domain: "automation",
              item_id: params.automation_id,
              run_id: latest.entry.run_id,
            });
            lines.push(formatAutomationTrace(trace, tz));
          }
          return okText(lines.join("\n"), { maxBytes: 32 * 1024 });
        } catch (err) {
          return ok(`Failed to fetch trace for automation ${params.automation_id}: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_history",
      label: "Get History",
      description: "Entity history. For numeric sensors: bucketed min/max at a chosen granularity (lines like '14:05=20.3/20.7'). For binary/enum entities (door, motion, lights, selects, etc.): a list of state changes with HH:MM:SS timestamps, batched per hour when very dense. interval_minutes only applies to the numeric path. Pass either `hours` (relative to now) OR start_time+end_time (ISO 8601).",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity to get history for" }),
        hours: Type.Optional(Type.Number({ description: "Hours of history ending now. Ignored if start_time/end_time are set. Default 24." })),
        start_time: Type.Optional(Type.String({ description: "Window start, ISO 8601 (e.g. 2026-05-02T08:00:00+10:00)." })),
        end_time: Type.Optional(Type.String({ description: "Window end, ISO 8601. Defaults to now if omitted but start_time given." })),
        interval_minutes: Type.Optional(Type.Number({
          description: "Bucket size in minutes. Allowed: 1, 5, 10, 15, 30, 60. If omitted, picked based on window length (≤2h→5, ≤6h→10, ≤12h→15, ≤36h→30, else 60).",
        })),
      }),
      async execute(
        _id: string,
        params: { entity_id: string; hours?: number; start_time?: string; end_time?: string; interval_minutes?: number },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        // Resolve window
        let start: Date;
        let end: Date;
        if (params.start_time) {
          start = new Date(params.start_time);
          end = params.end_time ? new Date(params.end_time) : new Date();
          if (isNaN(start.getTime())) return ok(`Invalid start_time: ${params.start_time}`);
          if (isNaN(end.getTime())) return ok(`Invalid end_time: ${params.end_time}`);
        } else {
          const hours = params.hours ?? 24;
          end = new Date();
          start = new Date(end.getTime() - hours * 3_600_000);
        }
        if (end.getTime() <= start.getTime()) return ok(`end_time must be after start_time`);

        // Resolve interval
        const durationMs = end.getTime() - start.getTime();
        const intervalMin = params.interval_minutes ?? pickAutoInterval(durationMs);
        if (!ALLOWED_INTERVALS.includes(intervalMin)) {
          return ok(`Invalid interval_minutes ${intervalMin}. Allowed: ${ALLOWED_INTERVALS.join(", ")}`);
        }

        const raw = await ha.getHistory(params.entity_id, start, end);
        const tz = await getHATimezone(ha);
        const changes = parseStateChanges(raw);
        if (changes.length === 0) {
          console.log(`[tool] ha_get_history raw for ${params.entity_id}:`, JSON.stringify(raw).slice(0, 500));
          return ok(`No history data for ${params.entity_id}`);
        }
        const kind = classifyHistory(changes);
        if (kind === "numeric") {
          const points: HistoryPoint[] = [];
          for (const c of changes) {
            if (!isNumericState(c.state)) continue;
            points.push({ value: parseFloat(c.state), timestamp: c.timestamp, rawIso: c.rawIso });
          }
          if (points.length === 0) return ok(`No history data for ${params.entity_id}`);
          return okText(formatHistorySummary(params.entity_id, points, changes, start, end, intervalMin, tz), { maxBytes: 16 * 1024 });
        }
        return okText(formatStateChangeSummary(params.entity_id, changes, start, end, tz), { maxBytes: 16 * 1024 });
      },
    },
  ];
}
