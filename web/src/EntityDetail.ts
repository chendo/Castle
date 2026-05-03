import {
  Chart,
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

interface State {
  entity_id: string;
  state: string;
  // deno-lint-ignore no-explicit-any
  attributes: Record<string, any>;
  domain: string;
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function isNumeric(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s);
}

// Match ChartRenderer: rely solely on the `.dark` class set by the theme system.
function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Open the rich entity detail modal. */
export function showEntityDetail(entity: State): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200;
    display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
    padding: 20px;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: var(--card); color: var(--foreground);
    border: 1px solid var(--border); border-radius: 14px;
    width: 100%; max-width: 640px; max-height: 90vh;
    overflow: hidden; display: flex; flex-direction: column;
  `;

  // Header
  const header = document.createElement("div");
  header.style.cssText = "padding: 18px 20px 14px; border-bottom: 1px solid var(--border);";
  const friendly = (entity.attributes?.friendly_name as string) ?? entity.entity_id;
  const unit = entity.attributes?.unit_of_measurement ?? "";
  const stateText = `${entity.state}${unit ? ` ${unit}` : ""}`;

  header.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
      <div style="min-width:0;">
        <div style="font-size:13px;color:var(--muted-foreground);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(entity.entity_id)}</div>
        <div style="font-size:18px;font-weight:600;margin-top:2px;word-break:break-word;">${escapeHtml(friendly)}</div>
        <div style="font-size:28px;color:var(--primary,#58a6ff);font-family:ui-monospace,monospace;margin-top:8px;line-height:1.1;word-break:break-word;">${escapeHtml(stateText)}</div>
      </div>
      <button title="Close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0;">×</button>
    </div>
  `;
  header.querySelector("button")!.onclick = close;

  // Body (scrollable)
  const body = document.createElement("div");
  body.style.cssText = "padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;";

  // Domain-specific previews
  const previews = renderPreviews(entity);
  if (previews) body.appendChild(previews);

  // Sensor: inline mini-chart for last 24h if numeric
  if (entity.domain === "sensor" && isNumeric(String(entity.state))) {
    const chartSection = renderSensorChart(entity.entity_id);
    body.appendChild(chartSection);
  }

  // Attribute grid
  const attrEntries = Object.entries(entity.attributes ?? {})
    .filter(([k]) => k !== "friendly_name" && k !== "unit_of_measurement");
  if (attrEntries.length > 0) {
    const attrSection = document.createElement("div");
    attrSection.innerHTML = `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-foreground);margin-bottom:8px;">Attributes</div>`;
    const grid = document.createElement("div");
    grid.style.cssText = "display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 14px; font-size: 13px;";
    for (const [k, v] of attrEntries) {
      const valStr = typeof v === "string" ? v : JSON.stringify(v);
      const keyEl = document.createElement("div");
      keyEl.style.cssText = "color: var(--muted-foreground); font-family: ui-monospace, monospace; font-size: 12px;";
      keyEl.textContent = k;
      const valEl = document.createElement("div");
      valEl.style.cssText = "word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px;";
      valEl.textContent = valStr.length > 400 ? valStr.slice(0, 400) + "…" : valStr;
      grid.append(keyEl, valEl);
    }
    attrSection.appendChild(grid);
    body.appendChild(attrSection);
  }

  panel.append(header, body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
}

/** Domain-specific rich previews: camera images, light color/brightness, etc. */
function renderPreviews(entity: State): HTMLElement | null {
  const a = entity.attributes ?? {};

  if (entity.domain === "camera") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "border-radius: 10px; overflow: hidden; background: var(--muted); aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center;";
    const img = document.createElement("img");
    img.src = `/camera/${encodeURIComponent(entity.entity_id)}?ts=${Date.now()}`;
    img.alt = entity.entity_id;
    img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";
    img.onerror = () => {
      wrap.innerHTML = `<span style="color:var(--muted-foreground);font-size:12px;">Snapshot unavailable</span>`;
    };
    wrap.appendChild(img);
    return wrap;
  }

  if (entity.domain === "light" && entity.state === "on") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: flex; gap: 12px; align-items: center;";
    const rgb = a.rgb_color as [number, number, number] | undefined;
    if (rgb) {
      const swatch = document.createElement("div");
      swatch.style.cssText = `
        width: 56px; height: 56px; border-radius: 8px;
        background: rgb(${rgb[0]},${rgb[1]},${rgb[2]});
        border: 1px solid var(--border);
      `;
      wrap.appendChild(swatch);
    }
    if (typeof a.brightness === "number") {
      const pct = Math.round((a.brightness / 255) * 100);
      const bar = document.createElement("div");
      bar.style.cssText = "flex: 1; min-width: 0;";
      bar.innerHTML = `
        <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 4px;">Brightness ${pct}%</div>
        <div style="height: 8px; border-radius: 4px; background: var(--muted); overflow: hidden;">
          <div style="height: 100%; width: ${pct}%; background: var(--primary, #58a6ff);"></div>
        </div>
      `;
      wrap.appendChild(bar);
    }
    return wrap.children.length > 0 ? wrap : null;
  }

  if (entity.domain === "media_player" && (a.media_title || a.media_artist || a.entity_picture)) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: flex; gap: 12px; align-items: center;";
    if (a.entity_picture) {
      const img = document.createElement("img");
      img.src = a.entity_picture;
      img.style.cssText = "width: 80px; height: 80px; border-radius: 8px; object-fit: cover; flex-shrink: 0;";
      wrap.appendChild(img);
    }
    const info = document.createElement("div");
    info.style.cssText = "min-width: 0; flex: 1;";
    info.innerHTML = `
      ${a.media_title ? `<div style="font-weight:500;font-size:14px;">${escapeHtml(String(a.media_title))}</div>` : ""}
      ${a.media_artist ? `<div style="font-size:12px;color:var(--muted-foreground);">${escapeHtml(String(a.media_artist))}</div>` : ""}
      ${a.media_album_name ? `<div style="font-size:12px;color:var(--muted-foreground);">${escapeHtml(String(a.media_album_name))}</div>` : ""}
    `;
    wrap.appendChild(info);
    return wrap;
  }

  if (entity.domain === "weather") {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px;";
    const cells: Array<[string, string | number | undefined]> = [
      ["Temperature", a.temperature ? `${a.temperature}${a.temperature_unit ?? "°"}` : undefined],
      ["Humidity", a.humidity ? `${a.humidity}%` : undefined],
      ["Pressure", a.pressure ? `${a.pressure} ${a.pressure_unit ?? "hPa"}` : undefined],
      ["Wind", a.wind_speed ? `${a.wind_speed} ${a.wind_speed_unit ?? ""}` : undefined],
      ["Visibility", a.visibility ? `${a.visibility} ${a.visibility_unit ?? ""}` : undefined],
    ];
    for (const [label, val] of cells) {
      if (val == null) continue;
      const cell = document.createElement("div");
      cell.style.cssText = "background: var(--muted); padding: 8px 12px; border-radius: 8px;";
      cell.innerHTML = `<div style="font-size:11px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(label)}</div><div style="font-size:16px;font-weight:500;margin-top:2px;">${escapeHtml(String(val))}</div>`;
      wrap.appendChild(cell);
    }
    return wrap.children.length > 0 ? wrap : null;
  }

  return null;
}

function renderSensorChart(entityId: string): HTMLElement {
  const section = document.createElement("div");
  section.innerHTML = `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--muted-foreground);margin-bottom:8px;">Last 24h</div>`;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position: relative; height: 180px;";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  section.appendChild(wrap);

  (async () => {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 3_600_000);
      const params = new URLSearchParams({ entity_id: entityId, start: start.toISOString(), end: end.toISOString() });
      const res = await fetch(`/history?${params}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json() as Record<string, Array<{ t: string; v: number }>>;
      const points = data[entityId] ?? [];
      if (points.length === 0) {
        section.innerHTML += `<div style="font-size:12px;color:var(--muted-foreground);">No data in last 24h.</div>`;
        wrap.remove();
        return;
      }
      const dark = isDarkMode();
      const grid = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
      const tick = dark ? "rgba(230,237,243,0.7)" : "rgba(60,60,60,0.85)";
      new Chart(canvas, {
        type: "line",
        data: {
          datasets: [{
            data: points.map((p) => ({ x: new Date(p.t).getTime(), y: p.v })),
            borderColor: "#58a6ff",
            backgroundColor: "rgba(88,166,255,0.15)",
            fill: true,
            pointRadius: 0,
            borderWidth: 1.6,
            tension: 0.25,
            spanGaps: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
          scales: {
            x: { type: "time", time: { unit: "hour" }, grid: { color: grid }, ticks: { color: tick, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 } },
            y: { grid: { color: grid }, ticks: { color: tick, font: { size: 10 } } },
          },
        },
      });
    } catch (err) {
      section.innerHTML += `<div style="font-size:12px;color:var(--destructive);">History error: ${(err as Error).message}</div>`;
      wrap.remove();
    }
  })();

  return section;
}
