import { showEntityDetail } from "./EntityDetail";
import type { AreaInfo, EntityState, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { entityCache } from "./EntityStateCache";
import { openSettingsDialog } from "./SettingsDialog";
import { openSessionBrowser } from "./SessionBrowser";

/**
 * Tree-style left sidebar.
 *
 *   [search box]
 *   [ ] hide non-exposed
 *   ▾ Favourites          (n)
 *   ▾ Areas
 *     ▾ Living Room       (n)
 *       <entity rows…>
 *     ▸ Kitchen           (n)
 *     …
 *     ▸ (no area)         (n)
 *   ▾ Automations         (n)
 *   ▸ Events              (n)
 *   ───────────────────────────
 *   ⚙ Settings
 *   🕑 History
 *   📄 Prompt              ↗
 *
 * Sources:
 *   - entity state + areas come from EntityStateCache (WS push).
 *   - Favourites are persisted in localStorage, per-entity-id list.
 *   - Settings / History are commands that mirror what the topbar used to do.
 *
 * Search filters every section in parallel. Matching nodes auto-expand;
 * collapse state is restored from localStorage when the search clears.
 */

const SKIP_DOMAINS = new Set([
  "update", "device_tracker", "persistent_notification",
  "conversation", "tts", "stt", "wake_word", "zone",
]);

const OPEN_KEY = "castle-sidebar-open-nodes";
const HIDE_UNEXPOSED_KEY = "castle-sidebar-hide-unexposed";
const FAV_KEY = "castle-sidebar-favourites";

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

function stateClass(s: string): "on" | "off" | "" {
  const v = s.toLowerCase();
  if (v === "on" || v === "open" || v === "home" || v === "playing") return "on";
  if (v === "off" || v === "closed" || v === "not_home" || v === "idle" || v === "unavailable") return "off";
  return "";
}

function eyeIcon(exposed: boolean): string {
  return exposed
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.46 18.46 0 0 1 4.06-5.06"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a18.4 18.4 0 0 1-2.16 3.19"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
}

function starIcon(filled: boolean): string {
  return filled
    ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
    : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
}

const NO_AREA = "__no_area__";

export interface SidebarHandle {
  root: HTMLElement;
  toggle: () => void;
}

export function buildSidebar(agent: WebSocketRemoteAgent): SidebarHandle {
  const root = document.createElement("aside");
  root.style.cssText = `
    width: 320px; flex-shrink: 0;
    background: var(--card, #f7f8fa);
    border-right: 1px solid var(--border, #e5e7eb);
    display: flex; flex-direction: column;
    transition: margin-left 200ms ease;
    font-size: 13px; color: var(--foreground);
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  root.dataset.collapsed = "0";

  // ── Header (search + filter toggle) ─────────────────────────────────────
  const header = document.createElement("div");
  header.style.cssText = "padding: 8px; border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search entities…";
  search.style.cssText = `
    width: 100%; padding: 6px 10px;
    background: var(--background); color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
    font-size: 13px; outline: none;
  `;
  const filterRow = document.createElement("label");
  filterRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground); cursor: pointer; padding: 0 2px;";
  const hideUnexposedCb = document.createElement("input");
  hideUnexposedCb.type = "checkbox";
  hideUnexposedCb.checked = readBool(HIDE_UNEXPOSED_KEY);
  filterRow.append(hideUnexposedCb, document.createTextNode("Hide non-exposed"));
  header.append(search, filterRow);

  // ── Tree container ──────────────────────────────────────────────────────
  const tree = document.createElement("div");
  tree.style.cssText = "flex: 1; overflow-y: auto; padding: 4px 0;";

  // ── Footer (action items) ───────────────────────────────────────────────
  const footer = document.createElement("div");
  footer.style.cssText = "border-top: 1px solid var(--border); flex-shrink: 0; padding: 4px 0;";

  function actionRow(icon: string, label: string, onClick: () => void, opts?: { extra?: HTMLElement }): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.style.cssText = `
      width: 100%; text-align: left; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; font-size: 13px;
      background: transparent; border: none; color: var(--foreground);
      font-family: inherit;
    `;
    row.onmouseenter = () => { row.style.background = "var(--muted)"; };
    row.onmouseleave = () => { row.style.background = ""; };
    row.onclick = onClick;
    const iconEl = document.createElement("span");
    iconEl.textContent = icon;
    iconEl.style.cssText = "width: 18px; flex-shrink: 0; text-align: center;";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.flex = "1";
    row.append(iconEl, labelEl);
    if (opts?.extra) row.append(opts.extra);
    return row;
  }

  footer.append(
    actionRow("⚙", "Settings", () => openSettingsDialog(agent)),
    actionRow("🕑", "History", () => openSessionBrowser(agent)),
    actionRow("📄", "Prompt", () => window.open("/agents.md", "_blank", "noopener")),
  );

  root.append(header, tree, footer);

  // ── State ───────────────────────────────────────────────────────────────
  const states = new Map<string, EntityState>();
  let areas: AreaInfo[] = [];
  const openNodes = readSet(OPEN_KEY);
  const favourites = readSet(FAV_KEY);
  let hideUnexposed = readBool(HIDE_UNEXPOSED_KEY);

  // RAF-coalesce so a burst of state_change frames (motion sensors, etc.)
  // collapses to one repaint per frame.
  let renderQueued = false;
  function requestRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function isOpen(nodeId: string, defaultOpen = false): boolean {
    if (defaultOpen) return !openNodes.has(`!${nodeId}`); // explicit close prefix
    return openNodes.has(nodeId);
  }
  function setOpen(nodeId: string, open: boolean, defaultOpen = false): void {
    if (defaultOpen) {
      if (open) openNodes.delete(`!${nodeId}`);
      else openNodes.add(`!${nodeId}`);
    } else {
      if (open) openNodes.add(nodeId);
      else openNodes.delete(nodeId);
    }
    writeSet(OPEN_KEY, openNodes);
  }

  function entitiesMatchingQuery(q: string): (e: EntityState) => boolean {
    if (!q) return () => true;
    return (e) => {
      const friendly = (e.attributes?.friendly_name as string ?? "").toLowerCase();
      return e.entity_id.toLowerCase().includes(q) || friendly.includes(q);
    };
  }

  // Build an entity list-item, used by every leaf of the tree.
  function renderEntityRow(e: EntityState): HTMLElement {
    const friendly = (e.attributes?.friendly_name as string) ?? e.entity_id.split(".").pop() ?? e.entity_id;
    const exposed = e.exposed !== false;

    const item = document.createElement("div");
    item.style.cssText = `
      padding: 4px 8px 4px 22px; font-size: 13px;
      display: flex; align-items: center; gap: 6px;
      color: var(--foreground); cursor: pointer;
      ${exposed ? "" : "opacity: 0.55;"}
    `;
    item.onmouseenter = () => { item.style.background = "var(--muted)"; };
    item.onmouseleave = () => { item.style.background = ""; };
    item.onclick = () => showEntityDetail(e);

    // Exposure eye toggle.
    const eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.title = exposed ? "Exposed to the agent — click to hide" : "Not exposed — click to expose";
    eyeBtn.style.cssText = `
      flex-shrink: 0; width: 22px; height: 22px; padding: 0;
      background: transparent; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      color: ${exposed ? "rgb(63 185 80)" : "var(--muted-foreground)"};
      line-height: 1;
    `;
    eyeBtn.innerHTML = eyeIcon(exposed);
    eyeBtn.onclick = (ev) => {
      ev.stopPropagation();
      const next = !exposed;
      e.exposed = next;
      requestRender();
      agent.sendRaw({ type: "set_exposure", entity_ids: [e.entity_id], expose: next });
    };

    // Favourite star.
    const isFav = favourites.has(e.entity_id);
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.title = isFav ? "Remove from Favourites" : "Add to Favourites";
    favBtn.style.cssText = `
      flex-shrink: 0; width: 20px; height: 20px; padding: 0;
      background: transparent; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      color: ${isFav ? "rgb(234 179 8)" : "var(--muted-foreground)"};
      opacity: ${isFav ? "1" : "0.45"};
      line-height: 1;
    `;
    favBtn.innerHTML = starIcon(isFav);
    favBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (favourites.has(e.entity_id)) favourites.delete(e.entity_id);
      else favourites.add(e.entity_id);
      writeSet(FAV_KEY, favourites);
      // Same-tab signal for any other component watching favourites
      // (the dashboard's "★ Favourites" card). The native `storage`
      // event only fires for cross-tab writes, so we need our own.
      globalThis.dispatchEvent(new CustomEvent("castle-favourites-changed"));
      requestRender();
    };

    const nameEl = document.createElement("span");
    nameEl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;";
    nameEl.textContent = friendly;

    const cls = stateClass(e.state);
    const stateColor = cls === "on" ? "rgb(63 185 80)" : "var(--muted-foreground)";
    const stateEl = document.createElement("span");
    stateEl.style.cssText = `font-size:11px;padding:1px 6px;border-radius:4px;background:var(--background);color:${stateColor};font-family:ui-monospace,monospace;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    stateEl.textContent = String(e.state);

    item.append(eyeBtn, favBtn, nameEl, stateEl);
    return item;
  }

  // Generic collapsible group node. `level` controls indentation.
  function renderGroup(opts: {
    nodeId: string;
    label: string;
    count?: number;
    level: number;
    defaultOpen?: boolean;
    forceOpen?: boolean;
    children: () => HTMLElement[];
  }): HTMLElement {
    const wrap = document.createElement("div");
    const header = document.createElement("div");
    const padLeft = 10 + opts.level * 14;
    header.style.cssText = `
      padding: 5px ${10}px 5px ${padLeft}px;
      cursor: pointer; user-select: none;
      display: flex; align-items: center; gap: 6px;
      ${opts.level === 0 ? "font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground);" : "font-size: 13px; color: var(--foreground);"}
    `;
    const open = opts.forceOpen ?? isOpen(opts.nodeId, opts.defaultOpen ?? (opts.level === 0));
    const chevron = document.createElement("span");
    chevron.textContent = open ? "▾" : "▸";
    chevron.style.cssText = "width: 12px; flex-shrink: 0; font-size: 10px; opacity: 0.7;";
    const labelEl = document.createElement("span");
    labelEl.textContent = opts.label;
    labelEl.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const countEl = document.createElement("span");
    if (opts.count !== undefined) {
      countEl.textContent = String(opts.count);
      countEl.style.cssText = "font-size: 11px; opacity: 0.6; flex-shrink: 0;";
    }
    header.append(chevron, labelEl, countEl);
    const body = document.createElement("div");
    body.style.display = open ? "block" : "none";
    if (open) for (const c of opts.children()) body.appendChild(c);
    header.onclick = () => {
      const willOpen = body.style.display === "none";
      body.style.display = willOpen ? "block" : "none";
      chevron.textContent = willOpen ? "▾" : "▸";
      if (opts.forceOpen === undefined) {
        setOpen(opts.nodeId, willOpen, opts.defaultOpen ?? (opts.level === 0));
      }
      // Lazy-build children only the first time we open.
      if (willOpen && body.childElementCount === 0) {
        for (const c of opts.children()) body.appendChild(c);
      }
    };
    wrap.append(header, body);
    return wrap;
  }

  // ── Main render ─────────────────────────────────────────────────────────
  function render(): void {
    const q = search.value.toLowerCase().trim();
    const matches = entitiesMatchingQuery(q);
    const visible = (e: EntityState) =>
      !SKIP_DOMAINS.has(e.domain) &&
      (!hideUnexposed || e.exposed !== false) &&
      matches(e);

    tree.innerHTML = "";

    // ── Favourites ────────────────────────────────────────────────────
    const favEntities = [...favourites]
      .map((id) => states.get(id))
      .filter((e): e is EntityState => !!e && visible(e))
      .sort((a, b) =>
        ((a.attributes?.friendly_name as string) ?? a.entity_id).localeCompare(
          (b.attributes?.friendly_name as string) ?? b.entity_id,
        ),
      );
    if (favourites.size > 0 || q === "") {
      tree.appendChild(renderGroup({
        nodeId: "favourites",
        label: "Favourites",
        count: favEntities.length,
        level: 0,
        defaultOpen: true,
        forceOpen: q ? favEntities.length > 0 : undefined,
        children: () => favEntities.map(renderEntityRow),
      }));
    }

    // ── Areas ─────────────────────────────────────────────────────────
    // Build per-area entity buckets. Anything not in an area falls into
    // the "(no area)" bucket so users can find it. SKIP_DOMAINS still apply.
    const entityArea = entityCache.getEntityAreaMap();
    const buckets = new Map<string, EntityState[]>();
    for (const a of areas) buckets.set(a.area_id, []);
    buckets.set(NO_AREA, []);
    for (const e of states.values()) {
      if (!visible(e)) continue;
      const aid = entityArea.get(e.entity_id) ?? NO_AREA;
      const bucket = buckets.get(aid) ?? buckets.get(NO_AREA)!;
      bucket.push(e);
    }
    for (const arr of buckets.values()) {
      arr.sort((a, b) =>
        ((a.attributes?.friendly_name as string) ?? a.entity_id).localeCompare(
          (b.attributes?.friendly_name as string) ?? b.entity_id,
        ),
      );
    }
    const areaTotal = [...buckets.values()].reduce((s, arr) => s + arr.length, 0);

    const orderedAreas: Array<{ id: string; name: string; entities: EntityState[] }> = [
      ...areas.map((a) => ({ id: a.area_id, name: a.name, entities: buckets.get(a.area_id) ?? [] })),
      { id: NO_AREA, name: "(no area)", entities: buckets.get(NO_AREA) ?? [] },
    ].sort((a, b) => {
      if (a.id === NO_AREA) return 1;
      if (b.id === NO_AREA) return -1;
      return a.name.localeCompare(b.name);
    });

    tree.appendChild(renderGroup({
      nodeId: "areas",
      label: "Areas",
      count: areaTotal,
      level: 0,
      defaultOpen: true,
      forceOpen: q ? areaTotal > 0 : undefined,
      children: () => orderedAreas
        .filter((a) => a.entities.length > 0 || (q === "" && a.id !== NO_AREA))
        .map((a) => renderGroup({
          nodeId: `area:${a.id}`,
          label: a.name,
          count: a.entities.length,
          level: 1,
          defaultOpen: false,
          forceOpen: q ? a.entities.length > 0 : undefined,
          children: () => a.entities.map(renderEntityRow),
        })),
    }));

    // ── Automations ───────────────────────────────────────────────────
    const automations = [...states.values()].filter((e) => e.domain === "automation" && visible(e))
      .sort((a, b) => ((a.attributes?.friendly_name as string) ?? a.entity_id).localeCompare(
        (b.attributes?.friendly_name as string) ?? b.entity_id,
      ));
    if (automations.length > 0 || q === "") {
      tree.appendChild(renderGroup({
        nodeId: "automations",
        label: "Automations",
        count: automations.length,
        level: 0,
        defaultOpen: false,
        forceOpen: q ? automations.length > 0 : undefined,
        children: () => automations.map(renderEntityRow),
      }));
    }

    // ── Events ────────────────────────────────────────────────────────
    const events = [...states.values()].filter((e) => e.domain === "event" && visible(e))
      .sort((a, b) => ((a.attributes?.friendly_name as string) ?? a.entity_id).localeCompare(
        (b.attributes?.friendly_name as string) ?? b.entity_id,
      ));
    if (events.length > 0 || q === "") {
      tree.appendChild(renderGroup({
        nodeId: "events",
        label: "Events",
        count: events.length,
        level: 0,
        defaultOpen: false,
        forceOpen: q ? events.length > 0 : undefined,
        children: () => events.map(renderEntityRow),
      }));
    }

    if (tree.children.length === 0) {
      tree.innerHTML = `<div style="padding: 16px; color: var(--muted-foreground); font-size: 13px;">No matching entities.</div>`;
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  search.oninput = render;
  hideUnexposedCb.onchange = () => {
    hideUnexposed = hideUnexposedCb.checked;
    writeBool(HIDE_UNEXPOSED_KEY, hideUnexposed);
    render();
  };

  entityCache.subscribeAll((all) => {
    states.clear();
    for (const s of all) states.set(s.entity_id, s);
    requestRender();
  });
  entityCache.subscribeAreas((next) => {
    areas = next;
    requestRender();
  });

  return {
    root,
    toggle: () => {
      const collapsed = root.dataset.collapsed === "1";
      root.dataset.collapsed = collapsed ? "0" : "1";
      root.style.marginLeft = collapsed ? "0" : "-320px";
    },
  };
}
