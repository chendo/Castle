// Main information surface — a grid of area cards. Each card shows a
// one-line ambient summary of "atmosphere" sensors (temp / humidity /
// motion / illuminance) plus shortcut rows for the most-useful
// controllable entities in the area. A "Favourites" pseudo-area pins
// the user's hand-picked entities at the top.
//
// Card content is derived live from EntityStateCache; controls fire
// service calls through the WS service_call frame, same path the
// inline ha_present_card cards use. No agent round-trip on click.

import type { AreaInfo, EntityState, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { entityCache } from "./EntityStateCache";
import { showEntityDetail } from "./EntityDetail";

const FAV_KEY = "castle-sidebar-favourites";
const COLLAPSED_KEY = "castle-dashboard-collapsed";

// Domains a user typically reaches for when they open a room. Lights /
// climate / cover / fan / media-player / switch all map to a single
// short interactive control. Anything outside this list is a "more"
// item that the user can click into for full details.
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

function friendly(s: EntityState): string {
  return (s.attributes?.friendly_name as string | undefined) ?? s.entity_id.split(".").pop() ?? s.entity_id;
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

function pickAmbient(entities: EntityState[]): EntityState[] {
  // Pick at most one of each ambient class, in a stable order. Many
  // areas have multiple temperature sensors; we just take the first.
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
  return `${friendly(s)}: ${v}${unit}`;
}

function pickShortcuts(entities: EntityState[]): EntityState[] {
  // Stable sort: domain priority first, friendly-name alphabetical second.
  // Skip anything we can't actually control with a one-button row.
  const ranked = entities
    .filter((e) => SHORTCUT_PRIORITY[e.domain] !== undefined)
    .filter((e) => e.state !== "unavailable")
    .sort((a, b) => {
      const pa = SHORTCUT_PRIORITY[a.domain] ?? 99;
      const pb = SHORTCUT_PRIORITY[b.domain] ?? 99;
      if (pa !== pb) return pa - pb;
      return friendly(a).localeCompare(friendly(b));
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

// One-line interactive control. For domains where a single-tap action
// is obvious (turn on/off, play/pause, toggle), we show a button. For
// domains without a sensible single-tap (e.g. picking a brightness)
// the row is read-only — user clicks the row to open the detail modal
// for full controls.
function buildShortcutRow(state: EntityState, set: ServiceCaller): HTMLElement {
  const row = el("div", `
    display: flex; align-items: center; gap: 6px; min-height: 24px;
    padding: 2px 0; font-size: 12px; color: var(--foreground);
  `);
  const icon = el("span", "width: 16px; flex-shrink: 0;", domainIcon(state.domain));
  const name = el("span", "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;", friendly(state));
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
      const txt = el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;",
        cur !== undefined && t !== undefined ? `${cur}°→${t}°` : state.state);
      return txt;
    }
  }
  // Read-only fallback — show state.
  return el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;", state.state);
}

// ── Card builder ──────────────────────────────────────────────────────────

interface AreaCardData {
  /** Synthetic id for non-area cards (favourites, no-area). */
  id: string;
  name: string;
  /** All entity states scoped to this card. */
  entities: EntityState[];
  /** True for the synthetic Favourites card so we can style it differently. */
  isFavourites?: boolean;
}

function buildAreaCard(card: AreaCardData, agent: WebSocketRemoteAgent): HTMLElement {
  const root = el("div", `
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--card, var(--background));
  `);

  const header = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 8px;");
  const title = el("div", "font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;", card.name);
  if (card.isFavourites) title.textContent = "★ Favourites";
  const meta = el("div", "font-size: 11px; color: var(--muted-foreground); flex-shrink: 0;",
    `${card.entities.length} entit${card.entities.length === 1 ? "y" : "ies"}`);
  header.append(title, meta);
  root.appendChild(header);

  // Ambient summary row (skipped for the Favourites card — favourites
  // are by definition a hand-picked mix and an ambient row would be
  // misleading).
  if (!card.isFavourites) {
    const ambient = pickAmbient(card.entities);
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
  }

  // Service-call adapter — same path the inline cards use.
  const set: ServiceCaller = (domain, service, entityId, data) =>
    agent.callService(domain, service, entityId, data);

  // Shortcut rows.
  const shortcuts = card.isFavourites
    ? card.entities.filter((e) => SHORTCUT_PRIORITY[e.domain] !== undefined)
    : pickShortcuts(card.entities);
  if (shortcuts.length > 0) {
    const list = el("div", "display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 8px;");
    for (const e of shortcuts) list.appendChild(buildShortcutRow(e, set));
    root.appendChild(list);
  } else if (!card.isFavourites) {
    const empty = el("div", "font-size: 12px; color: var(--muted-foreground); font-style: italic;", "No quick controls in this area.");
    root.appendChild(empty);
  }

  // Footer link — push a present_card prompt into the chat with every
  // entity in this card. Lets the user open the full set in the agent
  // panel without typing anything.
  if (!card.isFavourites && card.entities.length > 0) {
    const ids = card.entities.map((e) => e.entity_id);
    const link = el("button", `
      align-self: flex-start; padding: 0; margin-top: 4px;
      background: transparent; border: none; cursor: pointer;
      font: inherit; font-size: 12px; color: var(--primary, #58a6ff);
    `, `Open in chat ▸`);
    link.onclick = () => {
      const idList = ids.slice(0, 12).map((i) => `\`${i}\``).join(", ");
      const more = ids.length > 12 ? ` (and ${ids.length - 12} more — pick the most relevant)` : "";
      agent.sendRaw({
        type: "prompt",
        text: `Use ha_present_card to show ${idList}${more} with title "${card.name}".`,
      });
    };
    root.appendChild(link);
  }

  return root;
}

// ── Public entry point ────────────────────────────────────────────────────

export interface DashboardHandle {
  root: HTMLElement;
  /** Toggle visibility (e.g. keyboard shortcut to hide and give the
   *  agent more room). */
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

  const grid = el("div", `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    align-content: start;
  `);
  root.appendChild(grid);

  // RAF-coalesce — same pattern as the sidebar; bursts of state changes
  // collapse to one repaint per frame.
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

  function render(): void {
    grid.innerHTML = "";
    if (states.size === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;color:var(--muted-foreground);font-size:13px;">Waiting for state…</div>`;
      return;
    }

    // Favourites card pulls hand-picked entities across all areas to
    // the top of the dashboard.
    const favouriteIds = readSet(FAV_KEY);
    const favouriteEntities = [...favouriteIds]
      .map((id) => states.get(id))
      .filter((e): e is EntityState => !!e);
    if (favouriteEntities.length > 0) {
      grid.appendChild(buildAreaCard({
        id: "__favourites__",
        name: "Favourites",
        entities: favouriteEntities,
        isFavourites: true,
      }, agent));
    }

    // Bucket every entity into its area.
    const entityArea = entityCache.getEntityAreaMap();
    const buckets = new Map<string, EntityState[]>();
    for (const a of areas) buckets.set(a.area_id, []);
    for (const e of states.values()) {
      const aid = entityArea.get(e.entity_id);
      if (!aid) continue;
      const bucket = buckets.get(aid);
      if (bucket) bucket.push(e);
    }

    // Render one card per area, in alphabetical order, regardless of
    // whether it has controllable entities.
    for (const a of [...areas].sort((x, y) => x.name.localeCompare(y.name))) {
      const entities = buckets.get(a.area_id) ?? [];
      grid.appendChild(buildAreaCard({
        id: a.area_id,
        name: a.name,
        entities,
      }, agent));
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
  // Favourites are stored in localStorage and changed from the sidebar.
  // Cheapest cross-component signal: re-render on the storage event
  // (fires only for cross-tab writes, but EntityStateCache.subscribeAll
  // re-fires on most state changes anyway, so the only "miss" is when
  // the user toggles a star without anything else changing — a corner
  // case worth a tiny poll).
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
