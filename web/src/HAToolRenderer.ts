import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
  type ToolRenderer,
  type ToolRenderResult,
  getToolRenderer,
  registerToolRenderer,
  renderCollapsibleHeader,
} from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Activity, Bell, Camera, FileText, History, Info, LayoutDashboard, ListChecks, Sparkles, Wrench, Zap } from "lucide";
import { getDuration } from "./ToolDurations";
import { summaryWithDuration } from "./ToolHeader";

type Icon = typeof Wrench;

interface RendererConfig {
  icon: Icon;
  /** One-line summary shown in the (collapsed) header. */
  summarize: (params: any) => string;
}

const CONFIGS: Record<string, RendererConfig> = {
  ha_call_service: {
    icon: Wrench,
    summarize: (p) => {
      if (!p) return "ha_call_service";
      const head = p.domain && p.service ? `${p.domain}.${p.service}` : "ha_call_service";
      const target = p.entity_id ? ` → ${p.entity_id}` : "";
      const sd = p.service_data && Object.keys(p.service_data).length
        ? ` (${formatArgs(p.service_data)})`
        : "";
      const resp = p.return_response ? " ← returns" : "";
      return head + target + sd + resp;
    },
  },
  ha_get_states: {
    icon: Activity,
    summarize: (p) => {
      if (!p) return "ha_get_states";
      if (p.entity_id) return `ha_get_states ${p.entity_id}`;
      const args: string[] = [];
      if (p.filter) args.push(`filter=${quote(p.filter)}`);
      if (p.domain) args.push(`domain=${p.domain}`);
      return args.length ? `ha_get_states (${args.join(", ")})` : "ha_get_states (all)";
    },
  },
  ha_get_entity: {
    icon: Info,
    summarize: (p) => p?.entity_id ? `ha_get_entity ${p.entity_id}` : "ha_get_entity",
  },
  ha_get_history: {
    icon: History,
    summarize: (p) => {
      if (!p?.entity_id) return "ha_get_history";
      const range = p.start_time
        ? `${shortIso(p.start_time)}→${p.end_time ? shortIso(p.end_time) : "now"}`
        : `${p.hours ?? 24}h`;
      const interval = p.interval_minutes ? `, ${p.interval_minutes}min` : "";
      return `ha_get_history ${p.entity_id} (${range}${interval})`;
    },
  },
  ha_fire_event: {
    icon: Zap,
    summarize: (p) => {
      if (!p?.event_type) return "ha_fire_event";
      const data = p.event_data && Object.keys(p.event_data).length
        ? ` (${formatArgs(p.event_data)})`
        : "";
      return `ha_fire_event ${p.event_type}${data}`;
    },
  },
  ha_set_state: {
    icon: Wrench,
    summarize: (p) => {
      if (!p?.entity_id) return "ha_set_state";
      const attrs = p.attributes && Object.keys(p.attributes).length
        ? ` [${formatArgs(p.attributes)}]`
        : "";
      return `ha_set_state ${p.entity_id} = ${formatValue(p.state)}${attrs}`;
    },
  },
  ha_get_camera_snapshot: {
    icon: Camera,
    summarize: (p) => p?.entity_id ? `ha_get_camera_snapshot ${p.entity_id}` : "ha_get_camera_snapshot",
  },
  ha_get_logs: {
    icon: FileText,
    summarize: (p) => {
      if (!p?.filter) return "ha_get_logs";
      const flags = p?.flags ?? "i";
      return `ha_get_logs (filter=/${p.filter}/${flags})`;
    },
  },
  ha_get_notifications: {
    icon: Bell,
    summarize: () => "ha_get_notifications",
  },
  ha_get_dashboard: {
    icon: LayoutDashboard,
    summarize: (p) => {
      if (!p?.name) return "ha_get_dashboard (list all)";
      const path = p.path ? ` :${p.path}` : "";
      return `ha_get_dashboard ${p.name}${path}`;
    },
  },
  ha_edit_dashboard: {
    icon: LayoutDashboard,
    summarize: (p) => {
      if (!p?.name) return "ha_edit_dashboard";
      const ops = Array.isArray(p.ops) ? p.ops : [];
      // Surface the op verbs in order so the user can see what's about to change.
      // e.g. "ha_edit_dashboard (default) [set views.0.title, insert views.0.cards@2]"
      const parts = ops.slice(0, 4).map((o: any) => {
        if (!o || typeof o !== "object") return "?";
        const path = o.path ?? "";
        if (o.op === "insert" && typeof o.index === "number") return `${o.op} ${path}@${o.index}`;
        return `${o.op} ${path}`;
      });
      const more = ops.length > 4 ? `, +${ops.length - 4} more` : "";
      return `ha_edit_dashboard ${p.name} [${parts.join(", ")}${more}]`;
    },
  },
  ha_get_automation: {
    icon: Sparkles,
    summarize: (p) => p?.automation_id ? `ha_get_automation ${p.automation_id}` : "ha_get_automation",
  },
  ha_update_automation: {
    icon: Sparkles,
    summarize: (p) => {
      if (!p?.automation_id) return "ha_update_automation";
      const cfg = p.config && typeof p.config === "object" ? p.config : null;
      const alias = cfg?.alias ? ` "${truncate(String(cfg.alias), 30)}"` : "";
      const strict = p.strict ? " strict" : "";
      return `ha_update_automation ${p.automation_id}${alias}${strict}`;
    },
  },
  ha_get_automation_trace: {
    icon: ListChecks,
    summarize: (p) => {
      if (!p?.automation_id) return "ha_get_automation_trace";
      if (p.run_id) return `ha_get_automation_trace ${p.automation_id} :${p.run_id}`;
      if (p.start_time) {
        const range = `${shortIso(p.start_time)}→${p.end_time ? shortIso(p.end_time) : "now"}`;
        return `ha_get_automation_trace ${p.automation_id} (${range})`;
      }
      return `ha_get_automation_trace ${p.automation_id} (recent runs)`;
    },
  },
  ha_list_automation_versions: {
    icon: History,
    summarize: (p) => p?.automation_id ? `ha_list_automation_versions ${p.automation_id}` : "ha_list_automation_versions",
  },
  ha_diff_automation_versions: {
    icon: History,
    summarize: (p) => {
      if (!p?.automation_id) return "ha_diff_automation_versions";
      const to = p.to !== undefined ? `v${p.to}` : "latest";
      return `ha_diff_automation_versions ${p.automation_id} v${p.from}→${to}`;
    },
  },
  ha_rollback_automation: {
    icon: History,
    summarize: (p) => {
      if (!p?.automation_id || p.version === undefined) return "ha_rollback_automation";
      const dry = p.dry_run ? " (dry-run)" : "";
      return `ha_rollback_automation ${p.automation_id} → v${p.version}${dry}`;
    },
  },
  ha_list_dashboard_versions: {
    icon: History,
    summarize: (p) => p?.name ? `ha_list_dashboard_versions ${p.name}` : "ha_list_dashboard_versions",
  },
  ha_diff_dashboard_versions: {
    icon: History,
    summarize: (p) => {
      if (!p?.name) return "ha_diff_dashboard_versions";
      const to = p.to !== undefined ? `v${p.to}` : "latest";
      return `ha_diff_dashboard_versions ${p.name} v${p.from}→${to}`;
    },
  },
  ha_rollback_dashboard: {
    icon: History,
    summarize: (p) => {
      if (!p?.name || p.version === undefined) return "ha_rollback_dashboard";
      const dry = p.dry_run ? " (dry-run)" : "";
      return `ha_rollback_dashboard ${p.name} → v${p.version}${dry}`;
    },
  },
};

// Render an arbitrary param object as `k=v, k2=v2` truncated to a safe length.
// Used for service_data / event_data / attributes which can be arbitrary JSON.
function formatArgs(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const pairs = Object.entries(obj as Record<string, unknown>)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${formatValue(v)}`);
  const all = Object.keys(obj as Record<string, unknown>).length;
  const overflow = all > 4 ? `, +${all - 4} more` : "";
  return truncate(pairs.join(", "), 80) + overflow;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function quote(s: unknown): string {
  if (typeof s !== "string") return String(s);
  // Wrap in /…/i so it reads as a regex literal — matches what the tool actually does.
  return `/${s}/i`;
}

function shortIso(s: string): string {
  // Trim full ISO timestamps to their date+HH:MM portion to keep titles short.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // [a, b, c] or [a, b, c, +2 more] — keep titles compact for entity lists.
    const head = v.slice(0, 3).map((x) => formatValue(x)).join(", ");
    return v.length > 3 ? `[${head}, +${v.length - 3}]` : `[${head}]`;
  }
  return JSON.stringify(v);
}

function parseParams(raw: unknown): any {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

class HACompactRenderer implements ToolRenderer {
  constructor(private readonly cfg: RendererConfig) {}

  render(rawParams: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const params = parseParams(rawParams);
    const state: "inprogress" | "complete" | "error" = result
      ? (result.isError ? "error" : "complete")
      : isStreaming ? "inprogress" : "complete";

    const contentRef = createRef<HTMLElement>();
    const chevronRef = createRef<HTMLElement>();
    const baseSummary = this.cfg.summarize(params);
    // Once a tool has finished, RemoteAgent has populated its duration via
    // ToolDurations. The duration is rendered right-aligned in the header
    // (via summaryWithDuration) so a column scan reveals which tools were the
    // slow ones — parallel-executed calls of the same tool stack neatly.
    const durationMs = result?.toolCallId ? getDuration(result.toolCallId) : undefined;
    const summary = summaryWithDuration(baseSummary, durationMs);

    const paramsJson = params ? safeStringify(params) : "";
    const outputText = result?.content?.filter((c) => c.type === "text")
      .map((c: any) => c.text).join("\n") || "";

    // Tool execute() may attach `details.truncated` when its response was cut.
    // Show a small warning chip on the collapsed header so devs notice without
    // expanding every tool call. Same shape across every tool.
    const truncated = (result?.details as any)?.truncated as
      | { bytes_elided: number; total_bytes: number; items_elided?: number; total_items?: number }
      | undefined;
    const truncBadge = truncated ? renderTruncationBadge(truncated) : "";

    return {
      content: html`
        <div>
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0">
              ${renderCollapsibleHeader(state, this.cfg.icon, summary, contentRef, chevronRef, false)}
            </div>
            ${truncBadge}
          </div>
          <div ${ref(contentRef)} class="overflow-hidden transition-all max-h-0 space-y-2">
            ${paramsJson ? html`
              <div>
                <div class="text-xs font-medium mb-1 text-muted-foreground">Input</div>
                <code-block .code=${paramsJson} language="json"></code-block>
              </div>
            ` : ""}
            ${outputText ? html`
              <div>
                <div class="text-xs font-medium mb-1 text-muted-foreground">Output</div>
                <code-block .code=${outputText} language="${tryDetectLanguage(outputText)}"></code-block>
              </div>
            ` : ""}
          </div>
        </div>
      `,
      isCustom: false,
    };
  }
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}kB`;
}

function renderTruncationBadge(t: { bytes_elided: number; total_bytes: number; items_elided?: number; total_items?: number }): unknown {
  const counts = t.items_elided && t.total_items
    ? `${t.total_items - t.items_elided}/${t.total_items} items`
    : `${fmtBytes(t.bytes_elided)} elided`;
  const title = `Tool output was truncated: ${fmtBytes(t.bytes_elided)} of ${fmtBytes(t.total_bytes)} cut`;
  return html`
    <span
      title=${title}
      class="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded border"
      style="background: rgba(234, 179, 8, 0.15); border-color: rgba(234, 179, 8, 0.5); color: rgb(180, 130, 0);"
    >⚠ truncated · ${counts}</span>
  `;
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function tryDetectLanguage(s: string): string {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { JSON.parse(t); return "json"; } catch { /* fall through */ }
  }
  return "text";
}

/**
 * A single row from a `ha_list_*_versions` output line. The tool emits one
 * line per version in the format produced by tools.ts:
 *   `v3  2026-05-12T11:00:00Z  castle "Morning lights"`
 *   `v4  2026-05-12T11:05:00Z  rollback←v2`
 */
interface VersionRow {
  version: number;
  ts: string;
  source: string;
  alias?: string;
}

const VERSION_LINE = /^v(\d+)\s+(\S+)\s+(\S+)(?:\s+"(.*)")?$/;

function parseVersionLines(text: string): VersionRow[] {
  const rows: VersionRow[] = [];
  for (const line of text.split("\n")) {
    const m = VERSION_LINE.exec(line);
    if (!m) continue;
    rows.push({
      version: Number(m[1]),
      ts: m[2],
      source: m[3],
      alias: m[4],
    });
  }
  return rows;
}

/** Compact "5m ago" style label for the version-list timestamps. */
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Renderer for `ha_list_*_versions`. Parses the text output (which is also
 * shown raw, collapsed) and renders a tidy table with a Rollback button per
 * row. Clicking Rollback drops a templated prompt into the agent — it goes
 * through the LLM (same code path as a typed user request), so the agent can
 * acknowledge and call `ha_rollback_*` with the right parameters.
 *
 * Going through the LLM rather than a direct `service_call`-style bypass
 * keeps the audit trail consistent: the rollback appears in chat with its
 * own assistant turn, and the agent can chain follow-ups (e.g. show the diff
 * before applying).
 */
class HistoryListRenderer implements ToolRenderer {
  constructor(
    private readonly kind: "automation" | "dashboard",
    private readonly agent: { sendPromptText?: (text: string) => void },
    private readonly cfg: RendererConfig,
  ) {}

  render(rawParams: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const params = parseParams(rawParams);
    const state: "inprogress" | "complete" | "error" = result
      ? (result.isError ? "error" : "complete")
      : isStreaming ? "inprogress" : "complete";

    const contentRef = createRef<HTMLElement>();
    const chevronRef = createRef<HTMLElement>();
    const baseSummary = this.cfg.summarize(params);
    const durationMs = result?.toolCallId ? getDuration(result.toolCallId) : undefined;
    const summary = summaryWithDuration(baseSummary, durationMs);

    const outputText = result?.content?.filter((c) => c.type === "text")
      .map((c: any) => c.text).join("\n") || "";
    const rows = parseVersionLines(outputText);

    const id = this.kind === "automation" ? params?.automation_id : params?.name;
    const idLabel = this.kind === "automation" ? id : `"${id}"`;

    // The rollback prompt is deliberately explicit — naming the tool removes
    // any guesswork on the model's side. The agent will still respond
    // conversationally; we don't bypass the LLM here.
    const rollbackToolName = this.kind === "automation" ? "ha_rollback_automation" : "ha_rollback_dashboard";
    const onRollback = (version: number) => {
      this.agent.sendPromptText?.(
        `Rollback ${this.kind} ${idLabel} to version ${version} using ${rollbackToolName}. Show me the diff first via dry_run, then ask me to confirm before writing.`,
      );
    };

    return {
      content: html`
        <div>
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0">
              ${renderCollapsibleHeader(state, this.cfg.icon, summary, contentRef, chevronRef, false)}
            </div>
          </div>
          <div ${ref(contentRef)} class="overflow-hidden transition-all max-h-0 space-y-2">
            ${rows.length === 0 ? html`
              <div class="text-sm text-muted-foreground p-2">${outputText || "(no versions)"}</div>
            ` : html`
              <div class="overflow-x-auto">
                <table class="w-full text-sm" style="border-collapse: collapse;">
                  <thead>
                    <tr style="border-bottom: 1px solid var(--border);">
                      <th class="text-left py-1 px-2 font-medium text-muted-foreground">Version</th>
                      <th class="text-left py-1 px-2 font-medium text-muted-foreground">When</th>
                      <th class="text-left py-1 px-2 font-medium text-muted-foreground">Source</th>
                      <th class="text-left py-1 px-2 font-medium text-muted-foreground">Title</th>
                      <th class="text-right py-1 px-2 font-medium text-muted-foreground"></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map((r, i) => html`
                      <tr style="border-bottom: 1px solid var(--border);">
                        <td class="py-1 px-2 font-mono">v${r.version}</td>
                        <td class="py-1 px-2" title=${r.ts}>${timeAgo(r.ts)}</td>
                        <td class="py-1 px-2">
                          <span class="inline-block px-2 py-0.5 text-xs rounded" style=${sourcePillStyle(r.source)}>
                            ${r.source}
                          </span>
                        </td>
                        <td class="py-1 px-2 text-muted-foreground">${r.alias ?? ""}</td>
                        <td class="py-1 px-2 text-right">
                          ${i === 0 ? html`
                            <span class="text-xs text-muted-foreground">latest</span>
                          ` : html`
                            <button
                              class="px-2 py-0.5 text-xs rounded border border-border hover:bg-muted-background"
                              @click=${() => onRollback(r.version)}
                              title="Send a rollback request to the agent"
                            >Rollback</button>
                          `}
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      `,
      isCustom: false,
    };
  }
}

function sourcePillStyle(source: string): string {
  if (source.startsWith("rollback")) {
    return "background: rgba(168, 85, 247, 0.15); color: rgb(126, 34, 206);";
  }
  return "background: rgba(59, 130, 246, 0.15); color: rgb(29, 78, 216);";
}

export function registerHAToolRenderers(): void {
  for (const [name, cfg] of Object.entries(CONFIGS)) {
    registerToolRenderer(name, new HACompactRenderer(cfg));
  }
}

/**
 * Replace the compact renderer for the two `ha_list_*_versions` tools with a
 * version-table renderer that includes a per-row Rollback button. Called from
 * main.ts after the agent is built (the button dispatches through it). Safe
 * to call independently of `registerHAToolRenderers` — re-registering
 * overrides the earlier compact entry.
 */
export function registerHistoryRenderers(agent: { sendPromptText?: (text: string) => void }): void {
  registerToolRenderer(
    "ha_list_automation_versions",
    new HistoryListRenderer("automation", agent, CONFIGS.ha_list_automation_versions),
  );
  registerToolRenderer(
    "ha_list_dashboard_versions",
    new HistoryListRenderer("dashboard", agent, CONFIGS.ha_list_dashboard_versions),
  );
}

/**
 * Register a generic collapsed-by-default renderer for `toolName` if no specific
 * one is registered. Lets us fall back gracefully for tools we haven't built a
 * bespoke widget for (instead of pi-web-ui's expanded JSON DefaultRenderer).
 */
export function ensureCollapsibleRenderer(toolName: string): void {
  if (getToolRenderer(toolName)) return;
  registerToolRenderer(toolName, new HACompactRenderer({
    icon: Wrench,
    summarize: () => toolName,
  }));
}
