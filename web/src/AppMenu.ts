// Hamburger-drawer contents. Replaces what used to be the full entity sidebar.
// The entity tree itself moves behind a button in the Settings dialog
// (EntityBrowserDialog) — for the new shell, the drawer is just an app menu.

import type { HealthSnapshot, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { openSettingsDialog } from "./SettingsDialog";
import { openSessionBrowser } from "./SessionBrowser";
import { openEntityBrowserDialog } from "./EntityBrowserDialog";

export function buildAppMenu(agent: WebSocketRemoteAgent): HTMLElement {
  const root = document.createElement("aside");
  root.style.cssText = `
    display: flex; flex-direction: column; height: 100%;
    background: var(--card, var(--background)); color: var(--foreground);
    font: 14px ui-sans-serif, system-ui, sans-serif;
  `;

  const header = document.createElement("div");
  header.style.cssText = "padding: 16px 18px; border-bottom: 1px solid var(--border);";
  const title = document.createElement("div");
  title.textContent = "Castle";
  title.style.cssText = "font-weight: 700; font-size: 16px; color: var(--primary, #58a6ff);";
  header.appendChild(title);
  root.appendChild(header);

  // ── Section: navigation ────────────────────────────────────────────────
  const nav = document.createElement("section");
  nav.style.cssText = "padding: 6px 0;";
  nav.appendChild(navRow("💬", "Now", () => navigate("/")));
  nav.appendChild(navRow("▦", "Dashboard", () => navigate("/dashboard")));
  nav.appendChild(navRow("🗨", "Chat", () => navigate("/chat")));
  root.appendChild(nav);

  divider(root);

  // ── Section: tools ─────────────────────────────────────────────────────
  const tools = document.createElement("section");
  tools.style.cssText = "padding: 6px 0;";
  tools.appendChild(navRow("⚙", "Settings", () => openSettingsDialog(agent)));
  tools.appendChild(navRow("🔍", "Browse entities", () => openEntityBrowserDialog(agent)));
  tools.appendChild(navRow("🕑", "Sessions", () => openSessionBrowser(agent)));
  tools.appendChild(navRow("📄", "View system prompt", () => window.open("/agents.md", "_blank", "noopener")));
  root.appendChild(tools);

  divider(root);

  // ── Section: actions ───────────────────────────────────────────────────
  const actions = document.createElement("section");
  actions.style.cssText = "padding: 6px 0;";
  actions.appendChild(navRow("⟲", "New chat", () => agent.reset()));
  actions.appendChild(navRow("🔥", "Warm prompt cache", () => agent.warmCache()));
  actions.appendChild(navRow("↻", "Rebuild catalog", () => agent.regenerateCatalog()));
  root.appendChild(actions);

  // ── Footer: status bubbles ─────────────────────────────────────────────
  const footer = document.createElement("div");
  footer.style.cssText = `
    margin-top: auto; padding: 12px 18px;
    border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 8px;
    font-size: 11px; color: var(--muted-foreground);
  `;
  const haRow = statusRow("Home Assistant");
  const llmRow = statusRow("LLM");
  footer.append(haRow.row, llmRow.row);
  root.appendChild(footer);

  // ── Wiring ─────────────────────────────────────────────────────────────
  let connected = false;
  let health: HealthSnapshot | null = null;
  const renderStatus = () => {
    if (!connected) {
      haRow.set("unknown", "WS disconnected");
      llmRow.set("unknown", "WS disconnected");
      return;
    }
    if (!health) return;
    haRow.set(health.ha_ok ? "ok" : "bad", health.ha_url || "(unset)");
    const llmState = health.llm_ok === null ? "unknown" : health.llm_ok ? "ok" : "bad";
    llmRow.set(llmState, health.llm_url || "(unset)");
  };
  // Don't clobber existing handlers — chain instead.
  const prevConn = agent.onConnectionChange;
  agent.onConnectionChange = (c) => { prevConn?.(c); connected = c; renderStatus(); };
  const prevHealth = agent.onHealth;
  agent.onHealth = (h) => { prevHealth?.(h); health = h; renderStatus(); };

  return root;
}

function navRow(icon: string, label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText = `
    width: 100%; text-align: left; cursor: pointer;
    display: flex; align-items: center; gap: 12px;
    padding: 10px 18px; font-size: 14px;
    background: transparent; border: none; color: inherit;
    font-family: inherit;
  `;
  btn.onmouseenter = () => { btn.style.background = "var(--muted-background, rgba(128,128,128,0.08))"; };
  btn.onmouseleave = () => { btn.style.background = ""; };
  btn.onclick = onClick;
  const iconEl = document.createElement("span");
  iconEl.textContent = icon;
  iconEl.style.cssText = "width: 20px; flex-shrink: 0; text-align: center; font-size: 16px;";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  labelEl.style.flex = "1";
  btn.append(iconEl, labelEl);
  return btn;
}

function divider(parent: HTMLElement): void {
  const hr = document.createElement("hr");
  hr.style.cssText = "border: none; border-top: 1px solid var(--border); margin: 0;";
  parent.appendChild(hr);
}

function statusRow(label: string): {
  row: HTMLElement;
  set: (state: "ok" | "bad" | "unknown", text: string) => void;
} {
  const row = document.createElement("div");
  row.style.cssText = "display: flex; align-items: center; gap: 8px;";
  const dot = document.createElement("span");
  dot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex-shrink: 0;";
  const labelEl = document.createElement("span");
  labelEl.style.cssText = "flex-shrink: 0; font-weight: 500;";
  labelEl.textContent = label;
  const valEl = document.createElement("span");
  valEl.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
  row.append(dot, labelEl, valEl);
  return {
    row,
    set: (state, text) => {
      const color = state === "ok" ? "#10b981" : state === "bad" ? "#ef4444" : "#6b7280";
      dot.style.background = color;
      valEl.textContent = text;
    },
  };
}

/**
 * SPA-aware navigation. Push state and dispatch popstate so the Shell's
 * router re-renders without a full page load. Shell already listens to
 * popstate on the global object.
 */
function navigate(path: string): void {
  if (location.pathname !== path) {
    history.pushState(null, "", path + location.search);
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
  }
}
