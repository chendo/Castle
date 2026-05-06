import { showEntityDetail } from "./EntityDetail";
import type { EntityState, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { entityCache } from "./EntityStateCache";

type State = EntityState;

const SKIP_DOMAINS = new Set([
  "update", "device_tracker", "persistent_notification",
  "conversation", "tts", "stt", "wake_word", "zone",
]);

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function stateClass(s: string): string {
  const v = s.toLowerCase();
  if (v === "on" || v === "open" || v === "home" || v === "playing") return "on";
  if (v === "off" || v === "closed" || v === "not_home" || v === "idle" || v === "unavailable") return "off";
  return "";
}

const OPEN_DOMAINS_KEY = "castle-sidebar-open-domains";
const HIDE_UNEXPOSED_KEY = "castle-sidebar-hide-unexposed";

function loadOpenDomains(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_DOMAINS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveOpenDomains(open: Set<string>): void {
  try { localStorage.setItem(OPEN_DOMAINS_KEY, JSON.stringify([...open])); } catch { /* ignore */ }
}

function loadHideUnexposed(): boolean {
  try { return localStorage.getItem(HIDE_UNEXPOSED_KEY) === "1"; } catch { return false; }
}

function saveHideUnexposed(v: boolean): void {
  try { localStorage.setItem(HIDE_UNEXPOSED_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}

/**
 * Collapsible left sidebar listing entities grouped by domain.
 *
 * Bootstraps from the WebSocket `states_snapshot` frame the server sends
 * after `hello`, then applies incremental `state_change` frames as HA emits
 * `state_changed` events. No polling — re-renders are throttled via a single
 * RAF coalesce so a burst of 50 motion-sensor changes doesn't repaint the
 * sidebar 50 times.
 */
export function buildSidebar(agent: WebSocketRemoteAgent): { root: HTMLElement; toggle: () => void } {
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

  // Search box + hide-unexposed toggle
  const searchWrap = document.createElement("div");
  searchWrap.style.cssText = "padding: 8px; border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;";
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
  hideUnexposedCb.checked = loadHideUnexposed();
  filterRow.append(hideUnexposedCb, document.createTextNode("Hide non-exposed"));
  searchWrap.append(search, filterRow);

  // List
  const list = document.createElement("div");
  list.style.cssText = "flex: 1; overflow-y: auto; padding: 4px 0;";

  root.append(searchWrap, list);

  // Keep entities by id for O(1) updates from state_change frames.
  const entities = new Map<string, State>();
  const openDomains = loadOpenDomains();
  let hideUnexposed = loadHideUnexposed();

  // Coalesce a burst of state changes into one repaint per animation frame.
  let renderQueued = false;
  const requestRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  };

  const render = () => {
    const q = search.value.toLowerCase().trim();

    // Group by domain
    const grouped = new Map<string, State[]>();
    for (const s of entities.values()) {
      if (SKIP_DOMAINS.has(s.domain)) continue;
      if (hideUnexposed && s.exposed === false) continue;
      const name = (s.attributes?.friendly_name as string ?? s.entity_id.split(".").pop() ?? "").toLowerCase();
      if (q && !s.entity_id.toLowerCase().includes(q) && !name.includes(q)) continue;
      if (!grouped.has(s.domain)) grouped.set(s.domain, []);
      grouped.get(s.domain)!.push(s);
    }

    list.innerHTML = "";
    if (grouped.size === 0) {
      list.innerHTML = `<div style="padding: 16px; color: var(--muted-foreground); font-size: 13px;">No matching entities.</div>`;
      return;
    }

    for (const domain of [...grouped.keys()].sort()) {
      const entities = grouped.get(domain)!.sort((a, b) =>
        (a.attributes?.friendly_name as string ?? a.entity_id).localeCompare(
          b.attributes?.friendly_name as string ?? b.entity_id,
        ),
      );

      // While searching, all matching domains expand. Otherwise honor user state.
      const isOpen = q ? true : openDomains.has(domain);

      const group = document.createElement("div");
      group.style.cssText = "margin-bottom: 2px;";

      const header = document.createElement("div");
      header.style.cssText = `
        padding: 6px 12px; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--muted-foreground);
        background: var(--muted, transparent);
        cursor: pointer; display: flex; justify-content: space-between;
        user-select: none;
      `;
      header.innerHTML = `<span>${escapeHtml(domain)}</span><span style="opacity:0.6;font-weight:400">${entities.length}</span>`;

      const items = document.createElement("div");
      items.style.display = isOpen ? "block" : "none";

      header.onclick = () => {
        const willOpen = items.style.display === "none";
        items.style.display = willOpen ? "block" : "none";
        if (q) return; // don't persist while searching
        if (willOpen) openDomains.add(domain); else openDomains.delete(domain);
        saveOpenDomains(openDomains);
      };

      for (const e of entities) {
        const friendly = (e.attributes?.friendly_name as string) ?? e.entity_id.split(".").pop() ?? e.entity_id;
        const exposed = e.exposed !== false; // treat undefined as exposed (legacy server)
        const item = document.createElement("div");
        item.style.cssText = `
          padding: 5px 12px 5px 12px; font-size: 13px;
          display: flex; justify-content: space-between; align-items: center;
          color: var(--foreground);
          ${exposed ? "" : "opacity: 0.55;"}
        `;

        const eyeBtn = document.createElement("button");
        eyeBtn.type = "button";
        eyeBtn.title = exposed
          ? "Exposed to the agent — click to hide"
          : "Not exposed — click to expose to the agent";
        eyeBtn.style.cssText = `
          flex-shrink: 0; width: 22px; height: 22px; padding: 0; margin-right: 6px;
          background: transparent; border: none; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          color: ${exposed ? "rgb(63 185 80)" : "var(--muted-foreground)"};
          line-height: 1;
        `;
        // Open eye when exposed, closed eye when not. Inline SVG so no extra dep.
        eyeBtn.innerHTML = exposed
          ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`
          : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a18.46 18.46 0 0 1 4.06-5.06"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a18.4 18.4 0 0 1-2.16 3.19"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
        eyeBtn.onclick = (ev) => {
          ev.stopPropagation();
          const next = !exposed;
          // Optimistic update — flip locally so the UI is responsive. The
          // server doesn't push exposure changes back through state_change
          // (HA's state_changed event doesn't fire for the conversation-
          // expose flag), so the local flip is the source of truth until
          // the next reconnect / hello bootstrap.
          e.exposed = next;
          requestRender();
          agent.sendRaw({ type: "set_exposure", entity_ids: [e.entity_id], expose: next });
        };

        const nameEl = document.createElement("span");
        nameEl.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;";
        nameEl.textContent = friendly;

        const cls = stateClass(e.state);
        const stateColor = cls === "on" ? "rgb(63 185 80)" : cls === "off" ? "var(--muted-foreground)" : "var(--muted-foreground)";
        const stateEl = document.createElement("span");
        stateEl.style.cssText = `font-size:11px;padding:1px 6px;border-radius:4px;background:var(--background);color:${stateColor};font-family:ui-monospace,monospace;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
        stateEl.textContent = String(e.state);

        item.append(eyeBtn, nameEl, stateEl);
        item.style.cursor = "pointer";
        item.onmouseenter = () => { item.style.background = "var(--muted)"; };
        item.onmouseleave = () => { item.style.background = ""; };
        item.onclick = () => showEntityDetail(e);
        items.appendChild(item);
      }

      group.append(header, items);
      list.appendChild(group);
    }
  };

  search.oninput = render;
  hideUnexposedCb.onchange = () => {
    hideUnexposed = hideUnexposedCb.checked;
    saveHideUnexposed(hideUnexposed);
    render();
  };

  // Bootstrap + live updates routed through the shared EntityStateCache so
  // sidebar and entity-cards (and any future widget) all observe the same
  // state stream without clobbering one another's handler.
  entityCache.subscribeAll((states) => {
    entities.clear();
    for (const s of states) entities.set(s.entity_id, s);
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
