import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { openSettingsDialog } from "./SettingsDialog";

interface HealthSnapshot {
  ok: boolean;
  entities: number;
  ws_clients: number;
  query_count: number;
  last_query_at: string | null;
}

/**
 * Lightweight topbar above the ChatPanel. Shows:
 *   [● hai]  connected · 115 entities · Qwen3-35B    [⟲ New chat]
 *
 * - Status dot reflects WS connection (red until first open, green while open).
 * - HA-side connectivity / entity count comes from /health, polled every 5s.
 * - Model name comes from the snapshot the agent received from the server.
 */
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

  const dot = document.createElement("span");
  dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; background: #ef4444; transition: background 200ms; flex-shrink: 0;";

  const logo = document.createElement("span");
  logo.textContent = "hai";
  logo.style.cssText = "font-weight: 700; color: var(--primary, #58a6ff);";

  const status = document.createElement("span");
  status.textContent = "connecting…";
  status.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

  left.append(dot, logo, status);

  const right = document.createElement("div");
  right.style.cssText = "display: flex; align-items: center; gap: 8px;";

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

  // State that gets re-rendered into the status string
  let connected = false;
  let health: HealthSnapshot | null = null;

  const renderStatus = () => {
    dot.style.background = connected && health?.ok ? "#10b981" : "#ef4444";
    const parts: string[] = [];
    if (!connected) parts.push("disconnected");
    else if (!health) parts.push("connected");
    else if (!health.ok) parts.push("HA offline");
    else parts.push(`connected · ${health.entities} entities`);
    const modelName = agent.state.model?.name;
    if (modelName && modelName !== "Remote") parts.push(modelName);
    status.textContent = parts.join(" · ");
  };

  agent.onConnectionChange = (c) => {
    connected = c;
    renderStatus();
  };

  // Re-render when the snapshot arrives (so model name shows up).
  agent.subscribe(() => renderStatus());

  const pollHealth = async () => {
    try {
      const res = await fetch("/health");
      if (res.ok) {
        health = await res.json();
        renderStatus();
      }
    } catch { /* ignore */ }
  };
  pollHealth();
  setInterval(pollHealth, 5000);

  renderStatus();
  return root;
}
