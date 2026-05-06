// Main information surface — two stacked sections:
//   ★ Favourites — the user's hand-picked entities, each rendered as a
//                  full domain-tailored EntityCard (slider for lights,
//                  setpoint for climate, transport for media, etc.) so
//                  the dashboard *is* the control surface for them.
//   Areas        — one summary card per area: ambient sensors + a
//                  short list of shortcut rows + an "Open in chat" link
//                  for full agent-mediated control.
//
// Cards subscribe to EntityStateCache; controls fire ha_call_service
// over the WS service_call frame, same path the chat-inline cards use.
//
// Visibility filter: only entities exposed to the agent are surfaced
// here, matching the sidebar's "Hide non-exposed" default. Anything
// non-exposed is one click away in the sidebar (which has the
// per-entity eye toggle).

import type { AreaInfo, EntityState, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { entityCache } from "./EntityStateCache";
import { showEntityDetail } from "./EntityDetail";
import { entityLabel } from "./EntityLabel";
import { buildEntityCard } from "./EntityCard";

const FAV_KEY = "castle-sidebar-favourites";
const COLLAPSED_KEY = "castle-dashboard-collapsed";

// Domains a user typically reaches for when they open a room. Shortcut
// rows are reserved for these; anything outside is "more" the user can
// reach via the chat link.
const SHORTCUT_PRIORITY: Record<string, number> = {
  light: 1,
  climate: 2,
  cover: 3,
  media_player: 4,
  fan: 5,
  switch: 6,
  input_boolean: 7,
  scene: 8,
};
const MAX_SHORTCUTS = 5;

// Domains that count as "ambient" sensors for the area summary.
const AMBIENT_DEVICE_CLASSES = new Set([
  "temperature", "humidity", "illuminance", "motion", "occupancy",
]);

interface ServiceCaller {
  (domain: string, service: string, entityId: string, data?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function isCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

function setCollapsed(v: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

function isExposed(e: EntityState): boolean {
  return e.exposed !== false;
}

function pickAmbient(entities: EntityState[]): EntityState[] {
  const seen = new Set<string>();
  const out: EntityState[] = [];
  for (const klass of ["temperature", "humidity", "motion", "occupancy", "illuminance"]) {
    const m = entities.find((e) => {
      const dc = (e.attributes?.device_class as string | undefined) ?? "";
      return AMBIENT_DEVICE_CLASSES.has(dc) && dc === klass && !seen.has(e.entity_id);
    });
    if (m) {
      seen.add(m.entity_id);
      out.push(m);
    }
  }
  return out;
}

function formatAmbient(s: EntityState): string {
  const dc = (s.attributes?.device_class as string | undefined) ?? "";
  const unit = (s.attributes?.unit_of_measurement as string | undefined) ?? "";
  const v = s.state;
  if (dc === "motion" || dc === "occupancy") {
    return `${dc === "motion" ? "🚶" : "👤"} ${v === "on" ? "yes" : "no"}`;
  }
  if (dc === "temperature") return `🌡 ${v}${unit}`;
  if (dc === "humidity") return `💧 ${v}${unit}`;
  if (dc === "illuminance") return `☀ ${v}${unit}`;
  return `${entityLabel(s)}: ${v}${unit}`;
}

function pickShortcuts(entities: EntityState[]): EntityState[] {
  const ranked = entities
    .filter((e) => SHORTCUT_PRIORITY[e.domain] !== undefined)
    .filter((e) => e.state !== "unavailable")
    .sort((a, b) => {
      const pa = SHORTCUT_PRIORITY[a.domain] ?? 99;
      const pb = SHORTCUT_PRIORITY[b.domain] ?? 99;
      if (pa !== pb) return pa - pb;
      return entityLabel(a).localeCompare(entityLabel(b));
    });
  return ranked.slice(0, MAX_SHORTCUTS);
}

function domainIcon(domain: string): string {
  switch (domain) {
    case "light": return "💡";
    case "climate": return "🌡";
    case "cover": return "🪟";
    case "fan": return "🌀";
    case "media_player": return "🎵";
    case "switch": return "🔌";
    case "input_boolean": return "⚐";
    case "scene": return "🎬";
    default: return "•";
  }
}

function buildShortcutRow(state: EntityState, set: ServiceCaller): HTMLElement {
  const row = el("div", `
    display: flex; align-items: center; gap: 6px; min-height: 24px;
    padding: 2px 0; font-size: 12px; color: var(--foreground);
  `);
  const icon = el("span", "width: 16px; flex-shrink: 0;", domainIcon(state.domain));
  const name = el("span", "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;", entityLabel(state));
  name.title = state.entity_id;
  name.style.cursor = "pointer";
  name.onclick = () => showEntityDetail(state);

  const action = buildAction(state, set);

  row.append(icon, name, action);
  return row;
}

function buildAction(state: EntityState, set: ServiceCaller): HTMLElement {
  const isOn = state.state === "on" || state.state === "playing" || state.state === "open";
  const padBtn = "padding: 2px 8px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border); flex-shrink: 0; line-height: 1.4;";
  const onBg = `background: var(--primary, #58a6ff); color: var(--primary-foreground, white);`;
  const offBg = `background: transparent; color: var(--foreground);`;

  switch (state.domain) {
    case "light":
    case "switch":
    case "input_boolean":
    case "fan": {
      const btn = el("button", padBtn + (isOn ? onBg : offBg), isOn ? "Off" : "On");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set(state.domain, isOn ? "turn_off" : "turn_on", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "scene": {
      const btn = el("button", padBtn + offBg, "Activate");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set("scene", "turn_on", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "cover": {
      const btn = el("button", padBtn + (isOn ? onBg : offBg), isOn ? "Close" : "Open");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set("cover", isOn ? "close_cover" : "open_cover", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "media_player": {
      const btn = el("button", padBtn + offBg, isOn ? "⏸" : "▶");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set("media_player", isOn ? "media_pause" : "media_play", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "climate": {
      const t = state.attributes?.temperature;
      const cur = state.attributes?.current_temperature;
      return el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;",
        cur !== undefined && t !== undefined ? `${cur}°→${t}°` : state.state);
    }
  }
  return el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;", state.state);
}

// ── Area card (summary + shortcuts) ───────────────────────────────────────

function buildAreaCard(opts: {
  name: string;
  entities: EntityState[];
  agent: WebSocketRemoteAgent;
}): HTMLElement {
  const root = el("div", `
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--card, var(--background));
  `);

  const header = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 8px;");
  const title = el("div", "font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", opts.name);
  const meta = el("div", "font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;",
    `${opts.entities.length} entit${opts.entities.length === 1 ? "y" : "ies"}`);
  header.append(title, meta);
  root.appendChild(header);

  const ambient = pickAmbient(opts.entities);
  if (ambient.length > 0) {
    const row = el("div", "font-size: 12px; color: var(--muted-foreground); display: flex; flex-wrap: wrap; gap: 10px;");
    for (const a of ambient) {
      const chip = el("span", "white-space: nowrap;", formatAmbient(a));
      chip.title = a.entity_id;
      chip.style.cursor = "pointer";
      chip.onclick = () => showEntityDetail(a);
      row.appendChild(chip);
    }
    root.appendChild(row);
  }

  const set: ServiceCaller = (domain, service, entityId, data) =>
    opts.agent.callService(domain, service, entityId, data);

  const shortcuts = pickShortcuts(opts.entities);
  if (shortcuts.length > 0) {
    const list = el("div", "display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 8px;");
    for (const e of shortcuts) list.appendChild(buildShortcutRow(e, set));
    root.appendChild(list);
  } else {
    root.appendChild(el("div", "font-size: 12px; color: var(--muted-foreground); font-style: italic;", "No quick controls in this area."));
  }

  if (opts.entities.length > 0) {
    const ids = opts.entities.map((e) => e.entity_id);
    const link = el("button", `
      align-self: flex-start; padding: 0; margin-top: 4px;
      background: transparent; border: none; cursor: pointer;
      font: inherit; font-size: 12px; color: var(--primary, #58a6ff);
    `, `Open in chat ▸`);
    link.onclick = () => {
      const idList = ids.slice(0, 12).map((i) => `\`${i}\``).join(", ");
      const more = ids.length > 12 ? ` (and ${ids.length - 12} more — pick the most relevant)` : "";
      opts.agent.sendRaw({
        type: "prompt",
        text: `Use ha_present_card to show ${idList}${more} with title "${opts.name}".`,
      });
    };
    root.appendChild(link);
  }

  return root;
}

// ── Public entry point ────────────────────────────────────────────────────

export interface DashboardHandle {
  root: HTMLElement;
  toggle: () => void;
}

export function buildDashboard(agent: WebSocketRemoteAgent): DashboardHandle {
  const root = el("section", `
    flex: 1 1 0; min-width: 0; min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    background: var(--background);
    transition: margin-left 200ms ease;
  `);
  if (isCollapsed()) {
    root.style.display = "none";
  }

  const heading = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 10px;", "Dashboard");
  root.appendChild(heading);

  // Two stacked grids: Favourites (full entity cards) over Areas
  // (summary cards). Both auto-fill at 280px so the dashboard adapts
  // to whatever width the chat column leaves it.
  const favSection = el("section", "margin-bottom: 18px;");
  const favHeader = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 8px;", "★ Favourites");
  const favGrid = el("div", `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 360px));
    gap: 12px;
    align-content: start;
  `);
  favSection.append(favHeader, favGrid);
  favSection.style.display = "none"; // toggled in render() based on count

  const areaHeader = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 8px;", "Areas");
  const areaGrid = el("div", `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    align-content: start;
  `);

  root.append(favSection, areaHeader, areaGrid);

  // ── State + render ────────────────────────────────────────────────────
  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  let states = new Map<string, EntityState>();
  let areas: AreaInfo[] = [];

  // Per-favourite EntityCard handles. We only rebuild the card when the
  // favourite set changes; mid-stream state changes flow through the
  // card's own EntityStateCache subscription.
  const favCards = new Map<string, { handle: { dispose: () => void }; slot: HTMLElement }>();

  function reconcileFavourites(): void {
    const wantedIds = new Set<string>();
    for (const id of readSet(FAV_KEY)) {
      const e = states.get(id);
      if (!e || !isExposed(e)) continue;
      wantedIds.add(id);
    }

    // Remove cards for entities that are no longer favourited / exposed.
    for (const [id, { handle, slot }] of favCards) {
      if (!wantedIds.has(id)) {
        handle.dispose();
        slot.remove();
        favCards.delete(id);
      }
    }

    // Add cards for newly-favourited entities, in stable alphabetical order
    // so reordering doesn't jump the layout around.
    const ordered = [...wantedIds]
      .map((id) => states.get(id)!)
      .sort((a, b) => entityLabel(a).localeCompare(entityLabel(b)));
    favGrid.innerHTML = "";
    for (const e of ordered) {
      let entry = favCards.get(e.entity_id);
      if (!entry) {
        const slot = el("div");
        const handle = buildEntityCard(
          { entity_id: e.entity_id, kind: "entity", domain: e.domain },
          { agent, cache: entityCache },
          slot,
        );
        entry = { handle, slot };
        favCards.set(e.entity_id, entry);
      }
      favGrid.appendChild(entry.slot);
    }

    favSection.style.display = ordered.length > 0 ? "" : "none";
  }

  function render(): void {
    if (states.size === 0) {
      areaGrid.innerHTML = `<div style="grid-column:1/-1;color:var(--muted-foreground);font-size:13px;">Waiting for state…</div>`;
      return;
    }

    reconcileFavourites();

    // Area cards: bucket exposed entities by area; render one card per
    // area regardless of whether it has controllable entities.
    const entityArea = entityCache.getEntityAreaMap();
    const buckets = new Map<string, EntityState[]>();
    for (const a of areas) buckets.set(a.area_id, []);
    for (const e of states.values()) {
      if (!isExposed(e)) continue;
      const aid = entityArea.get(e.entity_id);
      if (!aid) continue;
      const bucket = buckets.get(aid);
      if (bucket) bucket.push(e);
    }

    areaGrid.innerHTML = "";
    for (const a of [...areas].sort((x, y) => x.name.localeCompare(y.name))) {
      const entities = buckets.get(a.area_id) ?? [];
      areaGrid.appendChild(buildAreaCard({ name: a.name, entities, agent }));
    }
  }

  entityCache.subscribeAll((all) => {
    states = new Map(all.map((e) => [e.entity_id, e]));
    requestRender();
  });
  entityCache.subscribeAreas((next) => {
    areas = next;
    requestRender();
  });
  globalThis.addEventListener("storage", (e) => {
    if (e.key === FAV_KEY) requestRender();
  });
  globalThis.addEventListener("castle-favourites-changed", () => requestRender());

  return {
    root,
    toggle: () => {
      const collapsed = root.style.display === "none";
      root.style.display = collapsed ? "" : "none";
      setCollapsed(!collapsed);
    },
  };
}
