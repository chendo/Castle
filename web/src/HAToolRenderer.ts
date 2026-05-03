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
import { Activity, Bell, FileText, History, LayoutDashboard, Wrench, Zap } from "lucide";

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
        ? ` (${Object.entries(p.service_data).map(([k, v]) => `${k}=${formatValue(v)}`).join(", ")})`
        : "";
      return head + target + sd;
    },
  },
  ha_get_states: {
    icon: Activity,
    summarize: (p) => {
      if (!p) return "ha_get_states";
      if (p.entity_id) return `ha_get_states ${p.entity_id}`;
      if (p.domain) return `ha_get_states (domain=${p.domain})`;
      return "ha_get_states (all)";
    },
  },
  ha_get_history: {
    icon: History,
    summarize: (p) => {
      if (!p?.entity_id) return "ha_get_history";
      const hrs = p.hours ?? 24;
      return `ha_get_history ${p.entity_id} (${hrs}h)`;
    },
  },
  ha_fire_event: {
    icon: Zap,
    summarize: (p) => p?.event_type ? `ha_fire_event ${p.event_type}` : "ha_fire_event",
  },
  ha_set_state: {
    icon: Wrench,
    summarize: (p) => p?.entity_id ? `ha_set_state ${p.entity_id} = ${p.state}` : "ha_set_state",
  },
  ha_get_logs: {
    icon: FileText,
    summarize: (p) => `ha_get_logs (${p?.type ?? "?"}${p?.filter ? ` filter="${p.filter}"` : ""})`,
  },
  ha_get_notifications: {
    icon: Bell,
    summarize: () => "ha_get_notifications",
  },
  ha_get_dashboard: {
    icon: LayoutDashboard,
    summarize: (p) => p?.name ? `ha_get_dashboard ${p.name}` : "ha_get_dashboard (list all)",
  },
  ha_modify_dashboard: {
    icon: LayoutDashboard,
    summarize: (p) => `ha_modify_dashboard ${p?.name ?? "?"} (replace full config)`,
  },
};

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
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

    return {
      content: html`
        <div>
          ${renderCollapsibleHeader(state, this.cfg.icon, summary, contentRef, chevronRef, false)}
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
