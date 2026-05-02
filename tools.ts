import { Type } from "npm:@sinclair/typebox";
import type { HAClient } from "./ha-client.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: text.slice(0, 3000) }], details };
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
  } catch {}
  // Fallback: try config API
  try {
    const tz = await ha.call<{ time_zone: string }>({ type: "config/core/get" });
    if (tz?.time_zone) {
      cachedTimezone = tz.time_zone;
      return cachedTimezone;
    }
  } catch {}
  cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return cachedTimezone;
}

function formatTimestamp(iso: string, tz: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatHourlyBucket(date: Date, tz: string): string {
  return date.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "2-digit", hour12: false });
}

interface HistoryPoint { value: number; timestamp: Date; rawIso: string }

function parseHistoryPoints(raw: unknown): HistoryPoint[] | null {
  if (!raw || typeof raw !== "object") return null;

  // Modern HA WS `history/history_during_period`: { "<entity_id>": [{ s, lu, lc, a }, ...] }
  // Older REST `history/period`: [[{ state, last_changed }, ...]] (array of per-entity arrays)
  let pointArrays: unknown[] = [];
  if (Array.isArray(raw)) {
    pointArrays = raw;
  } else {
    pointArrays = Object.values(raw as Record<string, unknown>);
  }

  const points: HistoryPoint[] = [];
  for (const arr of pointArrays) {
    if (!Array.isArray(arr)) continue;
    for (const pt of arr) {
      if (typeof pt !== "object" || pt === null) continue;
      const p = pt as Record<string, unknown>;

      // State: prefer abbreviated `s`, fall back to `state`
      const stateRaw = p.s ?? p.state;
      let stateStr: string | undefined;
      if (typeof stateRaw === "string") stateStr = stateRaw;
      else if (typeof stateRaw === "number") stateStr = String(stateRaw);

      // Timestamp: abbreviated `lu`/`lc` are epoch SECONDS (numbers); full names are ISO strings.
      const tsRaw = p.lu ?? p.lc ?? p.last_updated ?? p.last_changed;
      let lcStr: string | undefined;
      if (typeof tsRaw === "string") lcStr = tsRaw;
      else if (typeof tsRaw === "number") lcStr = new Date(tsRaw * 1000).toISOString();
      else if (tsRaw instanceof Date) lcStr = tsRaw.toISOString();

      if (stateStr == null || !lcStr) continue;
      const num = parseFloat(stateStr);
      if (!isNaN(num)) points.push({ value: num, timestamp: new Date(lcStr), rawIso: lcStr });
    }
  }
  return points.length > 0 ? points : null;
}

function computeStats(points: HistoryPoint[]): {
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

function buildHourlyBuckets(points: HistoryPoint[], hours: number, tz: string): string[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const start = sorted[0].timestamp;
  const buckets: string[] = [];

  for (let i = 0; i < hours; i++) {
    const bucketStart = new Date(start.getTime() + i * 3_600_000);
    const bucketEnd = new Date(bucketStart.getTime() + 3_599_999);
    const inBucket = sorted.filter(p => p.timestamp >= bucketStart && p.timestamp <= bucketEnd);
    if (inBucket.length > 0) {
      const avg = inBucket.reduce((s, p) => s + p.value, 0) / inBucket.length;
      buckets.push(Math.round(avg * 10) / 10);
    } else {
      buckets.push(null as unknown as number);
    }
  }
  return buckets;
}

function formatHistorySummary(entityId: string, points: HistoryPoint[], hours: number, tz: string): string {
  const sorted = [...points].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const stats = computeStats(points);
  const unit = sorted[0]?.value > 100 ? "" : ""; // heuristic — no unit in raw data

  let lines: string[] = [];
  lines.push(`Entity: ${entityId}`);
  lines.push(`${formatTimestamp(sorted[0].rawIso, tz)} → ${formatTimestamp(sorted[sorted.length - 1].rawIso, tz)} (${hours}h)`);
  lines.push(`Samples: ${stats.count}`);
  lines.push("");
  lines.push("Statistics:");
  lines.push(`  Min:   ${stats.min}${unit} at ${formatTimestamp(stats.minAt, tz)}`);
  lines.push(`  Max:   ${stats.max}${unit} at ${formatTimestamp(stats.maxAt, tz)}`);
  lines.push(`  Avg:   ${stats.avg}${unit}`);
  lines.push(`  Last:  ${stats.last}${unit}`);
  lines.push("");

  const sign = stats.trendDelta > 0 ? "+" : "";
  lines.push(`Trend: ${stats.trendDir} (${sign}${stats.trendDelta}${unit} over period)`);

  if (hours > 12) {
    const buckets = buildHourlyBuckets(points, hours, tz);
    const bucketLabels = buckets.map((_, i) => formatHourlyBucket(new Date(sorted[0].timestamp.getTime() + i * 3_600_000), tz));
    lines.push("");
    lines.push("Hourly: " + buckets.join(", "));
  }

  return lines.join("\n");
}

export function buildTools(ha: HAClient) {
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
        const result = await ha.callService(
          params.domain,
          params.service,
          params.entity_id ? { entity_id: params.entity_id } : undefined,
          params.service_data,
          params.return_response === true,
        );
        const target = params.entity_id ? ` on ${params.entity_id}` : "";
        const head = `Called ${params.domain}.${params.service}${target}`;
        if (params.return_response && result?.response !== undefined && result.response !== null) {
          return ok(`${head}\n\nResponse:\n${JSON.stringify(result.response, null, 2)}`);
        }
        return ok(head);
      },
    },

    {
      name: "ha_get_states",
      label: "Get States",
      description: "Get current state of a specific entity or a filtered list",
      parameters: Type.Object({
        entity_id: Type.Optional(Type.String({ description: "Specific entity ID, or omit for all" })),
        domain: Type.Optional(Type.String({ description: "Filter by domain, e.g. light, sensor" })),
      }),
      async execute(
        _id: string,
        params: { entity_id?: string; domain?: string },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        if (params.entity_id) {
          const s = ha.getState(params.entity_id);
          if (!s) return ok(`Unknown entity: ${params.entity_id}`);
          return ok(`${s.entity_id}: ${s.state}\nAttributes: ${JSON.stringify(s.attributes)}`);
        }
        const all = ha.getAllStates().filter(s =>
          !params.domain || s.entity_id.startsWith(params.domain + ".")
        );
        const text = all.map(s => `${s.entity_id}: ${s.state}`).join("\n");
        return ok(text || "No entities found");
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
      name: "ha_get_history",
      label: "Get History",
      description: "Get aggregated history stats for a sensor — returns min/max/avg/trend instead of raw datapoints to save context",
      parameters: Type.Object({
        entity_id: Type.String({ description: "Entity to get history for" }),
        hours: Type.Number({ description: "Hours of history (default 24)", default: 24 }),
      }),
      async execute(
        _id: string,
        params: { entity_id: string; hours: number },
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        _ctx: unknown,
      ): Promise<ToolResult> {
        const raw = await ha.getHistory(params.entity_id, params.hours ?? 24);
        const tz = await getHATimezone(ha);
        const points = parseHistoryPoints(raw);
        if (!points || points.length === 0) {
          console.log(`[tool] ha_get_history raw for ${params.entity_id}:`, JSON.stringify(raw).slice(0, 500));
          return ok(`No history data for ${params.entity_id}`);
        }
        return ok(formatHistorySummary(params.entity_id, points, params.hours ?? 24, tz));
      },
    },
  ];
}
