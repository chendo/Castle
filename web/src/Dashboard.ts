// Main information surface — two stacked sections:
//   ★ Favourites — the user's hand-picked entities, each rendered as a
//                  full domain-tailored EntityCard (slider for lights,
//                  setpoint for climate, transport for media, etc.).
//   Areas        — one summary card per area: ambient sensors + a
//                  short list of shortcut rows.
//
// State flows through EntityStateCache. Each shortcut row owns its own
// per-entity subscription, so a state-change burst only patches the
// rows whose entities actually changed — buttons stay attached, click
// handlers don't get torn out from under a mid-click. Tearing down the
// whole grid on every state change (which is what the previous version
// did) is the reason the toggle buttons felt unresponsive.
//
// Visibility:
//   - Only entities exposed to the agent are surfaced here.
//   - The user can hide areas they don't care about; hidden areas
//     come back via a "Show hidden" checkbox.

import type { AreaInfo, EntityState, TimelineEvent, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { entityCache } from "./EntityStateCache";
import { showEntityDetail } from "./EntityDetail";
import { entityLabel } from "./EntityLabel";
import { buildEntityCard } from "./EntityCard";

const FAV_KEY = "castle-sidebar-favourites";
const COLLAPSED_KEY = "castle-dashboard-collapsed";
const HIDDEN_AREAS_KEY = "castle-dashboard-hidden-areas";
const SHOW_HIDDEN_KEY = "castle-dashboard-show-hidden";
const ACTIVITY_COLLAPSED_KEY = "castle-dashboard-activity-collapsed";

const ACTIVITY_INITIAL_VISIBLE = 8;

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

const AMBIENT_DEVICE_CLASSES = new Set([
  "temperature", "humidity", "illuminance", "motion", "occupancy",
]);

interface ServiceCaller {
  (domain: string, service: string, entityId: string, data?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

// ── Storage helpers ───────────────────────────────────────────────────────

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function writeSet(key: string, set: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}

function readBool(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

function writeBool(key: string, v: boolean): void {
  try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* ignore */ }
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function isExposed(e: EntityState): boolean {
  return e.exposed !== false;
}

// ── Data shaping ───────────────────────────────────────────────────────────

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

// ── Live shortcut row ─────────────────────────────────────────────────────
//
// One row per entity. Subscribes to its entity in EntityStateCache and
// patches itself on every state change. Importantly, the ROW DOM stays
// alive across state changes — only the action button is replaced. So a
// click that arrives mid-state-flip targets the still-attached row, not
// a dead branch of the tree.

interface RowHandle {
  root: HTMLElement;
  dispose: () => void;
}

function buildLiveShortcutRow(
  entityId: string,
  domain: string,
  set: ServiceCaller,
): RowHandle {
  const row = el("div", `
    display: flex; align-items: center; gap: 6px; min-height: 24px;
    padding: 2px 0; font-size: 12px; color: var(--foreground);
  `);
  const icon = el("span", "width: 16px; flex-shrink: 0;", domainIcon(domain));
  const name = el("span", "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;");
  name.style.cursor = "pointer";

  // The action button is replaced wholesale on each state change. The
  // wrapping span lets us hold a stable reference for replaceWith().
  const actionSlot = el("span", "display: contents;");

  row.append(icon, name, actionSlot);

  let lastState: EntityState | null = null;
  name.onclick = () => { if (lastState) showEntityDetail(lastState); };

  let currentAction: HTMLElement | null = null;
  const unsub = entityCache.subscribeEntity(entityId, (state) => {
    lastState = state;
    if (!state) return;
    name.textContent = entityLabel(state);
    name.title = state.entity_id;
    const newAction = buildAction(state, set);
    if (currentAction) currentAction.replaceWith(newAction);
    else actionSlot.appendChild(newAction);
    currentAction = newAction;
  });

  return { root: row, dispose: unsub };
}

function buildAction(state: EntityState, set: ServiceCaller): HTMLElement {
  // Buttons label themselves with the *current* state so the dashboard
  // reads at a glance — bright "On" pill = on, transparent "Off" = off.
  const isOn = state.state === "on" || state.state === "playing" || state.state === "open";
  const padBtn = "padding: 2px 8px; font-size: 11px; cursor: pointer; border-radius: 4px; border: 1px solid var(--border); flex-shrink: 0; line-height: 1.4;";
  const activeBg = `background: var(--primary, #58a6ff); color: var(--primary-foreground, white);`;
  const inactiveBg = `background: transparent; color: var(--foreground);`;

  switch (state.domain) {
    case "light":
    case "switch":
    case "input_boolean":
    case "fan": {
      const btn = el("button", padBtn + (isOn ? activeBg : inactiveBg), isOn ? "On" : "Off");
      btn.title = `Click to turn ${isOn ? "off" : "on"}`;
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set(state.domain, isOn ? "turn_off" : "turn_on", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "scene": {
      const btn = el("button", padBtn + inactiveBg, "Activate");
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set("scene", "turn_on", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "cover": {
      const btn = el("button", padBtn + (isOn ? activeBg : inactiveBg), isOn ? "Open" : "Closed");
      btn.title = `Click to ${isOn ? "close" : "open"}`;
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        btn.disabled = true;
        await set("cover", isOn ? "close_cover" : "open_cover", state.entity_id);
        btn.disabled = false;
      };
      return btn;
    }
    case "media_player": {
      const btn = el("button", padBtn + (isOn ? activeBg : inactiveBg), isOn ? "Playing" : "Idle");
      btn.title = `Click to ${isOn ? "pause" : "play"}`;
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
      return el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--foreground); flex-shrink: 0;",
        cur !== undefined && t !== undefined ? `${cur}°→${t}°` : state.state);
    }
  }
  return el("span", "font-family: ui-monospace, monospace; font-size: 11px; color: var(--foreground); flex-shrink: 0;", state.state);
}

// ── Live area card ────────────────────────────────────────────────────────
//
// A card whose DOM is built once, then patched in place via refresh().
// Each shortcut row owns its own subscription; the card itself only
// rebuilds the ambient row on refresh. This means a state-change burst
// replaces individual action buttons, not the whole grid.

interface AreaCardHandle {
  root: HTMLElement;
  refresh: (opts: { name: string; entities: EntityState[]; hidden: boolean }) => void;
  dispose: () => void;
}

function buildAreaCard(opts: {
  area_id: string;
  name: string;
  agent: WebSocketRemoteAgent;
  onToggleHide: (area_id: string) => void;
}): AreaCardHandle {
  const root = el("div", `
    display: flex; flex-direction: column; gap: 8px;
    padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--card, var(--background));
    transition: opacity 120ms;
    position: relative;
  `);

  // Hide button is absolutely positioned at the top-right of the
  // card so it doesn't reserve layout space when invisible — the area
  // title stays flush-left even when the button is hidden.
  const hideBtn = el("button", `
    position: absolute; top: 8px; right: 10px;
    background: var(--card, var(--background)); border: 1px solid var(--border); cursor: pointer;
    color: var(--muted-foreground); font-size: 11px; line-height: 1;
    padding: 2px 8px; border-radius: 999px; opacity: 0;
    transition: opacity 120ms; pointer-events: none;
  `);
  hideBtn.onclick = (ev) => {
    ev.stopPropagation();
    opts.onToggleHide(opts.area_id);
  };
  root.appendChild(hideBtn);

  const header = el("div", "display: flex; align-items: baseline; justify-content: space-between; gap: 8px;");
  const title = el("div", "font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;", opts.name);
  const meta = el("div", "font-size: 11px; color: var(--muted-foreground); flex-shrink: 0; padding-right: 56px;");
  header.append(title, meta);
  root.appendChild(header);

  // Hover-to-reveal hide button.
  root.addEventListener("mouseenter", () => {
    hideBtn.style.opacity = "1";
    hideBtn.style.pointerEvents = "auto";
  });
  root.addEventListener("mouseleave", () => {
    hideBtn.style.opacity = "0";
    hideBtn.style.pointerEvents = "none";
  });

  const ambientRow = el("div", "font-size: 12px; color: var(--foreground); display: flex; flex-wrap: wrap; gap: 10px;");
  ambientRow.style.display = "none"; // hidden until first refresh populates it
  root.appendChild(ambientRow);

  const list = el("div", "display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 8px;");
  list.style.display = "none";
  root.appendChild(list);

  const empty = el("div", "font-size: 12px; color: var(--muted-foreground); font-style: italic;", "No quick controls in this area.");
  empty.style.display = "none";
  root.appendChild(empty);

  const set: ServiceCaller = (domain, service, entityId, data) =>
    opts.agent.callService(domain, service, entityId, data);

  // Per-entity row map. Reconciled across refresh() calls so we only
  // tear down rows for entities that actually disappeared.
  const rowMap = new Map<string, RowHandle>();

  function refresh(input: { name: string; entities: EntityState[]; hidden: boolean }): void {
    title.textContent = input.name;
    meta.textContent = `${input.entities.length} entit${input.entities.length === 1 ? "y" : "ies"}`;
    root.style.opacity = input.hidden ? "0.5" : "1";
    hideBtn.textContent = input.hidden ? "+ unhide" : "× hide";
    hideBtn.title = input.hidden ? "Unhide this area" : "Hide this area from the dashboard";

    // Ambient values can flip frequently (motion, temperature) but the
    // *set* of ambient sensors per area is stable. Quick rebuild of
    // chips is cheaper than threading subscriptions through here.
    const ambient = pickAmbient(input.entities);
    if (ambient.length === 0) {
      ambientRow.style.display = "none";
      ambientRow.innerHTML = "";
    } else {
      ambientRow.innerHTML = "";
      for (const a of ambient) {
        const chip = el("span", "white-space: nowrap; cursor: pointer;", formatAmbient(a));
        chip.title = a.entity_id;
        chip.onclick = () => showEntityDetail(a);
        ambientRow.appendChild(chip);
      }
      ambientRow.style.display = "flex";
    }

    // Reconcile shortcut rows. Drop rows for entities that left the
    // shortcut set, keep existing ones (their per-entity subscription
    // handles their own state updates), add new ones.
    const shortcuts = pickShortcuts(input.entities);
    const wantedIds = new Set(shortcuts.map((e) => e.entity_id));
    for (const [id, row] of rowMap) {
      if (!wantedIds.has(id)) {
        row.dispose();
        row.root.remove();
        rowMap.delete(id);
      }
    }
    if (shortcuts.length === 0) {
      list.style.display = "none";
      empty.style.display = "block";
    } else {
      empty.style.display = "none";
      list.style.display = "flex";
      // Ensure rows are in the priority order. We simply re-append
      // them in order — no DOM teardown if the row is already in this
      // parent.
      for (const e of shortcuts) {
        let r = rowMap.get(e.entity_id);
        if (!r) {
          r = buildLiveShortcutRow(e.entity_id, e.domain, set);
          rowMap.set(e.entity_id, r);
        }
        list.appendChild(r.root);
      }
    }
  }

  function dispose(): void {
    for (const r of rowMap.values()) r.dispose();
    rowMap.clear();
  }

  return { root, refresh, dispose };
}

// ── Activity timeline section ─────────────────────────────────────────────
//
// Collapsible feed of recent meaningful state changes. Server filters / ring-
// buffers so the client just paints rows. Two ticks: incoming events repaint
// the visible rows; a 30s interval refreshes the relative "Xm ago" labels so
// they don't go stale while the panel sits open.

interface ActivitySectionHandle {
  root: HTMLElement;
  dispose: () => void;
}

function formatRelativeTime(ms: number): string {
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildActivitySection(): ActivitySectionHandle {
  const section = el("section", "margin-bottom: 18px;");

  const header = el("button", `
    display: flex; align-items: center; gap: 6px; width: 100%;
    background: transparent; border: none; padding: 0; margin-bottom: 8px;
    font: inherit; cursor: pointer; color: var(--muted-foreground);
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  `);
  const chevron = el("span", "display: inline-block; transition: transform 120ms; width: 10px;", "▸");
  const titleSpan = el("span", "", "Activity");
  const countBadge = el("span", `
    margin-left: auto; padding: 1px 6px; border-radius: 999px;
    background: var(--primary, #58a6ff); color: var(--primary-foreground, white);
    font-size: 10px; font-weight: 600; letter-spacing: 0;
    text-transform: none;
  `);
  countBadge.style.display = "none";
  header.append(chevron, titleSpan, countBadge);
  section.appendChild(header);

  const body = el("div", "display: flex; flex-direction: column; gap: 4px;");
  body.style.display = "none";
  const empty = el("div", "font-size: 12px; color: var(--muted-foreground); font-style: italic;", "No activity yet.");
  empty.style.display = "none";
  body.appendChild(empty);
  const list = el("div", "display: flex; flex-direction: column; gap: 2px;");
  body.appendChild(list);
  const moreBtn = el("button", `
    align-self: flex-start; margin-top: 6px;
    background: transparent; border: none; padding: 0;
    font-size: 11px; color: var(--muted-foreground); cursor: pointer;
  `);
  moreBtn.style.display = "none";
  body.appendChild(moreBtn);
  section.appendChild(body);

  // ── State ──────────────────────────────────────────────────────────────
  let collapsed = readBool(ACTIVITY_COLLAPSED_KEY);
  // Default to collapsed on first visit (no key set). readBool returns false
  // for unset, which we want, so collapsed defaults to false ⇒ EXPANDED.
  // Plan asks for collapsed by default; treat unset key as collapsed.
  if (localStorage.getItem(ACTIVITY_COLLAPSED_KEY) === null) collapsed = true;
  let expandedAll = false;
  let events: TimelineEvent[] = [];
  let unreadSinceCollapsed = 0;
  let lastSeenId: string | null = null;

  function applyCollapsedStyles(): void {
    body.style.display = collapsed ? "none" : "flex";
    chevron.style.transform = collapsed ? "rotate(0deg)" : "rotate(90deg)";
    if (collapsed) {
      countBadge.style.display = unreadSinceCollapsed > 0 ? "" : "none";
      countBadge.textContent = unreadSinceCollapsed > 0 ? `${unreadSinceCollapsed} new` : "";
    } else {
      countBadge.style.display = "none";
      unreadSinceCollapsed = 0;
      lastSeenId = events.length ? events[events.length - 1].id : null;
    }
  }

  header.onclick = () => {
    collapsed = !collapsed;
    writeBool(ACTIVITY_COLLAPSED_KEY, collapsed);
    applyCollapsedStyles();
    if (!collapsed) renderRows();
  };

  function buildRow(e: TimelineEvent): HTMLElement {
    const row = el("div", `
      display: flex; align-items: baseline; gap: 8px;
      padding: 3px 0; font-size: 12px; color: var(--foreground);
      border-bottom: 1px solid transparent;
    `);
    const time = el("span", "font-family: ui-monospace, monospace; color: var(--muted-foreground); flex-shrink: 0;", formatAbsoluteTime(e.timestamp));
    const icon = el("span", "flex-shrink: 0; width: 16px; text-align: center;", e.icon);
    const text = el("span", "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
    text.append(
      el("span", "font-weight: 500;", e.subject),
      document.createTextNode(" "),
      el("span", "color: var(--muted-foreground);", e.verb),
    );
    if (e.entity_id) {
      text.style.cursor = "pointer";
      text.title = e.entity_id;
      text.onclick = () => {
        const state = entityCache.get(e.entity_id!);
        if (state) showEntityDetail(state);
      };
    }
    const rel = el("span", "color: var(--muted-foreground); font-size: 11px; flex-shrink: 0; min-width: 60px; text-align: right;", formatRelativeTime(Date.now() - e.timestamp));
    rel.dataset.timestamp = String(e.timestamp);
    row.append(time, icon, text);
    if (e.via_agent) {
      const bot = el("span", "color: var(--muted-foreground); font-size: 11px; flex-shrink: 0;", "🤖");
      bot.title = "Action initiated by Castle agent";
      row.appendChild(bot);
    }
    row.appendChild(rel);
    return row;
  }

  function renderRows(): void {
    list.innerHTML = "";
    if (events.length === 0) {
      empty.style.display = "block";
      moreBtn.style.display = "none";
      return;
    }
    empty.style.display = "none";

    // Most-recent first.
    const ordered = [...events].reverse();
    const visible = expandedAll ? ordered : ordered.slice(0, ACTIVITY_INITIAL_VISIBLE);
    for (const e of visible) list.appendChild(buildRow(e));

    const remaining = ordered.length - visible.length;
    if (remaining > 0 && !expandedAll) {
      moreBtn.textContent = `⋯ show ${remaining} more`;
      moreBtn.style.display = "";
    } else if (expandedAll && ordered.length > ACTIVITY_INITIAL_VISIBLE) {
      moreBtn.textContent = `show fewer`;
      moreBtn.style.display = "";
    } else {
      moreBtn.style.display = "none";
    }
  }

  moreBtn.onclick = () => {
    expandedAll = !expandedAll;
    renderRows();
  };

  function refreshRelative(): void {
    if (collapsed) return;
    const now = Date.now();
    list.querySelectorAll<HTMLElement>("[data-timestamp]").forEach((el) => {
      const ts = Number(el.dataset.timestamp);
      if (Number.isFinite(ts)) el.textContent = formatRelativeTime(now - ts);
    });
  }

  const tick = setInterval(refreshRelative, 30_000);

  const unsub = entityCache.subscribeTimeline((next) => {
    if (collapsed && lastSeenId !== null) {
      // Count events strictly newer than lastSeenId.
      let unread = 0;
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].id === lastSeenId) break;
        unread++;
      }
      unreadSinceCollapsed = unread;
    } else if (collapsed) {
      // First snapshot in collapsed state: don't claim anything is "new".
      // The user can expand to see the backlog.
      unreadSinceCollapsed = 0;
      lastSeenId = next.length ? next[next.length - 1].id : null;
    } else {
      lastSeenId = next.length ? next[next.length - 1].id : null;
    }
    events = next;
    if (!collapsed) renderRows();
    applyCollapsedStyles();
  });

  applyCollapsedStyles();

  return {
    root: section,
    dispose: () => {
      clearInterval(tick);
      unsub();
    },
  };
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
  if (readBool(COLLAPSED_KEY)) {
    root.style.display = "none";
  }

  const heading = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 10px;", "Dashboard");
  root.appendChild(heading);

  const activity = buildActivitySection();
  root.appendChild(activity.root);

  // Favourites: full domain-tailored cards.
  const favSection = el("section", "margin-bottom: 18px;");
  const favHeader = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 8px;", "★ Favourites");
  const favGrid = el("div", `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 360px));
    gap: 12px;
    align-content: start;
  `);
  favSection.append(favHeader, favGrid);
  favSection.style.display = "none";

  // Areas section: header row + grid.
  const areaSection = el("section");
  const areaHeaderRow = el("div", "display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 12px;");
  const areaHeader = el("div", "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground);", "Areas");
  const showHiddenLabel = el("label", "display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted-foreground); cursor: pointer; user-select: none;");
  const showHiddenCb = document.createElement("input");
  showHiddenCb.type = "checkbox";
  showHiddenCb.checked = readBool(SHOW_HIDDEN_KEY);
  showHiddenLabel.append(showHiddenCb, document.createTextNode("Show hidden areas"));
  areaHeaderRow.append(areaHeader, showHiddenLabel);
  const areaGrid = el("div", `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    align-content: start;
  `);
  areaSection.append(areaHeaderRow, areaGrid);

  root.append(favSection, areaSection);

  // ── State ─────────────────────────────────────────────────────────────
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
  const hiddenAreas = readSet(HIDDEN_AREAS_KEY);

  // Persistent area-card handles. Re-created only when an area
  // appears or disappears from the registry — never on a state-change
  // burst — which is what fixes the click responsiveness.
  const areaCards = new Map<string, AreaCardHandle>();

  // Favourite cards.
  const favCards = new Map<string, { handle: { dispose: () => void }; slot: HTMLElement }>();

  function toggleHideArea(area_id: string): void {
    if (hiddenAreas.has(area_id)) hiddenAreas.delete(area_id);
    else hiddenAreas.add(area_id);
    writeSet(HIDDEN_AREAS_KEY, hiddenAreas);
    requestRender();
  }

  showHiddenCb.onchange = () => {
    writeBool(SHOW_HIDDEN_KEY, showHiddenCb.checked);
    requestRender();
  };

  function reconcileFavourites(): void {
    const wantedIds = new Set<string>();
    for (const id of readSet(FAV_KEY)) {
      const e = states.get(id);
      if (!e || !isExposed(e)) continue;
      wantedIds.add(id);
    }
    for (const [id, { handle, slot }] of favCards) {
      if (!wantedIds.has(id)) {
        handle.dispose();
        slot.remove();
        favCards.delete(id);
      }
    }
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

    // Bucket exposed entities by area.
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

    const showHidden = showHiddenCb.checked;
    const visibleAreas = [...areas]
      .filter((a) => showHidden || !hiddenAreas.has(a.area_id))
      .sort((x, y) => x.name.localeCompare(y.name));
    const seenIds = new Set<string>();

    // Reconcile cards: keep existing ones, add new ones, remove gone ones.
    for (const [id, card] of areaCards) {
      // We'll re-append them in order below; for now, just detach.
      card.root.remove();
    }
    for (const a of visibleAreas) {
      seenIds.add(a.area_id);
      let card = areaCards.get(a.area_id);
      if (!card) {
        card = buildAreaCard({
          area_id: a.area_id,
          name: a.name,
          agent,
          onToggleHide: toggleHideArea,
        });
        areaCards.set(a.area_id, card);
      }
      card.refresh({
        name: a.name,
        entities: buckets.get(a.area_id) ?? [],
        hidden: hiddenAreas.has(a.area_id),
      });
      areaGrid.appendChild(card.root);
    }
    // Dispose cards for areas that no longer exist or are now hidden
    // and not being shown. Their click handlers and subscriptions go
    // with them.
    for (const [id, card] of areaCards) {
      if (!seenIds.has(id)) {
        card.dispose();
        areaCards.delete(id);
      }
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
      writeBool(COLLAPSED_KEY, !collapsed);
    },
  };
}
