import type { ObserverSettingsWire, ServerSettings, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

interface DialogState {
  allTools: string[];
  enabled: Set<string>;
  contextWindow: number;
  allowUnexposedWrites: boolean;
  conversationCapMb: number;
  observer: ObserverSettingsWire;
  loaded: boolean;
}


const OBSERVER_FALLBACK: ObserverSettingsWire = {
  enabled: false,
  heartbeatMinutes: 30,
  reviewHours: 24,
  maxPassesPerHour: 12,
  contextWindow: 65536,
  mutes: [],
  cameras: [],
  scope: { automationHealth: true, deviceHealth: true, suggestions: true, automationGaps: true },
};

const MIN_CONTEXT_WINDOW = 8192;

function intOr(raw: string, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function splitIds(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
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
    contextWindow: 65536,
    allowUnexposedWrites: false,
    conversationCapMb: 100,
    observer: OBSERVER_FALLBACK,
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

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Write protection</div>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
        <input id="castle-settings-allow-unexposed" type="checkbox" />
        <span>Allow agent to control non-exposed entities</span>
      </label>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Off (default): the agent can only call services / set state on entities exposed to assistants. Reads are unaffected.
      </div>

      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 18px 0 10px;">Observer</div>
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
        <input id="castle-settings-observer-enabled" type="checkbox" />
        <span>Watch the event stream in the background</span>
      </label>
      <div style="margin-top: 6px; font-size: 12px; color: var(--muted-foreground);">
        Off (default). When on, a second agent reads Home Assistant's event stream and records
        concerns and the actions it <em>would</em> have taken. It has no write tools — this release
        is a dry run and nothing it proposes is executed.
      </div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px;">
        <label style="font-size: 12px; color: var(--muted-foreground);">Health sweep (min, 0 = off)<br>
          <input id="castle-settings-observer-heartbeat" type="number" min="0" step="5" style="width: 90px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
        </label>
        <label style="font-size: 12px; color: var(--muted-foreground);">Review (hours, 0 = off)<br>
          <input id="castle-settings-observer-review" type="number" min="0" step="1" style="width: 90px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
        </label>
        <label style="font-size: 12px; color: var(--muted-foreground);">Max passes / hour<br>
          <input id="castle-settings-observer-rate" type="number" min="1" max="30" step="1" style="width: 90px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
        </label>
      </div>
      <div style="margin-top: 10px; font-size: 12px; color: var(--muted-foreground);">Cameras the observer may look at (comma-separated entity ids). Empty means it never looks at any.</div>
      <input id="castle-settings-observer-cameras" type="text" placeholder="camera.front_door, camera.driveway" style="width: 100%; margin-top: 4px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />
      <div style="margin-top: 10px; font-size: 12px; color: var(--muted-foreground);">Entities to ignore entirely (comma-separated).</div>
      <input id="castle-settings-observer-mutes" type="text" placeholder="binary_sensor.flaky_motion" style="width: 100%; margin-top: 4px; padding: 4px 8px; font-size: 13px; background: var(--background); color: var(--foreground); border: 1px solid var(--border); border-radius: 6px;" />

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
  const obsEnabled = panel.querySelector("#castle-settings-observer-enabled") as HTMLInputElement;
  const obsHeartbeat = panel.querySelector("#castle-settings-observer-heartbeat") as HTMLInputElement;
  const obsReview = panel.querySelector("#castle-settings-observer-review") as HTMLInputElement;
  const obsRate = panel.querySelector("#castle-settings-observer-rate") as HTMLInputElement;
  const obsCameras = panel.querySelector("#castle-settings-observer-cameras") as HTMLInputElement;
  const obsMutes = panel.querySelector("#castle-settings-observer-mutes") as HTMLInputElement;
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
    state.conversationCapMb = settings.conversationCapMb;
    state.observer = settings.observer ?? OBSERVER_FALLBACK;
    state.loaded = true;
    obsEnabled.checked = state.observer.enabled;
    obsHeartbeat.value = String(state.observer.heartbeatMinutes);
    obsReview.value = String(state.observer.reviewHours);
    obsRate.value = String(state.observer.maxPassesPerHour);
    obsCameras.value = state.observer.cameras.join(", ");
    obsMutes.value = state.observer.mutes.join(", ");
    contextInput.value = String(settings.contextWindow);
    allowUnexposedInput.checked = settings.allowUnexposedWrites;
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
        contextWindow,
        allowUnexposedWrites: allowUnexposedInput.checked,
        conversationCapMb,
        observer: {
          ...state.observer,
          enabled: obsEnabled.checked,
          heartbeatMinutes: intOr(obsHeartbeat.value, state.observer.heartbeatMinutes),
          reviewHours: intOr(obsReview.value, state.observer.reviewHours),
          maxPassesPerHour: intOr(obsRate.value, state.observer.maxPassesPerHour),
          // The server re-validates both lists (entity-id shape, and the
          // camera domain) — this is only a convenience split.
          cameras: splitIds(obsCameras.value),
          mutes: splitIds(obsMutes.value),
        },
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
