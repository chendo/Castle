import { Type } from "npm:@sinclair/typebox";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import type { HAClient } from "./ha-client.ts";

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; details: Record<string, unknown> };

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
  } catch { /* fall through to config API */ }
  // Fallback: try config API
  try {
    const tz = await ha.call<{ time_zone: string }>({ type: "config/core/get" });
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

export function parseHistoryPoints(raw: unknown): HistoryPoint[] | null {
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
      description: "Capture a snapshot of a camera as an inline image so you (the model) can see what the camera shows. Use this when you need to actually look at the scene to answer the user's question. For showing the user a camera, use ha_show_camera instead.",
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
          return {
            content: [
              { type: "text", text: `Snapshot of ${params.entity_id} (${(buf.length / 1024).toFixed(1)} KB)` },
              { type: "image", data: encodeBase64(buf), mimeType },
            ],
            details: { entity_id: params.entity_id, bytes: buf.length },
          };
        } catch (err) {
          return ok(`Camera snapshot error: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_show_camera",
      label: "Show Camera",
      description: "Render a camera entity inline in the chat. live=false (default) shows a single snapshot; live=true shows a continuous MJPEG feed (the browser pauses it when it's offscreen). Use when the user asks to see a camera.",
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
            const slice = filtered.slice(-100);
            return ok(slice.length === 0 ? "(no matching log lines)" : slice.join("\n"));
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
          return ok(slice.length === 0 ? "(no matching entries)" : slice.join("\n"));
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
          return ok(lines.join("\n\n"));
        } catch (err) {
          return ok(`Failed to fetch notifications: ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_dashboard",
      label: "Get Dashboard",
      description: "List Lovelace dashboards (when name is omitted) or fetch a single dashboard's full config (when name is given). Use the url_path field as the name. Pass `(default)` to target the default dashboard.",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "Dashboard url_path. Omit to list all. Use '(default)' for the main dashboard." })),
      }),
      async execute(
        _id: string,
        params: { name?: string },
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
            return ok(lines.join("\n"));
          } catch (err) {
            return ok(`Failed to list dashboards: ${(err as Error).message}`);
          }
        }
        try {
          const config = await ha.call<unknown>({
            type: "lovelace/config",
            url_path: params.name === "(default)" ? null : params.name,
          });
          const text = JSON.stringify(config, null, 2);
          return ok(text.length > 8000 ? text.slice(0, 8000) + "\n…(truncated)" : text);
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
          return ok(`Dashboard "${params.name}" updated.`);
        } catch (err) {
          return ok(`Failed to update "${params.name}": ${(err as Error).message}`);
        }
      },
    },

    {
      name: "ha_get_history",
      label: "Get History",
      description: "Sensor history bucketed at a chosen granularity. Each bucket reports min/max (single value if stable, _ if empty). Returns Stats line + per-bucket lines like '14:05=20.3/20.7'. Use a smaller interval_minutes for short windows (e.g. 5min over the last hour) and a larger one for multi-day windows. Pass either `hours` (relative to now) OR start_time+end_time (ISO 8601).",
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
        const points = parseHistoryPoints(raw);
        if (!points || points.length === 0) {
          console.log(`[tool] ha_get_history raw for ${params.entity_id}:`, JSON.stringify(raw).slice(0, 500));
          return ok(`No history data for ${params.entity_id}`);
        }
        return ok(formatHistorySummary(params.entity_id, points, start, end, intervalMin, tz));
      },
    },
  ];
}
