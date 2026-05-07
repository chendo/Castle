// Mobile-first app shell: top app bar, hamburger drawer, routed main content,
// bottom nav. Three routes — `/` (Now), `/dashboard` (area cards), `/chat`
// (chat panel; bare with ?embed=1 for HA-card iframe embedding).
//
// Responsive: <768px = bottom nav visible, drawer slides over. ≥768px = chat
// pinned right pane on / and /dashboard, no bottom nav, drawer still
// available.

import type { ChatPanel } from "@mariozechner/pi-web-ui";
import type { SidebarHandle } from "./Sidebar";
import type { DashboardHandle } from "./Dashboard";
import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { buildStarterPrompts } from "./StarterPrompts";
import { buildVoiceButton } from "./VoiceButton";
import { tasksStore } from "./TasksStore";
import { openTasksDialog } from "./TasksDialog";
import { openSettingsDialog } from "./SettingsDialog";

type Route = "now" | "dashboard" | "chat";

function resolveRoute(): Route {
  const p = location.pathname;
  if (p.startsWith("/dashboard")) return "dashboard";
  if (p.startsWith("/chat")) return "chat";
  return "now";
}

function isEmbed(): boolean {
  return new URL(location.href).searchParams.get("embed") === "1";
}

interface ShellInputs {
  agent: WebSocketRemoteAgent;
  chatPanel: ChatPanel;
  sidebar: SidebarHandle;
  dashboard: DashboardHandle;
}

export function buildShell({ agent, chatPanel, sidebar, dashboard }: ShellInputs): HTMLElement {
  const shell = document.createElement("div");
  shell.style.cssText = `
    display: flex; flex-direction: column;
    height: 100vh; height: 100dvh;
    background: var(--background); color: var(--foreground);
  `;

  // ── Top app bar ─────────────────────────────────────────────────────────
  const topbar = document.createElement("header");
  topbar.style.cssText = `
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px; height: 52px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--card, var(--background));
  `;

  const hamburger = iconButton("☰", "Open menu");
  hamburger.style.fontSize = "20px";
  topbar.appendChild(hamburger);

  const logo = document.createElement("span");
  logo.textContent = "Castle";
  logo.style.cssText = "font-weight: 700; color: var(--primary, #58a6ff); font-size: 16px; flex: 1;";
  topbar.appendChild(logo);

  const tasksChip = document.createElement("button");
  tasksChip.style.cssText = `
    display: none; align-items: center; gap: 6px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    background: transparent; color: var(--foreground);
    border: 1px solid var(--border); border-radius: 999px;
    line-height: 1;
  `;
  tasksChip.title = "Scheduled tasks";
  tasksChip.onclick = () => openTasksDialog(agent);
  const renderTasksChip = () => {
    const list = tasksStore.list();
    if (list.length === 0) { tasksChip.style.display = "none"; return; }
    const active = tasksStore.activeCount();
    const fired = list.filter((t) => t.status === "fired").length;
    const dot = active > 0 ? `<span style="width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;"></span>` : "";
    const firedSuffix = fired > 0 ? ` · ${fired} fired` : "";
    tasksChip.innerHTML = `${dot}<span>👁 ${active}${firedSuffix}</span>`;
    tasksChip.style.display = "inline-flex";
  };
  tasksStore.subscribe(renderTasksChip);
  topbar.appendChild(tasksChip);

  const settingsBtn = iconButton("⚙", "Settings");
  settingsBtn.onclick = () => openSettingsDialog(agent);
  topbar.appendChild(settingsBtn);

  const themeToggle = document.createElement("theme-toggle") as HTMLElement & { includeSystem?: boolean };
  themeToggle.setAttribute("includeSystem", "");
  themeToggle.style.color = "var(--foreground)";
  topbar.appendChild(themeToggle);

  // ── Drawer (hamburger menu) ──────────────────────────────────────────────
  const drawer = document.createElement("aside");
  drawer.style.cssText = `
    position: fixed; top: 0; left: 0; bottom: 0; width: min(85vw, 360px);
    background: var(--card); border-right: 1px solid var(--border);
    transform: translateX(-100%); transition: transform 200ms ease;
    z-index: 100; display: flex; flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,0.2);
  `;
  // Reuse the existing sidebar (search + tree + Settings/History/Prompt).
  sidebar.root.style.height = "100%";
  sidebar.root.style.borderRight = "none";
  drawer.appendChild(sidebar.root);

  const scrim = document.createElement("div");
  scrim.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    opacity: 0; pointer-events: none; transition: opacity 200ms ease;
    z-index: 99;
  `;
  scrim.onclick = () => closeDrawer();
  let drawerOpen = false;
  function openDrawer(): void {
    drawerOpen = true;
    drawer.style.transform = "translateX(0)";
    scrim.style.opacity = "1";
    scrim.style.pointerEvents = "auto";
  }
  function closeDrawer(): void {
    drawerOpen = false;
    drawer.style.transform = "translateX(-100%)";
    scrim.style.opacity = "0";
    scrim.style.pointerEvents = "none";
  }
  hamburger.onclick = () => drawerOpen ? closeDrawer() : openDrawer();
  document.body.append(scrim, drawer);

  // ── Main content area ──────────────────────────────────────────────────
  const main = document.createElement("main");
  main.style.cssText = `
    flex: 1; min-height: 0; display: flex; overflow: hidden;
  `;

  // Route panes — only the active one is mounted.
  const nowPane = buildNowPane();
  const dashPane = dashboard.root;
  // Chat pane wraps ChatPanel + StarterPrompts + voice button.
  const chatPane = buildChatPane(chatPanel, agent);

  // Desktop pinned chat: same chat panel can't exist in two trees, so we
  // reparent on layout transitions. Simpler: only mount the chat pane in
  // the active route slot. Desktop "pinned chat" defers to v2.
  const contentArea = document.createElement("div");
  contentArea.style.cssText = "flex: 1; min-width: 0; min-height: 0; display: flex;";
  main.appendChild(contentArea);

  // ── Bottom nav (mobile) ────────────────────────────────────────────────
  const bottomNav = document.createElement("nav");
  bottomNav.style.cssText = `
    display: flex; align-items: stretch; flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--card, var(--background));
  `;
  const navNow = navButton("now", "💬", "Now");
  const navDash = navButton("dashboard", "▦", "Dashboard");
  const navChat = navButton("chat", "🗨", "Chat");
  bottomNav.append(navNow, navDash, navChat);

  function navButton(route: Route, icon: string, label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.style.cssText = `
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2px;
      padding: 8px 4px; min-height: 56px;
      background: transparent; border: none;
      color: var(--muted-foreground); cursor: pointer;
      font-size: 11px;
    `;
    b.innerHTML = `<span style="font-size: 18px; line-height: 1;">${icon}</span><span>${label}</span>`;
    b.onclick = () => navigate(route);
    b.dataset.route = route;
    return b;
  }

  // ── Routing ────────────────────────────────────────────────────────────
  function navigate(route: Route): void {
    const path = route === "now" ? "/" : `/${route}`;
    if (location.pathname !== path) {
      history.pushState(null, "", path + location.search);
    }
    render(route);
    closeDrawer();
  }

  function render(route: Route): void {
    contentArea.innerHTML = "";
    if (route === "now") contentArea.appendChild(nowPane);
    else if (route === "dashboard") {
      // Dashboard's legacy "collapsed" localStorage flag could leave display:none
      // baked into its root from a prior session; force-show it on mount.
      dashPane.style.display = "";
      contentArea.appendChild(dashPane);
    } else contentArea.appendChild(chatPane);
    for (const btn of bottomNav.querySelectorAll<HTMLButtonElement>("button")) {
      const active = btn.dataset.route === route;
      btn.style.color = active ? "var(--primary, #58a6ff)" : "var(--muted-foreground)";
    }
    // Hide everything but the chat pane when embedded for HA card use.
    const embed = isEmbed() && route === "chat";
    topbar.style.display = embed ? "none" : "flex";
    bottomNav.style.display = embed ? "none" : "flex";
  }

  globalThis.addEventListener("popstate", () => render(resolveRoute()));

  shell.append(topbar, main, bottomNav);
  // Initial render on the current URL route.
  render(resolveRoute());

  return shell;
}

function iconButton(text: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.style.cssText = `
    background: transparent; border: none; cursor: pointer;
    color: var(--foreground); padding: 8px; line-height: 1;
    font-size: 18px; border-radius: 6px;
  `;
  return b;
}

function buildNowPane(): HTMLElement {
  const pane = document.createElement("section");
  pane.style.cssText = `
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 16px; max-width: 720px; margin: 0 auto; width: 100%;
  `;
  const heading = document.createElement("h2");
  heading.textContent = "Now";
  heading.style.cssText = "font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted-foreground); margin: 0 0 12px;";
  pane.appendChild(heading);
  const empty = document.createElement("p");
  empty.style.cssText = "font-size: 14px; color: var(--muted-foreground); line-height: 1.5;";
  empty.textContent = "Nothing yet. Recently-referenced entities will appear here as the agent looks at things.";
  pane.appendChild(empty);
  return pane;
}

function buildChatPane(chatPanel: ChatPanel, agent: WebSocketRemoteAgent): HTMLElement {
  const wrap = document.createElement("section");
  wrap.style.cssText = `
    flex: 1; min-width: 0; min-height: 0;
    display: flex; flex-direction: column; position: relative;
  `;
  wrap.appendChild(chatPanel as unknown as HTMLElement);
  wrap.appendChild(buildStarterPrompts(agent));

  // Voice button — pinned bottom-right, above the chat input. UI stub.
  const voice = buildVoiceButton();
  voice.style.position = "absolute";
  voice.style.right = "18px";
  voice.style.bottom = "84px";
  voice.style.zIndex = "5";
  wrap.appendChild(voice);

  return wrap;
}

