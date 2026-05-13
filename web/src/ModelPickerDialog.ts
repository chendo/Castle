import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { withBase } from "./base";

interface ModelsResponse {
  active: string;
  models: Array<{ id: string }>;
}

/**
 * Custom model picker — replaces pi-web-ui's built-in cloud picker.
 *
 * Fetches /models (proxied through the Castle server, which calls /v1/models on
 * the configured LLM_URL with the bearer token never seen by the browser),
 * shows a searchable list, and on selection fires set_model over the WS. The
 * server resets the agent session and broadcasts a fresh snapshot, which is
 * what flips agent.state.model in every connected tab.
 */
export function openModelPickerDialog(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("castle-model-picker-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "castle-model-picker-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200;
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 80px; font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: var(--card); color: var(--foreground);
    border: 1px solid var(--border); border-radius: 14px;
    width: 100%; max-width: 540px; max-height: 70vh;
    display: flex; flex-direction: column; overflow: hidden;
  `;

  panel.innerHTML = `
    <div style="padding: 14px 18px 10px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center;">
      <div style="font-size: 14px; font-weight: 600;">Pick model</div>
      <input id="castle-model-search" type="text" placeholder="Filter…" style="flex:1;padding:6px 10px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;" />
      <button id="castle-model-close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:20px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    </div>
    <div id="castle-model-status" style="padding: 16px 18px; font-size: 13px; color: var(--muted-foreground);">Loading…</div>
    <div id="castle-model-list" style="flex:1;overflow-y:auto;display:none;"></div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const search = panel.querySelector("#castle-model-search") as HTMLInputElement;
  const status = panel.querySelector("#castle-model-status") as HTMLDivElement;
  const list = panel.querySelector("#castle-model-list") as HTMLDivElement;

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  panel.querySelector("#castle-model-close")!.addEventListener("click", close);

  let allModels: string[] = [];
  let activeId = "";

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? allModels.filter((id) => id.toLowerCase().includes(q)) : allModels;
    list.innerHTML = "";
    if (filtered.length === 0) {
      list.innerHTML = `<div style="padding: 16px; font-size: 13px; color: var(--muted-foreground);">No models match.</div>`;
      return;
    }
    for (const id of filtered) {
      const isActive = id === activeId;
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = `
        display:flex;align-items:center;gap:10px;width:100%;text-align:left;
        padding:8px 18px;border:none;cursor:pointer;background:transparent;
        color:var(--foreground);font-size:13px;font-family:ui-monospace,monospace;
      `;
      row.onmouseenter = () => row.style.background = "var(--muted)";
      row.onmouseleave = () => row.style.background = "transparent";
      row.innerHTML = `
        <span style="display:inline-block;width:14px;color:rgb(63 185 80);font-family:ui-sans-serif;">${isActive ? "✓" : ""}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(id)}</span>
      `;
      row.onclick = () => {
        if (id === activeId) { close(); return; }
        agent.setModel(id);
        close();
      };
      list.appendChild(row);
    }
  };

  search.oninput = renderList;

  // Fetch + populate.
  fetch(withBase("/models"))
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<ModelsResponse>;
    })
    .then((data) => {
      allModels = data.models.map((m) => m.id).sort();
      activeId = data.active;
      status.style.display = "none";
      list.style.display = "block";
      renderList();
      search.focus();
    })
    .catch((err) => {
      status.textContent = `Failed to fetch model list from upstream: ${err.message}`;
      status.style.color = "var(--destructive)";
    });

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
