import type { HealthSnapshot, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { openSettingsDialog } from "./SettingsDialog";

/**
 * Lightweight topbar above the ChatPanel. Layout:
 *   [≡] Castle  [● homeassistant.local:8123] [● host.docker.internal:1234]   [📄 prompt] [⚙] [⟲ New chat]
 *
 * Each pill's bubble reflects that backend's reachability:
 * - green when the WS link is up AND the backend reports OK
 * - red when the WS link is up AND the backend reports unreachable
 * - grey when the WS itself is disconnected (server can't tell us anything)
 */

function compactUrl(u: string): string {
  if (!u) return "(unset)";
  return u.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function makePill(label: string): { el: HTMLElement; dot: HTMLElement; text: HTMLElement } {
  const el = document.createElement("span");
  el.style.cssText = `
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
    background: transparent; line-height: 1.4;
    max-width: 220px; min-width: 0;
  `;
  const dot = document.createElement("span");
  dot.style.cssText = "width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex-shrink: 0;";
  const text = document.createElement("span");
  text.style.cssText = "font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
  text.textContent = label;
  el.append(dot, text);
  return { el, dot, text };
}

function setBubble(dot: HTMLElement, state: "ok" | "bad" | "unknown"): void {
  const color = state === "ok" ? "#10b981" : state === "bad" ? "#ef4444" : "#6b7280";
  dot.style.background = color;
}

export function buildTopbar(agent: WebSocketRemoteAgent, onToggleSidebar?: () => void): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 14px; height: 44px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    background: var(--card, var(--background));
    color: var(--muted-foreground);
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const left = document.createElement("div");
  left.style.cssText = "display: flex; align-items: center; gap: 10px; min-width: 0;";

  if (onToggleSidebar) {
    const toggle = document.createElement("button");
    toggle.innerHTML = "&#9776;";
    toggle.title = "Toggle entity sidebar";
    toggle.style.cssText = `
      background: transparent; border: none; color: inherit; cursor: pointer;
      font-size: 16px; padding: 4px 8px; line-height: 1;
    `;
    toggle.onclick = onToggleSidebar;
    left.appendChild(toggle);
  }

  const logo = document.createElement("span");
  logo.textContent = "Castle";
  logo.style.cssText = "font-weight: 700; color: var(--primary, #58a6ff); flex-shrink: 0;";

  const ha = makePill("Home Assistant");
  ha.el.title = "Home Assistant connection";
  const llm = makePill("LLM");
  llm.el.title = "LLM endpoint connection";

  left.append(logo, ha.el, llm.el);

  const right = document.createElement("div");
  right.style.cssText = "display: flex; align-items: center; gap: 8px;";

  const promptBtn = document.createElement("a");
  promptBtn.href = "/agents.md";
  promptBtn.target = "_blank";
  promptBtn.rel = "noopener";
  promptBtn.title = "View the rendered system prompt (AGENTS.md) the agent sees";
  promptBtn.textContent = "📄 prompt";
  promptBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer; text-decoration: none;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  right.append(promptBtn);

  // <theme-toggle> is registered by importing @mariozechner/mini-lit/dist/ThemeToggle.js
  // in main.ts. includeSystem=true cycles light → dark → system; default is system.
  const themeToggle = document.createElement("theme-toggle") as HTMLElement & { includeSystem?: boolean };
  themeToggle.setAttribute("includeSystem", "");
  themeToggle.style.color = "var(--foreground)";
  right.append(themeToggle);

  const settingsBtn = document.createElement("button");
  settingsBtn.title = "Settings";
  settingsBtn.innerHTML = "⚙";
  settingsBtn.style.cssText = `
    padding: 4px 10px; font-size: 16px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px; line-height: 1;
  `;
  settingsBtn.onclick = () => openSettingsDialog(agent);
  right.append(settingsBtn);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⟲ New chat";
  resetBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  resetBtn.onclick = () => {
    if (confirm("Start a new chat? Current conversation will be cleared.")) {
      agent.reset();
    }
  };
  right.append(resetBtn);

  root.append(left, right);

  let connected = false;
  let health: HealthSnapshot | null = null;

  const render = () => {
    if (!connected) {
      // WS down — both bubbles grey, since the server can't tell us anything.
      setBubble(ha.dot, "unknown");
      setBubble(llm.dot, "unknown");
      ha.text.textContent = health ? compactUrl(health.ha_url) : "Home Assistant";
      llm.text.textContent = health ? compactUrl(health.llm_url) : "LLM";
      ha.el.title = "WebSocket disconnected — status unknown";
      llm.el.title = "WebSocket disconnected — status unknown";
      return;
    }
    if (!health) return;
    ha.text.textContent = compactUrl(health.ha_url);
    setBubble(ha.dot, health.ha_ok ? "ok" : "bad");
    ha.el.title = `Home Assistant: ${health.ha_url} (${health.ha_ok ? "connected" : "offline"})`;

    llm.text.textContent = compactUrl(health.llm_url);
    setBubble(llm.dot, health.llm_ok === null ? "unknown" : health.llm_ok ? "ok" : "bad");
    const llmState = health.llm_ok === null ? "probing…" : health.llm_ok ? "reachable" : "unreachable";
    llm.el.title = `LLM endpoint: ${health.llm_url} (${llmState})`;
  };

  agent.onConnectionChange = (c) => {
    connected = c;
    render();
  };
  agent.onHealth = (h) => {
    health = h;
    render();
  };

  render();
  return root;
}
