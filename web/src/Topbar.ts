import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

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
export function buildTopbar(agent: WebSocketRemoteAgent): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 14px; height: 44px; flex-shrink: 0;
    border-bottom: 1px solid rgb(var(--border, 39 39 42));
    font-size: 13px; background: rgb(var(--background, 9 9 11));
    color: rgb(var(--muted-foreground, 161 161 170));
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;

  const left = document.createElement("div");
  left.style.cssText = "display: flex; align-items: center; gap: 10px; min-width: 0;";

  const dot = document.createElement("span");
  dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; background: #ef4444; transition: background 200ms; flex-shrink: 0;";

  const logo = document.createElement("span");
  logo.textContent = "hai";
  logo.style.cssText = "font-weight: 700; color: #58a6ff;";

  const status = document.createElement("span");
  status.textContent = "connecting…";
  status.style.cssText = "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

  left.append(dot, logo, status);

  const right = document.createElement("div");
  right.style.cssText = "display: flex; align-items: center; gap: 8px;";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⟲ New chat";
  resetBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: inherit;
    border: 1px solid rgb(var(--border, 39 39 42)); border-radius: 6px;
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
