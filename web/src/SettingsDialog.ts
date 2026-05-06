import type { ServerSettings, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

interface DialogState {
  allTools: string[];
  enabled: Set<string>;
  disableThinking: boolean;
  contextWindow: number;
  allowUnexposedWrites: boolean;
  conversationCapMb: number;
  loaded: boolean;
}

const MIN_CONTEXT_WINDOW = 8192;
const MIN_CONVERSATION_CAP_MB = 10;

/**
 * Settings dialog. One enable/disable checkbox per tool. Apply sends
 * `set_settings` over the WS — the server persists to
 * .pi-agent/settings.json and resets the session so changes take effect on
 * the next prompt.
 */
export function openSettingsDialog(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("castle-settings-overlay")) return;

  const state: DialogState = {
    allTools: [],
    enabled: new Set(),
    disableThinking: false,
    contextWindow: 65536,
    allowUnexposedWrites: false,
    conversationCapMb: 100,
    loaded: false,
  };

  const overlay = document.createElement("div");
  overlay.id = "castle-settings-overlay";
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
    width: 100%; max-width: 640px; max-height: 90vh;
    display: flex; flex-direction: column;
  `;

  panel.innerHTML = `
    <div style="padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 16px; font-weight: 600;">Settings</div>
      <button id="castle-settings-close" title="Close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    </div>
    <div style="padding: 16px 20px; overflow-y: auto; flex: 1;">
      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin-bottom: 10px;">Context window</div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <input id="castle-settings-context" type="number" min="${MIN_CONTEXT_WINDOW}" step="1024" style="width: 140px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
        <span style="font-size: 12px; color: var(--muted-foreground);">tokens (min ${MIN_CONTEXT_WINDOW.toLocaleString()})</span>
      </div>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Set to whatever your model server actually supports. Compaction thresholds scale with this value.
      </div>

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Model behaviour</div>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
        <input id="castle-settings-disable-thinking" type="checkbox" />
        <span>Disable thinking (Qwen3 <code>/no_think</code>)</span>
      </label>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Skips the model's reasoning phase to cut TTFT. For Qwen3 family, also appends <code>/no_think</code> to each user message so the chat template suppresses the &lt;think&gt; block.
      </div>

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Write protection</div>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
        <input id="castle-settings-allow-unexposed" type="checkbox" />
        <span>Allow agent to control non-exposed entities</span>
      </label>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Off (default): the agent can only call services / set state on entities exposed to assistants. Reads are unaffected.
      </div>

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Conversation storage cap</div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <input id="castle-settings-cap" type="number" min="${MIN_CONVERSATION_CAP_MB}" step="10" style="width: 100px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
        <span style="font-size: 12px; color: var(--muted-foreground);">MiB (min ${MIN_CONVERSATION_CAP_MB.toLocaleString()})</span>
      </div>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Oldest sessions are deleted first when the JSONL store exceeds this cap. The active session is never pruned.
      </div>

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Tools</div>
      <div id="castle-settings-tools" style="display: flex; flex-direction: column; gap: 4px;">
        <div style="font-size: 13px; color: var(--muted-foreground);">Loading…</div>
      </div>
      <div style="margin-top: 12px;">
        <button id="castle-settings-all" style="font-size: 12px; padding: 4px 10px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; margin-right: 6px;">Enable all</button>
        <button id="castle-settings-none" style="font-size: 12px; padding: 4px 10px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer;">Disable all</button>
      </div>
      <div style="margin-top: 8px; font-size: 12px; color: var(--muted-foreground);">
        Changes restart the conversation.
      </div>
    </div>
    <div style="padding: 12px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px;">
      <button id="castle-settings-cancel" style="padding: 6px 14px; background: transparent; color: var(--foreground); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
      <button id="castle-settings-apply" style="padding: 6px 14px; background: var(--primary, #58a6ff); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;" disabled>Apply</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const toolsContainer = panel.querySelector("#castle-settings-tools") as HTMLElement;
  const applyBtn = panel.querySelector("#castle-settings-apply") as HTMLButtonElement;
  const allBtn = panel.querySelector("#castle-settings-all") as HTMLButtonElement;
  const noneBtn = panel.querySelector("#castle-settings-none") as HTMLButtonElement;
  const contextInput = panel.querySelector("#castle-settings-context") as HTMLInputElement;
  const allowUnexposedInput = panel.querySelector("#castle-settings-allow-unexposed") as HTMLInputElement;
  const disableThinkingInput = panel.querySelector("#castle-settings-disable-thinking") as HTMLInputElement;
  const capInput = panel.querySelector("#castle-settings-cap") as HTMLInputElement;

  const renderToolRow = (name: string): HTMLElement => {
    const row = document.createElement("label");
    row.style.cssText = `
      display: flex; align-items: center; gap: 8px; padding: 4px 0;
      cursor: pointer; font-size: 13px;
    `;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.enabled.has(name);
    cb.onchange = () => {
      if (cb.checked) state.enabled.add(name);
      else state.enabled.delete(name);
    };
    const labelText = document.createElement("span");
    labelText.style.cssText = "font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    labelText.textContent = name;
    row.append(cb, labelText);
    return row;
  };

  const renderTools = () => {
    if (!state.loaded) return;
    toolsContainer.innerHTML = "";
    for (const n of [...state.allTools].sort()) {
      toolsContainer.appendChild(renderToolRow(n));
    }
  };

  // Subscribe to settings frames from the agent.
  const prevHandler = agent.onSettings;
  const handler = (settings: ServerSettings, allTools: string[]) => {
    state.allTools = allTools;
    state.enabled = new Set(settings.enabledTools);
    state.contextWindow = settings.contextWindow;
    state.allowUnexposedWrites = settings.allowUnexposedWrites;
    state.disableThinking = settings.disableThinking;
    state.conversationCapMb = settings.conversationCapMb;
    state.loaded = true;
    contextInput.value = String(settings.contextWindow);
    allowUnexposedInput.checked = settings.allowUnexposedWrites;
    disableThinkingInput.checked = settings.disableThinking;
    capInput.value = String(settings.conversationCapMb);
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
    const parsed = Math.floor(Number(contextInput.value));
    const contextWindow = Number.isFinite(parsed) && parsed >= MIN_CONTEXT_WINDOW
      ? parsed
      : state.contextWindow;
    const capRaw = Math.floor(Number(capInput.value));
    const conversationCapMb = Number.isFinite(capRaw) && capRaw >= MIN_CONVERSATION_CAP_MB
      ? capRaw
      : state.conversationCapMb;
    agent.sendRaw({
      type: "set_settings",
      settings: {
        enabledTools: [...state.enabled],
        disableThinking: disableThinkingInput.checked,
        contextWindow,
        allowUnexposedWrites: allowUnexposedInput.checked,
        conversationCapMb,
      },
    });
    close();
  };

  panel.querySelector("#castle-settings-close")!.addEventListener("click", close);
  panel.querySelector("#castle-settings-cancel")!.addEventListener("click", close);

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    agent.onSettings = prevHandler;
  }
}
