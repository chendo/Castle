import type { HealthSnapshot, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { openSettingsDialog } from "./SettingsDialog";
import { openSessionBrowser } from "./SessionBrowser";

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

  const warmBtn = document.createElement("button");
  warmBtn.textContent = "🔥 warm cache";
  warmBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  const warmStatus = document.createElement("span");
  warmStatus.style.cssText = "font-size: 11px; color: var(--muted-foreground); white-space: nowrap;";
  warmStatus.textContent = "never warmed";
  let lastWarmAt: number | null = null;
  let lastWarmDurationMs: number | null = null;
  const fmtAgo = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };
  const fmtDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const renderWarmStatus = () => {
    if (lastWarmAt === null || lastWarmDurationMs === null) {
      warmStatus.textContent = "never warmed";
      warmBtn.title = "Warm the LLM prompt cache so the next prompt has a fast first token";
      return;
    }
    const ago = fmtAgo(Date.now() - lastWarmAt);
    const dur = fmtDuration(lastWarmDurationMs);
    warmStatus.textContent = `warmed ${ago} (${dur})`;
    warmBtn.title = `Last warmed at ${new Date(lastWarmAt).toLocaleTimeString()} — took ${dur}`;
  };
  let warming = false;
  let warmTimeout: number | undefined;
  const setWarmingUi = (on: boolean): void => {
    warming = on;
    warmBtn.disabled = on;
    warmBtn.textContent = on ? "warming…" : "🔥 warm cache";
  };
  warmBtn.onclick = () => {
    if (warming) return;
    setWarmingUi(true);
    agent.warmCache();
    // 120s safety: if the server never replies (LLM stuck, ws dead), the button
    // re-enables so the user can retry rather than being stuck. The persistent
    // onCacheWarmed handler below clears this on the happy path.
    if (warmTimeout) window.clearTimeout(warmTimeout);
    warmTimeout = window.setTimeout(() => setWarmingUi(false), 120_000);
  };
  agent.onCacheWarmed = (at, durationMs) => {
    lastWarmAt = at;
    lastWarmDurationMs = durationMs;
    if (warmTimeout) {
      window.clearTimeout(warmTimeout);
      warmTimeout = undefined;
    }
    if (warming) setWarmingUi(false);
    renderWarmStatus();
  };
  // Refresh the relative "warmed Xs ago" label so it doesn't go stale while
  // the topbar sits open. The topbar is page-lifetime so no teardown needed.
  window.setInterval(renderWarmStatus, 15_000);
  right.append(warmStatus, warmBtn);

  const regenBtn = document.createElement("button");
  regenBtn.title = "Regenerate AGENTS.md from current Home Assistant state (also resets the conversation)";
  regenBtn.textContent = "↻ rebuild";
  regenBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  regenBtn.onclick = () => {
    if (regenBtn.disabled) return;
    regenBtn.disabled = true;
    const original = regenBtn.textContent;
    regenBtn.textContent = "rebuilding…";
    agent.regenerateCatalog();
    // The server replies with a `catalog_regenerated` frame; restore the
    // button when we see it (or after a 10s safety timeout).
    const restore = () => {
      regenBtn.disabled = false;
      regenBtn.textContent = original;
    };
    const timeout = window.setTimeout(restore, 10_000);
    const off = agent.onCatalogRegenerated(() => {
      window.clearTimeout(timeout);
      off();
      restore();
    });
  };
  right.append(regenBtn);

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

  const historyBtn = document.createElement("button");
  historyBtn.title = "Session history — view and resume past conversations";
  historyBtn.textContent = "🕑 History";
  historyBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  historyBtn.onclick = () => openSessionBrowser(agent);
  right.append(historyBtn);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⟲ New chat";
  resetBtn.style.cssText = `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 6px;
  `;
  resetBtn.onclick = () => agent.reset();
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
