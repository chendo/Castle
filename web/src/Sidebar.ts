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

/**
 * Collapsible left sidebar listing entities grouped by domain.
 * Polls /states every 10s. Click an entity to open a modal with its full attributes.
 */
export function buildSidebar(): { root: HTMLElement; toggle: () => void } {
  const root = document.createElement("aside");
  root.style.cssText = `
    width: 320px; flex-shrink: 0; background: rgb(22 27 34);
    border-right: 1px solid rgb(48 54 61); display: flex; flex-direction: column;
    transition: margin-left 200ms ease;
    font-size: 13px; color: rgb(230 237 243);
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  root.dataset.collapsed = "0";

  // Search box
  const searchWrap = document.createElement("div");
  searchWrap.style.cssText = "padding: 8px; border-bottom: 1px solid rgb(48 54 61); flex-shrink: 0;";
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search entities…";
  search.style.cssText = `
    width: 100%; padding: 6px 10px; background: rgb(13 17 23);
    border: 1px solid rgb(48 54 61); border-radius: 6px;
    color: inherit; font-size: 13px; outline: none;
  `;
  searchWrap.appendChild(search);

  // List
  const list = document.createElement("div");
  list.style.cssText = "flex: 1; overflow-y: auto; padding: 4px 0;";

  root.append(searchWrap, list);

  let allStates: State[] = [];

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
      list.innerHTML = `<div style="padding: 16px; color: rgb(139 148 158); font-size: 13px;">No matching entities.</div>`;
      return;
    }

    for (const domain of [...grouped.keys()].sort()) {
      const entities = grouped.get(domain)!.sort((a, b) =>
        (a.attributes?.friendly_name as string ?? a.entity_id).localeCompare(
          b.attributes?.friendly_name as string ?? b.entity_id,
        ),
      );

      const group = document.createElement("div");
      group.dataset.open = q ? "1" : "0";
      group.style.cssText = "margin-bottom: 2px;";

      const header = document.createElement("div");
      header.style.cssText = `
        padding: 6px 12px; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
        color: rgb(139 148 158); background: rgb(33 38 45);
        cursor: pointer; display: flex; justify-content: space-between;
        user-select: none;
      `;
      header.innerHTML = `<span>${domain}</span><span style="opacity:0.6;font-weight:400">${entities.length}</span>`;
      header.onclick = () => {
        group.dataset.open = group.dataset.open === "1" ? "0" : "1";
        items.style.display = group.dataset.open === "1" ? "block" : "none";
      };

      const items = document.createElement("div");
      items.style.display = q ? "block" : "none";

      for (const e of entities) {
        const friendly = (e.attributes?.friendly_name as string) ?? e.entity_id.split(".").pop() ?? e.entity_id;
        const item = document.createElement("div");
        item.style.cssText = `
          padding: 5px 12px 5px 20px; font-size: 13px; cursor: pointer;
          display: flex; justify-content: space-between; align-items: center;
        `;
        const cls = stateClass(e.state);
        const stateColor = cls === "on" ? "rgb(63 185 80)" : cls === "off" ? "rgba(139 148 158 / 0.6)" : "rgb(139 148 158)";
        item.innerHTML = `
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;margin-right:8px;">${escapeHtml(friendly)}</span>
          <span style="font-size:11px;padding:1px 6px;border-radius:4px;background:rgb(13 17 23);color:${stateColor};font-family:ui-monospace,monospace;flex-shrink:0;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(String(e.state))}</span>
        `;
        item.onmouseenter = () => { item.style.background = "rgb(33 38 45)"; };
        item.onmouseleave = () => { item.style.background = ""; };
        item.onclick = () => showDetail(e);
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

function showDetail(entity: State): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200;
    display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: rgb(22 27 34); border: 1px solid rgb(48 54 61);
    border-radius: 12px; padding: 20px; max-width: 520px; width: 90%;
    max-height: 80vh; overflow-y: auto; color: rgb(230 237 243);
  `;

  const friendly = (entity.attributes?.friendly_name as string) ?? entity.entity_id;
  const closeBtn = `<button style="float:right;background:none;border:none;color:rgb(139 148 158);font-size:18px;cursor:pointer;padding:4px;" onclick="this.closest('[data-overlay]').remove()">×</button>`;
  let html = `
    <div data-overlay style="display:contents;"></div>
    ${closeBtn}
    <div style="font-size:13px;color:rgb(139 148 158);">${escapeHtml(entity.entity_id)}</div>
    <div style="font-size:18px;font-weight:600;margin-top:2px;word-break:break-word;">${escapeHtml(friendly)}</div>
    <div style="font-size:24px;color:#58a6ff;margin:10px 0;font-family:ui-monospace,monospace;">${escapeHtml(String(entity.state))}</div>
  `;

  const attrs = Object.entries(entity.attributes ?? {}).filter(([k]) => k !== "friendly_name");
  if (attrs.length > 0) {
    html += `<div style="margin-top:14px;border-top:1px solid rgb(48 54 61);padding-top:10px;">`;
    for (const [k, v] of attrs) {
      const valStr = typeof v === "string" ? v : JSON.stringify(v);
      html += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgb(48 54 61);font-size:12px;gap:12px;">
        <span style="color:rgb(139 148 158);font-family:ui-monospace,monospace;">${escapeHtml(k)}</span>
        <span style="text-align:right;word-break:break-all;max-width:60%;">${escapeHtml(valStr.slice(0, 200))}</span>
      </div>`;
    }
    html += `</div>`;
  }

  panel.innerHTML = html;
  panel.querySelector("button")!.onclick = () => overlay.remove();
  overlay.appendChild(panel);
  overlay.dataset.overlay = "1";
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);
}
