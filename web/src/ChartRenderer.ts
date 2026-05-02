import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { type ToolRenderer, type ToolRenderResult, registerToolRenderer, renderHeader } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { LineChart } from "lucide";

interface ChartArgs {
  entity_ids: string[];
  title?: string;
  hours?: number;
  start_time?: string;
  end_time?: string;
}

interface HistoryPoint { t: string; v: number }

const PALETTE = ["#58a6ff", "#3fb950", "#f78166", "#d29922", "#bc8cff", "#39c5cf", "#ff7b72", "#a371f7"];

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

function renderSvgChart(
  series: Record<string, HistoryPoint[]>,
  args: ChartArgs,
  width = 600,
  height = 240,
): SVGSVGElement {
  const margin = { top: 14, right: 14, bottom: 24, left: 44 };
  const w = width - margin.left - margin.right;
  const h = height - margin.top - margin.bottom;

  const all = Object.values(series).flat();
  if (all.length === 0) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    empty.setAttribute("width", String(width));
    empty.setAttribute("height", "60");
    empty.innerHTML = `<text x="10" y="35" fill="rgb(161,161,170)" font-size="13">No data in range</text>`;
    return empty;
  }

  const { start, end } = resolveRange(args);
  const xMin = start.getTime();
  const xMax = end.getTime();
  let yMin = Math.min(...all.map((p) => p.v));
  let yMax = Math.max(...all.map((p) => p.v));
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.05;
  yMin -= yPad; yMax += yPad;

  const sx = (t: number) => margin.left + ((t - xMin) / (xMax - xMin)) * w;
  const sy = (v: number) => margin.top + h - ((v - yMin) / (yMax - yMin)) * h;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.cssText = "display: block; max-width: 100%; height: auto;";

  // Y gridlines + labels (5)
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yMax - yMin) * (i / yTicks);
    const y = sy(v);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(margin.left));
    line.setAttribute("x2", String(margin.left + w));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", "rgb(39,39,42)");
    line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(margin.left - 6));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "10");
    label.setAttribute("fill", "rgb(115,115,115)");
    label.textContent = formatNumber(v);
    svg.appendChild(label);
  }

  // X axis labels (start, mid, end)
  for (const frac of [0, 0.5, 1]) {
    const t = xMin + (xMax - xMin) * frac;
    const x = sx(t);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(margin.top + h + 16));
    label.setAttribute("text-anchor", frac === 0 ? "start" : frac === 1 ? "end" : "middle");
    label.setAttribute("font-size", "10");
    label.setAttribute("fill", "rgb(115,115,115)");
    label.textContent = formatTime(new Date(t), xMax - xMin);
    svg.appendChild(label);
  }

  // Series
  const entries = Object.entries(series);
  for (let i = 0; i < entries.length; i++) {
    const [, points] = entries[i];
    if (points.length === 0) continue;
    const sorted = [...points].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
    const d = sorted.map((p, idx) => `${idx === 0 ? "M" : "L"} ${sx(new Date(p.t).getTime())} ${sy(p.v)}`).join(" ");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", PALETTE[i % PALETTE.length]);
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }

  return svg;
}

function formatNumber(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatTime(d: Date, durationMs: number): string {
  if (durationMs > 24 * 3_600_000) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", hour12: false });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderLegend(series: Record<string, HistoryPoint[]>): HTMLElement {
  const legend = document.createElement("div");
  legend.style.cssText = "display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-size: 12px;";
  let i = 0;
  for (const id of Object.keys(series)) {
    const item = document.createElement("span");
    item.style.cssText = "display: inline-flex; align-items: center; gap: 4px; color: rgb(161,161,170);";
    item.innerHTML = `<span style="display:inline-block;width:10px;height:2px;background:${PALETTE[i % PALETTE.length]};"></span><span>${id}</span>`;
    legend.appendChild(item);
    i++;
  }
  return legend;
}

class ChartToolRenderer implements ToolRenderer {
  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const args = parseArgs(rawArgs);
    const state: "inprogress" | "complete" | "error" = result
      ? (result.isError ? "error" : "complete")
      : isStreaming ? "inprogress" : "complete";

    const summary = args
      ? `Chart: ${args.entity_ids.join(", ")} (${args.start_time ? `${args.start_time} → ${args.end_time ?? "now"}` : `${args.hours ?? 24}h`})`
      : "render_chart";

    const container = createRef<HTMLDivElement>();

    // Kick off fetch + draw once we have args and the result is back (or while streaming once args are present).
    if (args && (result || !isStreaming)) {
      queueMicrotask(async () => {
        const el = container.value;
        if (!el || el.dataset.rendered === "1") return;
        el.dataset.rendered = "1";
        el.innerHTML = `<div style="font-size:12px;color:rgb(115,115,115);padding:8px 0;">Loading data…</div>`;
        try {
          const series = await fetchSeries(args);
          el.innerHTML = "";
          if (args.title) {
            const titleEl = document.createElement("div");
            titleEl.style.cssText = "font-size: 13px; font-weight: 500; margin-bottom: 6px;";
            titleEl.textContent = args.title;
            el.appendChild(titleEl);
          }
          el.appendChild(renderSvgChart(series, args));
          el.appendChild(renderLegend(series));
        } catch (err) {
          el.innerHTML = `<div style="font-size:12px;color:#f87171;padding:8px 0;">Chart error: ${(err as Error).message}</div>`;
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
  registerToolRenderer("render_chart", new ChartToolRenderer());
}
