import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { type ToolRenderer, type ToolRenderResult, registerToolRenderer, renderHeader } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { LineChart } from "lucide";
import {
  Chart,
  type ChartConfiguration,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip,
} from "chart.js";
import "chartjs-adapter-date-fns";

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Legend, Tooltip);

interface ChartArgs {
  entity_ids: string[];
  title?: string;
  hours?: number;
  start_time?: string;
  end_time?: string;
}

interface HistoryPoint { t: string; v: number }

const PALETTE = [
  "#58a6ff", "#3fb950", "#f78166", "#d29922",
  "#bc8cff", "#39c5cf", "#ff7b72", "#a371f7",
];

function parseArgs(raw: unknown): ChartArgs | null {
  let parsed: any = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || !Array.isArray(parsed.entity_ids) || parsed.entity_ids.length === 0) return null;
  return parsed as ChartArgs;
}

function resolveRange(args: ChartArgs): { start: Date; end: Date } {
  if (args.start_time) {
    return {
      start: new Date(args.start_time),
      end: args.end_time ? new Date(args.end_time) : new Date(),
    };
  }
  const end = new Date();
  const start = new Date(end.getTime() - (args.hours ?? 24) * 3_600_000);
  return { start, end };
}

async function fetchSeries(args: ChartArgs): Promise<Record<string, HistoryPoint[]>> {
  const { start, end } = resolveRange(args);
  const params = new URLSearchParams();
  for (const id of args.entity_ids) params.append("entity_id", id);
  params.set("start", start.toISOString());
  params.set("end", end.toISOString());
  const res = await fetch(`/history?${params}`);
  if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
  return await res.json();
}

// The theme system in main.ts always reflects the resolved theme as a `.dark` class
// on <html> (handling "system" = OS preference internally). Reading the class here
// keeps charts in sync with the rest of the app instead of double-detecting.
// Trim full ISO timestamps to date+HH:MM portion for compact chip display.
function shortIso(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark");
}

function buildConfig(series: Record<string, HistoryPoint[]>, args: ChartArgs): ChartConfiguration<"line"> {
  const dark = isDarkMode();
  const grid = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const tick = dark ? "rgba(230,237,243,0.7)" : "rgba(60,60,60,0.85)";
  const legend = dark ? "rgba(230,237,243,0.85)" : "rgba(40,40,40,0.85)";

  const datasets = Object.entries(series).map(([id, pts], i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      label: id,
      data: pts.map((p) => ({ x: new Date(p.t).getTime(), y: p.v })),
      borderColor: color,
      backgroundColor: color + "22",
      fill: Object.keys(series).length === 1, // only fill when single series, otherwise it gets messy
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 1.8,
      tension: 0.2,
      spanGaps: true,
    };
  });

  const { start, end } = resolveRange(args);
  const durationMs = end.getTime() - start.getTime();
  const timeUnit = durationMs > 7 * 86_400_000 ? "day" : durationMs > 24 * 3_600_000 ? "hour" : "minute";

  return {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: {
          display: datasets.length > 1,
          position: "bottom",
          labels: { color: legend, boxWidth: 12, boxHeight: 2, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: dark ? "rgba(13,17,23,0.95)" : "rgba(255,255,255,0.97)",
          titleColor: dark ? "#e6edf3" : "#222",
          bodyColor: dark ? "#e6edf3" : "#222",
          borderColor: dark ? "#30363d" : "#e1e4e8",
          borderWidth: 1,
          cornerRadius: 6,
          padding: 8,
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
        },
      },
      scales: {
        x: {
          type: "time",
          min: start.getTime(),
          max: end.getTime(),
          time: { unit: timeUnit, tooltipFormat: "PPpp" },
          grid: { color: grid },
          ticks: { color: tick, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 },
        },
        y: {
          grid: { color: grid },
          ticks: { color: tick, font: { size: 11 } },
        },
      },
    },
  };
}

class ChartToolRenderer implements ToolRenderer {
  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const args = parseArgs(rawArgs);
    const state: "inprogress" | "complete" | "error" = result
      ? (result.isError ? "error" : "complete")
      : isStreaming ? "inprogress" : "complete";

    // Compact title — same args the agent saw, but trimmed to fit a chip:
    //   "Chart: light.kitchen, light.lounge (24h) — Title"
    //   "Chart: 5 entities (2026-05-04 09:00 → now)"
    const summary = (() => {
      if (!args) return "ha_render_chart";
      const ids = args.entity_ids;
      const idLabel = ids.length <= 3 ? ids.join(", ") : `${ids.length} entities`;
      const range = args.start_time
        ? `${shortIso(args.start_time)} → ${args.end_time ? shortIso(args.end_time) : "now"}`
        : `${args.hours ?? 24}h`;
      const title = args.title ? ` — ${args.title}` : "";
      return `Chart: ${idLabel} (${range})${title}`;
    })();

    const container = createRef<HTMLDivElement>();

    if (args && (result || !isStreaming)) {
      queueMicrotask(async () => {
        const el = container.value;
        if (!el || el.dataset.rendered === "1") return;
        el.dataset.rendered = "1";
        el.innerHTML = `<div style="font-size:12px;color:var(--muted-foreground);padding:8px 0;">Loading data…</div>`;
        try {
          const series = await fetchSeries(args);
          el.innerHTML = "";

          if (args.title) {
            const titleEl = document.createElement("div");
            titleEl.style.cssText = "font-size: 13px; font-weight: 500; margin-bottom: 8px; color: var(--foreground);";
            titleEl.textContent = args.title;
            el.appendChild(titleEl);
          }

          const total = Object.values(series).reduce((n, arr) => n + arr.length, 0);
          if (total === 0) {
            el.innerHTML += `<div style="font-size:12px;color:var(--muted-foreground);padding:8px 0;">No data in range.</div>`;
            return;
          }

          const wrap = document.createElement("div");
          wrap.style.cssText = "position: relative; height: 280px; width: 100%;";
          const canvas = document.createElement("canvas");
          wrap.appendChild(canvas);
          el.appendChild(wrap);

          new Chart(canvas, buildConfig(series, args));
        } catch (err) {
          el.innerHTML = `<div style="font-size:12px;color:var(--destructive);padding:8px 0;">Chart error: ${(err as Error).message}</div>`;
        }
      });
    }

    return {
      content: html`
        <div>
          ${renderHeader(state, LineChart, summary)}
          <div ${ref(container)} style="margin-top: 8px;"></div>
        </div>
      `,
      isCustom: false,
    };
  }
}

export function registerChartRenderer(): void {
  registerToolRenderer("ha_render_chart", new ChartToolRenderer());
}
