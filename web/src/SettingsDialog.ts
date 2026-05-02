import type { ServerSettings, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

interface DialogState {
  allTools: string[];
  enabled: Set<string>;
  loaded: boolean;
}

/**
 * Settings dialog. Lists every available tool with a checkbox so the user can
 * narrow what the agent can call. Apply sends `set_settings` over the WS — the
 * server persists to .pi-agent/settings.json and resets the session so the
 * change takes effect on the next prompt.
 */
export function openSettingsDialog(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("hai-settings-overlay")) return;

  const state: DialogState = {
    allTools: [],
    enabled: new Set(),
    loaded: false,
  };

  const overlay = document.createElement("div");
  overlay.id = "hai-settings-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200;
    display: flex; align-items: center; justify-content: center;
    font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: var(--card); color: var(--foreground);
    border: 1px solid var(--border); border-radius: 14px;
    width: 100%; max-width: 540px; max-height: 90vh;
    display: flex; flex-direction: column;
  `;

  panel.innerHTML = `
    <div style="padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 16px; font-weight: 600;">Settings</div>
      <button id="hai-settings-close" title="Close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    </div>
    <div style="padding: 16px 20px; overflow-y: auto; flex: 1;">
      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 10px;">Enabled tools</div>
      <div id="hai-settings-tools" style="display: flex; flex-direction: column; gap: 4px;">
        <div style="font-size: 13px; color: var(--muted-foreground);">Loading…</div>
      </div>
      <div style="margin-top: 12px; font-size: 12px; color: var(--muted-foreground);">
        Disabling a tool prevents the agent from calling it. Changes restart the conversation.
      </div>
      <div style="margin-top: 8px;">
        <button id="hai-settings-all" style="font-size: 12px; padding: 4px 10px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; margin-right: 6px;">Enable all</button>
        <button id="hai-settings-none" style="font-size: 12px; padding: 4px 10px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer;">Disable all</button>
      </div>
    </div>
    <div style="padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px;">
      <button id="hai-settings-cancel" style="padding: 6px 14px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
      <button id="hai-settings-apply" style="padding: 6px 14px; background: var(--primary, #58a6ff); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;" disabled>Apply</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const toolsContainer = panel.querySelector("#hai-settings-tools") as HTMLElement;
  const applyBtn = panel.querySelector("#hai-settings-apply") as HTMLButtonElement;
  const allBtn = panel.querySelector("#hai-settings-all") as HTMLButtonElement;
  const noneBtn = panel.querySelector("#hai-settings-none") as HTMLButtonElement;

  const renderTools = () => {
    if (!state.loaded) return;
    toolsContainer.innerHTML = "";
    for (const name of [...state.allTools].sort()) {
      const row = document.createElement("label");
      row.style.cssText = "display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 0; font-size: 13px;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.enabled.has(name);
      cb.onchange = () => {
        if (cb.checked) state.enabled.add(name);
        else state.enabled.delete(name);
      };
      const label = document.createElement("span");
      label.style.cssText = "font-family: ui-monospace, monospace;";
      label.textContent = name;
      row.append(cb, label);
      toolsContainer.appendChild(row);
    }
  };

  // Subscribe to settings frames from the agent.
  const prevHandler = agent.onSettings;
  const handler = (settings: ServerSettings, allTools: string[]) => {
    state.allTools = allTools;
    state.enabled = new Set(settings.enabledTools);
    state.loaded = true;
    applyBtn.disabled = false;
    renderTools();
  };
  agent.onSettings = handler;

  // Ask the server for current settings.
  agent.sendRaw({ type: "get_settings" });

  allBtn.onclick = () => {
    state.enabled = new Set(state.allTools);
    renderTools();
  };
  noneBtn.onclick = () => {
    state.enabled = new Set();
    renderTools();
  };

  applyBtn.onclick = () => {
    if (!state.loaded) return;
    agent.sendRaw({
      type: "set_settings",
      settings: { enabledTools: [...state.enabled] },
    });
    close();
  };

  panel.querySelector("#hai-settings-close")!.addEventListener("click", close);
  panel.querySelector("#hai-settings-cancel")!.addEventListener("click", close);

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    agent.onSettings = prevHandler;
  }
}
