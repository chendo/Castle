// Per-domain entity-card builder for ha_present_card. Returns a DOM
// element that:
//   - Renders rich, domain-appropriate UI (toggle for switches, slider for
//     lights, target-temp control for climate, etc.).
//   - Subscribes to entity-state changes via EntityStateCache so the card
//     updates live as state changes (HA push, agent action, anywhere).
//   - For interactive controls, fires service calls through the agent's
//     /ws service_call frame — bypasses the LLM loop so a click is one
//     network hop, not an agent turn.
//
// Entry point: buildEntityCard(spec, deps, container) → { dispose }.
// Caller owns the container; we mount a single child element and return a
// dispose() that tears down subscriptions when the card is replaced.

import type { EntityState, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import type { EntityStateCache } from "./EntityStateCache";
import { showEntityDetail } from "./EntityDetail";
import { entityLabel } from "./EntityLabel";

export interface CardSpec {
  entity_id: string;
  kind: string;        // "entity" | "fallback" (cameras handled elsewhere)
  domain: string;
}

export interface CardDeps {
  cache: EntityStateCache;
  agent: WebSocketRemoteAgent;
}

export interface CardHandle {
  dispose: () => void;
}

const SUPPORT_BRIGHTNESS = 1;       // bit 0 of light's supported_features
const SUPPORT_OPEN = 1;
const SUPPORT_CLOSE = 2;
const SUPPORT_SET_POSITION = 4;
const SUPPORT_STOP = 8;

// ── Style helpers ──────────────────────────────────────────────────────────

// Cap card width — full-width control cards in a wide chat column make the
// brightness/temperature sliders feel oversized and the card looks empty
// next to its header. 360px sits between a phone widget and a desktop
// dashboard tile, with room for ~6 chars of icon + ~28 chars of name.
const CARD_BASE = `
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--card, var(--background)); color: var(--foreground);
  font: 13px ui-sans-serif, system-ui, sans-serif;
  max-width: 360px;
`;

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function friendly(state: EntityState | null, fallback: string): string {
  if (!state) return fallback;
  return entityLabel(state);
}

function header(state: EntityState | null, entityId: string, badge?: string): HTMLElement {
  const h = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 12px;");
  const left = el("div", "min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500;", friendly(state, entityId));
  const right = el("div", "font-size: 11px; color: var(--muted-foreground); flex-shrink: 0; font-family: ui-monospace, monospace;", entityId);
  h.append(left, right);
  if (badge !== undefined) {
    const b = el("span", "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--muted, transparent); color: var(--muted-foreground); border: 1px solid var(--border); margin-left: 8px;", badge);
    right.before(b);
  }
  return h;
}

// ── Per-domain bodies ──────────────────────────────────────────────────────
//
// Each builder returns a DOM fragment that's appended to the card. Every
// builder accepts the live state (or null when unknown) plus a `set` helper
// to fire service calls; service-call promises resolve with {ok, error?}
// so the card can flag errors visually.

type ServiceCaller = (
  domain: string,
  service: string,
  serviceData?: Record<string, unknown>,
) => Promise<{ ok: boolean; error?: string }>;

function buildToggleBody(
  state: EntityState | null,
  set: ServiceCaller,
  domain: string,
): HTMLElement {
  const wrap = el("div", "display: flex; align-items: center; justify-content: space-between; gap: 12px;");
  const stateText = el("span", "font-size: 13px; color: var(--foreground);", state?.state ?? "unknown");
  const btn = el("button", `
    padding: 4px 14px; font-size: 12px; cursor: pointer;
    border-radius: 6px; border: 1px solid var(--border);
    background: ${state?.state === "on" ? "var(--primary, #58a6ff)" : "transparent"};
    color: ${state?.state === "on" ? "var(--primary-foreground, white)" : "var(--foreground)"};
  `);
  // Label = current state. Click toggles.
  btn.textContent = state?.state === "on" ? "On" : "Off";
  btn.title = state?.state === "on" ? "Click to turn off" : "Click to turn on";
  btn.onclick = async () => {
    btn.disabled = true;
    const next = state?.state === "on" ? "turn_off" : "turn_on";
    const r = await set(domain, next);
    btn.disabled = false;
    if (!r.ok) console.warn(`[entity-card] ${domain}.${next} failed:`, r.error);
  };
  wrap.append(stateText, btn);
  return wrap;
}

function buildLightBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
  const isOn = state?.state === "on";
  const brightness = Number(state?.attributes?.brightness ?? 0); // 0..255
  // Modern HA tracks brightness via supported_color_modes (anything but
  // "onoff" implies brightness is settable). Legacy installs use bit 0
  // of supported_features. Fall back to "brightness attribute exists at
  // all" as a third signal — covers anything that has reported a level
  // even if neither feature flag is set right.
  const colorModes = state?.attributes?.supported_color_modes as string[] | undefined;
  const hasColorModeBrightness = Array.isArray(colorModes) && colorModes.some((m) => m !== "onoff");
  const supportedFeatures = Number(state?.attributes?.supported_features ?? 0);
  const hasLegacyBrightness = (supportedFeatures & SUPPORT_BRIGHTNESS) !== 0;
  const hasBrightnessAttr = state?.attributes?.brightness !== undefined;
  const supportsBrightness = hasColorModeBrightness || hasLegacyBrightness || hasBrightnessAttr;

  const row = el("div", "display: flex; align-items: center; justify-content: space-between; gap: 12px;");
  const stateText = el("span", "font-size: 13px; color: var(--foreground);", isOn ? `${Math.round((brightness / 255) * 100)}%` : "off");
  const btn = el("button", `
    padding: 4px 14px; font-size: 12px; cursor: pointer;
    border-radius: 6px; border: 1px solid var(--border);
    background: ${isOn ? "var(--primary, #58a6ff)" : "transparent"};
    color: ${isOn ? "var(--primary-foreground, white)" : "var(--foreground)"};
  `);
  btn.textContent = isOn ? "On" : "Off";
  btn.title = isOn ? "Click to turn off" : "Click to turn on";
  btn.onclick = async () => {
    btn.disabled = true;
    const next = isOn ? "turn_off" : "turn_on";
    const r = await set("light", next);
    btn.disabled = false;
    if (!r.ok) console.warn(`[entity-card] light.${next} failed:`, r.error);
  };
  row.append(stateText, btn);
  wrap.appendChild(row);

  // Always render the brightness slider for dimmable lights, on or off.
  // When off, dragging the slider turns the light on at the chosen
  // brightness in one service call (HA's turn_on accepts brightness_pct
  // as both "set value" and "turn on"). UX-wise this is what the user
  // expects: see the slider, want this brightness, drag to set.
  if (supportsBrightness) {
    const sliderRow = el("div", "display: flex; align-items: center; gap: 8px;");
    const slider = el("input", "flex: 1;");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(isOn ? Math.round((brightness / 255) * 100) : 0);
    const valueLabel = el("span", "font-size: 11px; color: var(--foreground); min-width: 36px; text-align: right;", `${slider.value}%`);
    slider.oninput = () => { valueLabel.textContent = `${slider.value}%`; };
    let scheduled = false;
    slider.onchange = async () => {
      if (scheduled) return;
      scheduled = true;
      const pct = Number(slider.value);
      // 0% is "turn off"; everything else turns on at that level.
      const r = pct === 0
        ? await set("light", "turn_off")
        : await set("light", "turn_on", { brightness_pct: pct });
      scheduled = false;
      if (!r.ok) console.warn(`[entity-card] light brightness ${pct}% failed:`, r.error);
    };
    sliderRow.append(slider, valueLabel);
    wrap.appendChild(sliderRow);
  }
  return wrap;
}

function buildCoverBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const supported = Number(state?.attributes?.supported_features ?? 0);
  const wrap = el("div", "display: flex; align-items: center; justify-content: space-between; gap: 12px;");
  const stateText = el("span", "font-size: 13px; color: var(--foreground);", state?.state ?? "unknown");
  const btnGroup = el("div", "display: flex; gap: 6px;");
  const mkBtn = (label: string, svc: string) => {
    const b = el("button", `
      padding: 4px 10px; font-size: 12px; cursor: pointer;
      border-radius: 6px; border: 1px solid var(--border);
      background: transparent; color: var(--foreground);
    `, label);
    b.onclick = async () => { b.disabled = true; await set("cover", svc); b.disabled = false; };
    return b;
  };
  if (supported & SUPPORT_OPEN) btnGroup.appendChild(mkBtn("Open", "open_cover"));
  if (supported & SUPPORT_CLOSE) btnGroup.appendChild(mkBtn("Close", "close_cover"));
  if (supported & SUPPORT_STOP) btnGroup.appendChild(mkBtn("Stop", "stop_cover"));
  // No-feature cover still gets toggle as a fallback.
  if (btnGroup.children.length === 0) {
    btnGroup.appendChild(mkBtn("Toggle", "toggle"));
  }
  wrap.append(stateText, btnGroup);
  void supported;
  void SUPPORT_SET_POSITION;
  return wrap;
}

function buildClimateBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
  const current = state?.attributes?.current_temperature;
  const target = Number(state?.attributes?.temperature ?? NaN);
  const unit = (state?.attributes?.temperature_unit as string | undefined) ?? "°";
  const mode = state?.state ?? "unknown";
  const minTemp = Number(state?.attributes?.min_temp ?? 7);
  const maxTemp = Number(state?.attributes?.max_temp ?? 35);
  const step = Number(state?.attributes?.target_temp_step ?? 0.5);

  const row = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 12px;");
  const left = el("div", "font-size: 13px; color: var(--foreground);");
  left.innerHTML = `${current !== undefined ? `${current}${unit}` : "—"} <span style="color: var(--muted-foreground); font-size: 11px;">now</span> · <span style="color: var(--foreground);">${Number.isFinite(target) ? `${target}${unit}` : "—"}</span> <span style="font-size: 11px;">target</span>`;
  const modeBadge = el("span", "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--muted, transparent); color: var(--foreground); border: 1px solid var(--border);", mode);
  row.append(left, modeBadge);
  wrap.appendChild(row);

  if (Number.isFinite(target) && Number.isFinite(minTemp) && Number.isFinite(maxTemp) && minTemp < maxTemp) {
    const ctrl = el("div", "display: flex; gap: 6px; align-items: center;");
    const dec = el("button", "padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--foreground);", "−");
    const inc = el("button", "padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--foreground);", "+");
    const slider = el("input", "flex: 1;");
    slider.type = "range";
    slider.min = String(minTemp);
    slider.max = String(maxTemp);
    slider.step = String(step);
    slider.value = String(target);
    let pending: number | null = null;
    let scheduled = false;
    slider.oninput = () => { pending = Number(slider.value); };
    slider.onchange = async () => {
      if (pending === null || scheduled) return;
      scheduled = true;
      const v = pending;
      pending = null;
      await set("climate", "set_temperature", { temperature: v });
      scheduled = false;
    };
    dec.onclick = async () => {
      dec.disabled = true;
      await set("climate", "set_temperature", { temperature: target - step });
      dec.disabled = false;
    };
    inc.onclick = async () => {
      inc.disabled = true;
      await set("climate", "set_temperature", { temperature: target + step });
      inc.disabled = false;
    };
    ctrl.append(dec, slider, inc);
    wrap.appendChild(ctrl);
  }
  return wrap;
}

function buildSensorBody(state: EntityState | null, entityId: string): HTMLElement {
  const wrap = el("div", "display: flex; flex-direction: column; gap: 8px;");
  const headRow = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 12px;");
  const value = state?.state ?? "—";
  const unit = (state?.attributes?.unit_of_measurement as string | undefined) ?? "";
  const left = el("span", "font-size: 18px; font-weight: 500;");
  left.innerHTML = `${escapeAttr(value)}${unit ? ` <span style="font-size: 13px; color: var(--muted-foreground); font-weight: normal;">${escapeAttr(unit)}</span>` : ""}`;
  const cls = state?.attributes?.device_class as string | undefined;
  if (cls) {
    const right = el("span", "font-size: 11px; color: var(--muted-foreground);", cls);
    headRow.append(left, right);
  } else {
    headRow.append(left);
  }
  wrap.appendChild(headRow);

  // Numeric sensor → fetch 24h history and render a sparkline. Skip for
  // string-state sensors (door/locked/etc.) — a line chart isn't useful
  // there. The chart is async; we fire and forget. Slot exists from
  // first paint so layout doesn't shift when the chart lands.
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const slot = el("div", "height: 38px;");
    wrap.appendChild(slot);
    fetchAndRenderSparkline(entityId, slot).catch(() => { /* best-effort; leave empty */ });
  }
  return wrap;
}

/** Fetch the last 24 h of history for a numeric sensor and draw a small
 *  SVG sparkline into `slot`. Errors are swallowed; an empty slot is
 *  fine — the headline current value above carries the signal regardless. */
async function fetchAndRenderSparkline(entityId: string, slot: HTMLElement): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3_600_000);
  const url = `/history?entity_id=${encodeURIComponent(entityId)}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
  let data: Record<string, Array<{ t: string; v: number }>>;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`history ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`[entity-card] sparkline fetch failed for ${entityId}:`, (err as Error).message);
    return;
  }
  const points = data[entityId] ?? [];
  if (points.length < 2) return;

  const W = 320;
  const H = 38;
  const PAD = 2;
  const xs = points.map((p) => new Date(p.t).getTime());
  const ys = points.map((p) => p.v);
  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const sx = (x: number) => PAD + ((x - xMin) / (xMax - xMin)) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);

  const path = points.map((p, i) => {
    const X = sx(xs[i]).toFixed(1);
    const Y = sy(p.v).toFixed(1);
    return `${i === 0 ? "M" : "L"}${X},${Y}`;
  }).join(" ");

  const last = points[points.length - 1].v;
  const lastX = sx(xs[xs.length - 1]).toFixed(1);
  const lastY = sy(last).toFixed(1);

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width: 100%; height: 100%; display: block;">
    <path d="${path}" fill="none" stroke="var(--primary, #58a6ff)" stroke-width="1.5" />
    <circle cx="${lastX}" cy="${lastY}" r="2" fill="var(--primary, #58a6ff)" />
  </svg>`;
  slot.innerHTML = svg;
  slot.title = `${points.length} points · ${yMin.toFixed(2)}…${yMax.toFixed(2)} over last 24h`;
}

function buildBinarySensorBody(state: EntityState | null): HTMLElement {
  const isOn = state?.state === "on";
  const wrap = el("div", "display: flex; align-items: center; justify-content: space-between; gap: 12px;");
  const dot = el("span", `
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    background: ${isOn ? "#10b981" : "#6b7280"};
  `);
  const left = el("div", "display: flex; align-items: center; gap: 8px;");
  const txt = el("span", "font-size: 13px;", isOn ? "Detected / on" : "Clear / off");
  left.append(dot, txt);
  const cls = state?.attributes?.device_class as string | undefined;
  const right = el("span", "font-size: 11px; color: var(--muted-foreground);", cls ?? "");
  wrap.append(left, right);
  return wrap;
}

function buildWeatherBody(state: EntityState | null): HTMLElement {
  const wrap = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 12px;");
  const condition = state?.state ?? "—";
  const temp = state?.attributes?.temperature;
  const unit = (state?.attributes?.temperature_unit as string | undefined) ?? "°";
  const left = el("span", "font-size: 18px; font-weight: 500;");
  left.innerHTML = `${temp !== undefined ? `${temp}${unit}` : "—"} <span style="font-size: 13px; color: var(--muted-foreground); font-weight: normal;">${escapeAttr(condition)}</span>`;
  const humidity = state?.attributes?.humidity;
  const right = el("span", "font-size: 11px; color: var(--muted-foreground);", humidity !== undefined ? `${humidity}% RH` : "");
  wrap.append(left, right);
  return wrap;
}

function buildMediaPlayerBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const wrap = el("div", "display: flex; flex-direction: column; gap: 6px;");
  const title = state?.attributes?.media_title as string | undefined;
  const artist = state?.attributes?.media_artist as string | undefined;
  const playing = state?.state === "playing";

  const row1 = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 12px;");
  const left = el("div", "min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
  left.innerHTML = title
    ? `<strong>${escapeAttr(title)}</strong>${artist ? ` <span style="color: var(--muted-foreground); font-size: 12px;">${escapeAttr(artist)}</span>` : ""}`
    : `<span style="color: var(--muted-foreground);">${escapeAttr(state?.state ?? "—")}</span>`;
  const stateBadge = el("span", "font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--muted, transparent); color: var(--muted-foreground); border: 1px solid var(--border);", state?.state ?? "—");
  row1.append(left, stateBadge);
  wrap.appendChild(row1);

  const ctrl = el("div", "display: flex; gap: 6px;");
  const mkBtn = (label: string, svc: string) => {
    const b = el("button", "padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--foreground);", label);
    b.onclick = async () => { b.disabled = true; await set("media_player", svc); b.disabled = false; };
    return b;
  };
  ctrl.appendChild(mkBtn(playing ? "Pause" : "Play", "media_play_pause"));
  ctrl.appendChild(mkBtn("Stop", "media_stop"));
  ctrl.appendChild(mkBtn("Next", "media_next_track"));
  wrap.appendChild(ctrl);
  return wrap;
}

function buildInputNumberBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const wrap = el("div", "display: flex; align-items: center; gap: 8px;");
  const min = Number(state?.attributes?.min ?? 0);
  const max = Number(state?.attributes?.max ?? 100);
  const step = Number(state?.attributes?.step ?? 1);
  const value = Number(state?.state ?? min);
  const slider = el("input", "flex: 1;");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const valueLabel = el("span", "font-size: 13px; min-width: 48px; text-align: right;", String(value));
  slider.oninput = () => { valueLabel.textContent = slider.value; };
  let scheduled = false;
  slider.onchange = async () => {
    if (scheduled) return;
    scheduled = true;
    await set("input_number", "set_value", { value: Number(slider.value) });
    scheduled = false;
  };
  wrap.append(slider, valueLabel);
  return wrap;
}

function buildInputSelectBody(state: EntityState | null, set: ServiceCaller): HTMLElement {
  const wrap = el("div", "display: flex; align-items: center; justify-content: space-between; gap: 8px;");
  const options = (state?.attributes?.options as string[] | undefined) ?? [];
  const select = el("select", "padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;");
  for (const opt of options) {
    const o = el("option");
    o.value = opt;
    o.textContent = opt;
    select.appendChild(o);
  }
  if (state?.state) select.value = state.state;
  select.onchange = async () => {
    select.disabled = true;
    await set("input_select", "select_option", { option: select.value });
    select.disabled = false;
  };
  wrap.appendChild(select);
  return wrap;
}

function buildFallbackBody(state: EntityState | null): HTMLElement {
  // For domains we don't have a tailored card for. Show the headline state
  // plus a few key attributes so the card carries some signal.
  const wrap = el("div", "display: flex; flex-direction: column; gap: 4px;");
  const head = el("div", "font-size: 13px;", state ? `${state.state}` : "(unknown)");
  wrap.appendChild(head);
  if (state?.attributes) {
    const keys = ["device_class", "unit_of_measurement", "friendly_name"]
      .filter((k) => state.attributes[k] !== undefined && state.attributes[k] !== state.attributes.friendly_name);
    if (keys.length > 0) {
      const sub = el("div", "font-size: 11px; color: var(--muted-foreground);", keys.map((k) => `${k}: ${state.attributes[k]}`).join(" · "));
      wrap.appendChild(sub);
    }
  }
  return wrap;
}

// ── Public entry point ─────────────────────────────────────────────────────

export function buildEntityCard(
  spec: CardSpec,
  deps: CardDeps,
  container: HTMLElement,
): CardHandle {
  container.style.cssText = CARD_BASE;
  container.innerHTML = "";

  const set: ServiceCaller = (domain, service, serviceData) =>
    deps.agent.callService(domain, service, spec.entity_id, serviceData);

  const draw = (state: EntityState | null) => {
    container.innerHTML = "";
    const head = header(state, spec.entity_id);
    // Title is the entry point to the full entity-detail modal — same
    // shortcut as clicking an entity in the sidebar. We bind on the
    // header's "left" cell (the friendly name) so the right-side
    // entity_id label and any badges remain non-interactive.
    const titleCell = head.firstElementChild as HTMLElement | null;
    if (titleCell) {
      titleCell.style.cursor = "pointer";
      titleCell.title = "Open details";
      titleCell.onclick = () => {
        const latest = state ?? {
          entity_id: spec.entity_id,
          state: "unknown",
          attributes: {},
          domain: spec.domain,
          exposed: true,
        };
        showEntityDetail(latest);
      };
    }
    container.appendChild(head);
    let body: HTMLElement;
    switch (spec.domain) {
      case "switch":
      case "input_boolean":
      case "fan":
        body = buildToggleBody(state, set, spec.domain);
        break;
      case "light":
        body = buildLightBody(state, set);
        break;
      case "cover":
        body = buildCoverBody(state, set);
        break;
      case "climate":
        body = buildClimateBody(state, set);
        break;
      case "sensor":
        body = buildSensorBody(state, spec.entity_id);
        break;
      case "binary_sensor":
        body = buildBinarySensorBody(state);
        break;
      case "weather":
        body = buildWeatherBody(state);
        break;
      case "media_player":
        body = buildMediaPlayerBody(state, set);
        break;
      case "input_number":
        body = buildInputNumberBody(state, set);
        break;
      case "input_select":
        body = buildInputSelectBody(state, set);
        break;
      default:
        body = buildFallbackBody(state);
    }
    container.appendChild(body);
  };

  const unsubscribe = deps.cache.subscribeEntity(spec.entity_id, draw);
  return {
    dispose: () => { unsubscribe(); },
  };
}
