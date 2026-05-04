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
      const args: string[] = [`${p?.type ?? "?"}`];
      if (p?.filter) args.push(`filter=/${p.filter}/i`);
      return `ha_get_logs (${args.join(", ")})`;
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
  ha_modify_dashboard: {
    icon: LayoutDashboard,
    summarize: (p) => {
      if (!p?.name) return "ha_modify_dashboard";
      const cfg = p.config && typeof p.config === "object" ? p.config : null;
      const views = Array.isArray(cfg?.views) ? cfg.views.length : 0;
      return `ha_modify_dashboard ${p.name} (${views} view${views === 1 ? "" : "s"})`;
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
      return `ha_get_automation_trace ${p.automation_id}${p.run_id ? ` :${p.run_id}` : " (latest)"}`;
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
    const summary = this.cfg.summarize(params);

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

export function registerHAToolRenderers(): void {
  for (const [name, cfg] of Object.entries(CONFIGS)) {
    registerToolRenderer(name, new HACompactRenderer(cfg));
  }
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
