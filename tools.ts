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
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatBucketTime(date: Date, tz: string, includeDate: boolean): string {
  if (includeDate) {
    return date.toLocaleString("en-US", {
      timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(/,\s*/g, " ");
  }
  return date.toLocaleString("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function formatChangeTime(date: Date, tz: string, includeDate: boolean): string {
  if (includeDate) {
    return date.toLocaleString("en-US", {
      timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).replace(/,\s*/g, " ");
  }
  return date.toLocaleString("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
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

/**
 * Render a state-change history (binary sensors, enums, anything non-numeric).
 * Per the roadmap: show timestamps with seconds for each change when there
 * aren't too many; otherwise batch by hour with a count and the ending state.
 */
export function formatStateChangeSummary(
  entityId: string,
  changes: StateChange[],
  rangeStart: Date,
  rangeEnd: Date,
  tz: string,
): string {
  const durationMs = rangeEnd.getTime() - rangeStart.getTime();
  const includeDate = durationMs > 24 * 3_600_000;

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

  const dur = durationMs / 3_600_000;
  const durLabel = dur < 1
    ? `${Math.round(durationMs / 60_000)}min`
    : Number.isInteger(dur) ? `${dur}h` : `${dur.toFixed(1)}h`;

  const lines: string[] = [];
  lines.push(entityId);
  const last = compact.length > 0 ? compact[compact.length - 1].state : "(none)";
  lines.push(`${formatBucketTime(rangeStart, tz, true)} → ${formatBucketTime(rangeEnd, tz, true)} (${durLabel}, ${compact.length} change${compact.length === 1 ? "" : "s"}, last=${last})`);
  lines.push("");
  if (distribution) {
    lines.push(`Distribution: ${distribution}`);
    lines.push("");
  }

  if (compact.length === 0) return lines.join("\n");

  if (compact.length <= STATE_CHANGE_PER_LINE_LIMIT) {
    for (const c of compact) {
      lines.push(`${formatChangeTime(c.timestamp, tz, includeDate)} ${c.state}`);
    }
    return lines.join("\n");
  }

  // Hour batching for dense series. Bucket to wall-clock hours in the HA tz so
  // labels line up with real hours instead of arbitrary offsets from rangeStart.
  lines.push("(many changes — batched by hour: count → ending state)");
  const buckets = new Map<string, { last: StateChange; count: number; bucketStart: Date }>();
  for (const c of compact) {
    // Normalize each timestamp down to the start of its hour in HA's timezone.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    }).formatToParts(c.timestamp);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const key = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.last = c;
      existing.count++;
    } else {
      buckets.set(key, { last: c, count: 1, bucketStart: c.timestamp });
    }
  }
  for (const { last: l, count, bucketStart } of buckets.values()) {
    lines.push(`${formatBucketTime(bucketStart, tz, includeDate)} ${count}× → ${l.state}`);
  }
  return lines.join("\n");
}

function formatHistorySummary(
  entityId: string,
  points: HistoryPoint[],
  rangeStart: Date,
  rangeEnd: Date,
  intervalMin: number,
  tz: string,
): string {
  const durationMs = rangeEnd.getTime() - rangeStart.getTime();
  const intervalMs = intervalMin * 60_000;
  const buckets = buildBuckets(points, rangeStart, rangeEnd, intervalMs);

  const stats = computeStats(points);
  const lines: string[] = [];
  const includeDate = durationMs > 24 * 3_600_000;

  const dur = durationMs / 3_600_000;
  const durLabel = dur < 1
    ? `${Math.round(durationMs / 60_000)}min`
    : Number.isInteger(dur) ? `${dur}h` : `${dur.toFixed(1)}h`;

  lines.push(`${entityId}`);
  lines.push(`${formatBucketTime(rangeStart, tz, true)} → ${formatBucketTime(rangeEnd, tz, true)} (${durLabel} @ ${intervalMin}min, ${buckets.length} buckets, ${stats.count} samples)`);
  lines.push("");
  lines.push(`Stats: min=${stats.min} max=${stats.max} avg=${stats.avg} last=${stats.last} ${stats.trendDelta >= 0 ? "+" : ""}${stats.trendDelta} (${stats.trendDir})`);
  lines.push("");

  // Per-bucket lines: "HH:MM=v" if stable, "HH:MM=min/max" if varying, "HH:MM=_" if empty.
  for (const b of buckets) {
    const time = formatBucketTime(b.start, tz, includeDate);
    if (b.values.length === 0) {
      lines.push(`${time}=_`);
    } else {
      const min = round1(Math.min(...b.values));
      const max = round1(Math.max(...b.values));
      lines.push(`${time}=${min === max ? min : `${min}/${max}`}`);
    }
  }
  return lines.join("\n");
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
 * title, path, and card count, plus other top-level keys.
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
      const cards = Array.isArray(view.cards) ? view.cards.length : 0;
      const badges = Array.isArray(view.badges) ? view.badges.length : 0;
      lines.push(`  views.${i}${path}: "${title}" — ${cards} cards${badges ? `, ${badges} badges` : ""}`);
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
  lines.push("To drill in, call again with `path=views.0` (or `views.0.cards.3`, etc.).");
  return lines.join("\n");
}

export function buildTools(
  ha: HAClient,
  opts: { multimodal?: boolean; dashboardCache?: Map<string, unknown> } = {},
) {
  const isMultimodal = opts.multimodal === true;
  const dashboardCache = opts.dashboardCache ?? new Map<string, unknown>();
  return [
    {
      name: "ha_call_service",
      label: "Call Service",
      description: "Control a Home Assistant device or trigger a service. Set return_response=true for services that return data (weather.get_forecasts, calendar.get_events, conversation.process, etc.) — without it those services execute but return nothing useful.",
      parameters: Type.Object({
        domain: Type.String({ description: "e.g. light, switch, climate, cover, script, weather, calendar" }),
        service: Type.String({ description: "e.g. turn_on, turn_off, toggle, set_temperature, get_forecasts, get_events" }),
        entity_id: Type.Optional(Type.String({ description: "Target entity ID from the entity list" })),
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
      description: "Look up entity states. Prefer the narrowest call possible: `entity_id` for one specific entity (returns full attributes), `filter` for a case-insensitive substring search across entity_id + friendly_name, `domain` to scope to one domain. Combine `filter` with `domain` to narrow further. Calling with no parameters dumps every exposed entity and is almost never what you want — always reach for `filter` first when you know roughly what you're looking for.",
      parameters: Type.Object({
        entity_id: Type.Optional(Type.String({ description: "Specific entity ID — returns state + every attribute" })),
        filter: Type.Optional(Type.String({ description: "Case-insensitive substring matched against entity_id AND friendly_name. Examples: `kitchen`, `motion`, `temp`." })),
        domain: Type.Optional(Type.String({ description: "Restrict to one domain (light, sensor, binary_sensor, switch, …)" })),
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
        const needle = params.filter?.trim().toLowerCase();
        const all = ha.getAllStates().filter((s) => {
          if (params.domain && !s.entity_id.startsWith(params.domain + ".")) return false;
          if (!needle) return true;
          if (s.entity_id.toLowerCase().includes(needle)) return true;
          const friendly = (s.attributes.friendly_name as string | undefined)?.toLowerCase();
          return friendly ? friendly.includes(needle) : false;
        });
        if (all.length === 0) {
          const scope = [params.domain && `domain=${params.domain}`, needle && `filter="${params.filter}"`].filter(Boolean).join(", ");
          return ok(scope ? `No entities match (${scope})` : "No entities found");
        }
        const lines = all.map((s) => {
          const friendly = s.attributes.friendly_name as string | undefined;
          const suffix = friendly && friendly !== s.entity_id ? ` (${friendly})` : "";
          return `${s.entity_id}${suffix}: ${s.state}`;
        });
        // Pick a hint that points the agent at the next narrower step.
        let hint: string;
        if (params.entity_id) hint = "";
        else if (needle) hint = `narrow with \`entity_id=<id>\` once you've spotted the right entity`;
        else if (params.domain) hint = `add \`filter=<substring>\` to search by name within this domain`;
        else hint = `add \`filter=<substring>\` (matches entity_id + friendly_name) or \`domain=<name>\` — calling with no narrowing is almost never useful`;
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
      description: "Get full detail for a single entity: state, every attribute, last_changed, last_updated. Use this to inspect an entity's capabilities (e.g. supported_color_modes for a light, hvac_modes for a climate). Does not include history.",
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
      label: "Camera Snapshot (image input)",
      description: isMultimodal
        ? "Capture a camera snapshot AND feed the image to YOU so you can see and describe it. Use this whenever the user asks what's happening at a camera, to describe a scene, identify something, count objects, etc. — anything where you need to look at the image yourself. Pair with ha_show_camera if the user also wants to see the image inline."
        : "Capture a camera snapshot. The current model is text-only, so the image is NOT fed back to you — only a size confirmation. Prefer ha_show_camera to actually display the image to the user.",
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
      description: "Render a camera entity inline in the chat for the USER to view. live=false (default) shows a single snapshot; live=true shows a continuous MJPEG feed (the browser pauses it when it's offscreen). This does NOT let YOU see the image — if you also need to look at it (e.g. to describe contents), call ha_get_camera_snapshot. Use when the user asks to see/show/view a camera.",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Camera entity ID (must start with camera.)" }),
        live: Type.Optional(Type.Boolean({ description: "true for continuous feed, false for one-shot snapshot. Default false." })),
        title: Type.Optional(Type.String({ description: "Optional caption" })),
      }),
      execute(
        _id: string,
        params: { entity_id: string; live?: boolean; title?: string },
      ): Promise<ToolResult> {
        if (!params.entity_id.startsWith("camera.")) {
          return Promise.resolve(ok(`Not a camera entity: ${params.entity_id}`));
        }
        const mode = params.live ? "live feed" : "snapshot";
        return Promise.resolve(ok(`Showing ${params.entity_id} ${mode} inline.`));
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
      description: "Recent Home Assistant log entries (up to 100 lines). type='error' returns the plaintext error log (warnings + errors from the current session); type='system' returns structured system_log entries. Optional filter substring-matches case-insensitively.",
      parameters: Type.Object({
        type: Type.Union([Type.Literal("error"), Type.Literal("system")], { description: "error | system" }),
        filter: Type.Optional(Type.String({ description: "Case-insensitive substring filter" })),
      }),
      async execute(
        _id: string,
        params: { type: "error" | "system"; filter?: string },
      ): Promise<ToolResult> {
        const f = params.filter?.toLowerCase();
        if (params.type === "error") {
          try {
            const res = await ha.restCall("/api/error_log");
            if (!res.ok) return ok(`error_log failed: ${res.status}`);
            const text = await res.text();
            const lines = text.split("\n").filter((l) => l.trim());
            const filtered = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
            // error_log is reverse-chronological: newest at the bottom. Show
            // the tail (most recent 100 lines) and let okList trim by bytes.
            const slice = filtered.slice(-100);
            if (slice.length === 0) return ok("(no matching log lines)");
            return okList("", slice, { maxBytes: 12 * 1024, hint: "tighten with `filter=<substring>`" });
          } catch (err) {
            return ok(`error_log fetch failed: ${(err as Error).message}`);
          }
        }
        try {
          const result = await ha.call<Array<Record<string, unknown>>>({ type: "system_log/list" });
          const items = Array.isArray(result) ? result : [];
          const formatted = items.map((e) => {
            const ts = typeof e.timestamp === "number"
              ? new Date(e.timestamp * 1000).toISOString()
              : String(e.timestamp ?? "");
            return `[${e.level ?? "?"}] ${ts} ${e.name ?? ""}: ${e.message ?? ""}`;
          });
          const filtered = f ? formatted.filter((l) => l.toLowerCase().includes(f)) : formatted;
          const slice = filtered.slice(0, 100);
          if (slice.length === 0) return ok("(no matching entries)");
          return okList("", slice, { maxBytes: 12 * 1024, hint: "tighten with `filter=<substring>`" });
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
          const text = JSON.stringify(value, null, 2);
          return okText(text, { maxBytes: 16 * 1024, hint: "drill deeper with a longer `path`" });
        } catch (err) {
          return ok(`Failed to fetch dashboard "${params.name}": ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_modify_dashboard",
      label: "Modify Dashboard",
      description: "Replace a Lovelace dashboard's full config. Destructive — overwrites the entire dashboard. Workflow: call ha_get_dashboard to fetch the current config, modify it, then call this with the complete new config. Use '(default)' for the main dashboard.",
      parameters: Type.Object({
        name: Type.String({ description: "Dashboard url_path. Use '(default)' for the main dashboard." }),
        config: Type.Record(Type.String(), Type.Unknown(), { description: "Complete new dashboard config (views, cards, etc)" }),
      }),
      async execute(
        _id: string,
        params: { name: string; config: Record<string, unknown> },
      ): Promise<ToolResult> {
        try {
          await ha.call({
            type: "lovelace/config/save",
            url_path: params.name === "(default)" ? null : params.name,
            config: params.config,
          });
          // The cached copy is now stale — drop it so a follow-up ha_get_dashboard
          // re-fetches the freshly-saved config instead of returning what we wrote.
          dashboardCache.delete(params.name);
          return ok(`Dashboard "${params.name}" updated.`);
        } catch (err) {
          return ok(`Failed to update "${params.name}": ${(err as Error).message}`);
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
          return okText(formatHistorySummary(params.entity_id, points, start, end, intervalMin, tz), { maxBytes: 16 * 1024 });
        }
        return okText(formatStateChangeSummary(params.entity_id, changes, start, end, tz), { maxBytes: 16 * 1024 });
      },
    },
  ];
}
