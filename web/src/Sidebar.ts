import { showEntityDetail } from "./EntityDetail";

interface State {
  entity_id: string;
  state: string;
  // deno-lint-ignore no-explicit-any
  attributes: Record<string, any>;
  domain: string;
}

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

const OPEN_DOMAINS_KEY = "hai-sidebar-open-domains";

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

/**
 * Collapsible left sidebar listing entities grouped by domain.
 * Polls /states every 10s without losing search input or domain expansion state.
 * Click an entity to open a rich detail view.
 */
export function buildSidebar(): { root: HTMLElement; toggle: () => void } {
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

  // Search box
  const searchWrap = document.createElement("div");
  searchWrap.style.cssText = "padding: 8px; border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0;";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search entities…";
  search.style.cssText = `
    width: 100%; padding: 6px 10px;
    background: var(--background); color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
    font-size: 13px; outline: none;
  `;
  searchWrap.appendChild(search);

  // List
  const list = document.createElement("div");
  list.style.cssText = "flex: 1; overflow-y: auto; padding: 4px 0;";

  root.append(searchWrap, list);

  let allStates: State[] = [];
  const openDomains = loadOpenDomains();

  const render = () => {
    const q = search.value.toLowerCase().trim();

    // Group by domain
    const grouped = new Map<string, State[]>();
    for (const s of allStates) {
      if (SKIP_DOMAINS.has(s.domain)) continue;
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
        const item = document.createElement("div");
        item.style.cssText = `
          padding: 5px 12px 5px 20px; font-size: 13px; cursor: pointer;
          display: flex; justify-content: space-between; align-items: center;
          color: var(--foreground);
        `;
        const cls = stateClass(e.state);
        const stateColor = cls === "on" ? "rgb(63 185 80)" : cls === "off" ? "var(--muted-foreground)" : "var(--muted-foreground)";
        item.innerHTML = `
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">${escapeHtml(friendly)}</span>
          <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:var(--background);color:${stateColor};font-family:ui-monospace,monospace;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(e.state))}</span>
        `;
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

  const poll = async () => {
    try {
      const res = await fetch("/states");
      if (res.ok) {
        allStates = await res.json();
        render();
      }
    } catch { /* ignore */ }
  };
  poll();
  setInterval(poll, 10000);

  return {
    root,
    toggle: () => {
      const collapsed = root.dataset.collapsed === "1";
      root.dataset.collapsed = collapsed ? "0" : "1";
      root.style.marginLeft = collapsed ? "0" : "-320px";
    },
  };
}
