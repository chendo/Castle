// Mobile-first app shell: top app bar, hamburger drawer, routed main content,
// bottom nav. Routes — `/` (Now), `/dashboard` (area cards), `/chat` (bare
// chat-only view for HA-card iframe embedding; no topbar, drawer, or nav).
//
// Responsive: <768px = bottom nav visible, drawer slides over. ≥768px = chat
// lives as a resizable right sidebar that's always visible alongside the
// routed pane (Now/Dashboard); width persists in localStorage. The `/chat`
// embed view bypasses both layouts and renders chat fullscreen.

import type { ChatPanel } from "@mariozechner/pi-web-ui";
import type { DashboardHandle } from "./Dashboard";
import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { buildVoiceButton } from "./VoiceButton";
import { openSettingsDialog } from "./SettingsDialog";
import { recentEntitiesStore } from "./RecentEntitiesStore";
import { entityCache } from "./EntityStateCache";
import { buildEntityCard, type CardHandle } from "./EntityCard";
import { buildAppMenu } from "./AppMenu";
import { BASE, withBase, stripBase } from "./base";

type Route = "now" | "dashboard" | "chat";

function resolveRoute(): Route {
  const p = stripBase(location.pathname);
  if (p.startsWith("/dashboard")) return "dashboard";
  if (p.startsWith("/chat")) return "chat";
  // When loaded inside HA's Supervisor ingress iframe, the panel root opens
  // straight into the bare chat view — that's the primary use case for the
  // add-on. Elsewhere (standalone / dev), the root still lands on Now.
  if (BASE && (p === "/" || p === "")) return "chat";
  return "now";
}

interface ShellInputs {
  agent: WebSocketRemoteAgent;
  chatPanel: ChatPanel;
  dashboard: DashboardHandle;
}

export function buildShell({ agent, chatPanel, dashboard }: ShellInputs): HTMLElement {
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
  // Slim app menu — entity browser lives behind a button here, not directly
  // in the drawer (per the spec: "move the entity stuff into settings for
  // now"). Keeps the drawer fast to scan and avoids an entity tree taking
  // up the whole screen on mobile.
  drawer.appendChild(buildAppMenu(agent));

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
  // flex-direction is set per-render: row on desktop (split with right
  // sidebar), column on mobile / embed.

  // Route panes — only the active one is mounted into contentArea.
  const nowPane = buildNowPane(agent);
  const dashPane = dashboard.root;

  // contentArea holds the routed pane (Now / Dashboard). chatDock sits
  // alongside it on desktop as a resizable right sidebar, or replaces it
  // entirely on mobile when the user navigates to /chat. The chat panel lives
  // permanently inside chatDock so we never reparent it.
  const contentArea = document.createElement("div");
  contentArea.style.cssText = "flex: 1; min-width: 0; min-height: 0; display: flex;";

  const chatDock = buildChatDock(chatPanel, agent);

  // Resizer handle between contentArea and chatDock on desktop. Hidden on
  // mobile/embed. Drag to resize the sidebar; the width persists.
  const CHAT_WIDTH_KEY = "castle.chatSidebarWidth";
  const MIN_CHAT_WIDTH = 320;
  const MAX_CHAT_WIDTH = 800;
  const MIN_CONTENT_WIDTH = 320;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let chatWidth = clamp(
    Number(localStorage.getItem(CHAT_WIDTH_KEY)) || 420,
    MIN_CHAT_WIDTH,
    MAX_CHAT_WIDTH,
  );

  const resizer = document.createElement("div");
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.title = "Drag to resize";
  resizer.style.cssText = `
    flex: 0 0 6px; cursor: col-resize; background: transparent;
    border-left: 1px solid var(--border);
    transition: background-color 120ms ease;
    touch-action: none;
  `;
  resizer.addEventListener("mouseenter", () => { resizer.style.background = "var(--border)"; });
  resizer.addEventListener("mouseleave", () => { if (!dragging) resizer.style.background = "transparent"; });

  let dragging = false;
  resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const maxByContent = Math.max(MIN_CHAT_WIDTH, rect.width - MIN_CONTENT_WIDTH);
    chatWidth = clamp(rect.right - e.clientX, MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, maxByContent));
    chatDock.style.flex = `0 0 ${chatWidth}px`;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    resizer.style.background = "transparent";
    localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
  };
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);

  main.append(contentArea, resizer, chatDock);

  // ── Bottom nav (mobile) ────────────────────────────────────────────────
  const bottomNav = document.createElement("nav");
  bottomNav.style.cssText = `
    display: flex; align-items: stretch; flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--card, var(--background));
  `;
  const navNow = navButton("now", "💬", "Now");
  const navDash = navButton("dashboard", "▦", "Dashboard");
  bottomNav.append(navNow, navDash);

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
    const path = withBase(route === "now" ? "/" : `/${route}`);
    if (location.pathname !== path) {
      history.pushState(null, "", path + location.search);
    }
    render(route);
    closeDrawer();
  }

  // Track viewport so render() can decide whether to show chat alongside
  // the routed pane (desktop) or only on /chat (mobile).
  const desktopMQ = matchMedia("(min-width: 768px)");
  let isDesktop = desktopMQ.matches;
  desktopMQ.addEventListener("change", (e) => {
    isDesktop = e.matches;
    render(resolveRoute());
  });

  function render(route: Route): void {
    // 1. Load the routed pane into contentArea (Now / Dashboard / nothing-on-chat).
    contentArea.innerHTML = "";
    if (route === "now") contentArea.appendChild(nowPane);
    else if (route === "dashboard") {
      // Dashboard's legacy "collapsed" localStorage flag could leave display:none
      // baked into its root from a prior session; force-show it on mount.
      dashPane.style.display = "";
      contentArea.appendChild(dashPane);
    }

    // 2. Layout: /chat is the bare embed view (no chrome, chat fullscreen),
    //    desktop is split-with-sidebar, mobile is route-based.
    if (route === "chat") {
      main.style.flexDirection = "column";
      contentArea.style.display = "none";
      resizer.style.display = "none";
      chatDock.style.display = "flex";
      chatDock.style.flex = "1";
      chatDock.style.minHeight = "0";
      chatDock.style.borderLeft = "none";
      chatDock.style.borderTop = "none";
    } else if (isDesktop) {
      // Desktop: chat is always visible as a resizable right sidebar.
      main.style.flexDirection = "row";
      contentArea.style.display = "flex";
      contentArea.style.flex = "1 1 auto";
      resizer.style.display = "block";
      chatDock.style.display = "flex";
      chatDock.style.flex = `0 0 ${chatWidth}px`;
      chatDock.style.minHeight = "0";
      chatDock.style.borderLeft = "1px solid var(--border)";
      chatDock.style.borderTop = "none";
    } else {
      // Mobile: column layout, routed pane only (chat lives at /chat as a
      // bare embed, intentionally not reachable from the bottom nav).
      main.style.flexDirection = "column";
      resizer.style.display = "none";
      contentArea.style.display = "flex";
      contentArea.style.flex = "1";
      chatDock.style.display = "none";
    }

    for (const btn of bottomNav.querySelectorAll<HTMLButtonElement>("button")) {
      const active = btn.dataset.route === route;
      btn.style.color = active ? "var(--primary, #58a6ff)" : "var(--muted-foreground)";
    }

    const bare = route === "chat";
    topbar.style.display = bare ? "none" : "flex";
    // Bottom nav is mobile-only navigation — desktop uses the AppMenu drawer.
    bottomNav.style.display = bare || isDesktop ? "none" : "flex";
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

function buildNowPane(agent: WebSocketRemoteAgent): HTMLElement {
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
  empty.textContent = "Nothing yet. As the agent looks at entities, they'll show up here.";
  pane.appendChild(empty);

  const grid = document.createElement("div");
  grid.style.cssText = `
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    align-content: start;
  `;
  pane.appendChild(grid);

  // Reuse existing entity-card containers across renders so toggles, sliders
  // etc. don't get torn out from under a click. Map by entity_id.
  const cards = new Map<string, { container: HTMLElement; handle: CardHandle }>();

  const render = (entities: { entity_id: string }[]) => {
    if (entities.length === 0) {
      empty.style.display = "";
      grid.style.display = "none";
      // Tear down any leftover handles.
      for (const { handle } of cards.values()) handle.dispose();
      cards.clear();
      return;
    }
    empty.style.display = "none";
    grid.style.display = "";
    const seen = new Set<string>();
    grid.innerHTML = "";
    for (const { entity_id } of entities) {
      seen.add(entity_id);
      let entry = cards.get(entity_id);
      if (!entry) {
        const container = document.createElement("div");
        const state = entityCache.get(entity_id);
        const domain = entity_id.split(".")[0];
        const handle = buildEntityCard(
          { entity_id, kind: "entity", domain: state?.domain ?? domain },
          { agent, cache: entityCache },
          container,
        );
        entry = { container, handle };
        cards.set(entity_id, entry);
      }
      grid.appendChild(entry.container);
    }
    // Drop entries that fell out of the LRU.
    for (const [id, { handle }] of cards) {
      if (!seen.has(id)) {
        handle.dispose();
        cards.delete(id);
      }
    }
  };

  recentEntitiesStore.subscribe(render);
  return pane;
}

function buildChatDock(chatPanel: ChatPanel, agent: WebSocketRemoteAgent): HTMLElement {
  const wrap = document.createElement("section");
  wrap.style.cssText = `
    min-width: 0; min-height: 0;
    display: flex; flex-direction: column;
    background: var(--background);
  `;
  wrap.appendChild(chatPanel as unknown as HTMLElement);

  // Composer buttons — mounted inside pi-web-ui's message-editor button row,
  // alongside the paperclip. The composer is `max-w-3xl mx-auto` so anchoring
  // by viewport coordinates (the previous `position: absolute; right: 18px`)
  // drifted into empty space on wide screens. Living inside the button row
  // keeps these visually attached to the input regardless of viewport width.
  //
  // New-conversation + Settings are here (in addition to the AppMenu drawer)
  // specifically so the bare `/chat` view used by the HA ingress iframe —
  // which has no topbar and no drawer — still has entry points for both.
  const newChat = buildComposerIconButton({
    title: "New conversation",
    svg: NEW_CHAT_SVG,
    onClick: () => agent.reset(),
  });
  const settings = buildComposerIconButton({
    title: "Castle settings",
    svg: SETTINGS_GEAR_SVG,
    onClick: () => openSettingsDialog(agent),
  });
  mountComposerButtons(chatPanel as unknown as HTMLElement, [newChat, buildVoiceButton(), settings]);

  return wrap;
}

/**
 * Inject Castle's own buttons into the chat composer's left button group, in
 * the given order at the front (before pi-web-ui's paperclip). Pi-web-ui
 * re-renders the editor on every keystroke and structural property change,
 * which clears any children we add — so a MutationObserver re-mounts them
 * whenever Lit replaces the group's contents. Mount is idempotent and O(n)
 * in the number of buttons.
 */
function mountComposerButtons(chatPanel: HTMLElement, buttons: HTMLButtonElement[]): void {
  const tryMount = (): void => {
    const editor = chatPanel.querySelector("message-editor");
    if (!editor) return;
    const row = editor.querySelector(".justify-between");
    if (!row) return;
    const leftGroup = row.firstElementChild;
    if (!leftGroup) return;
    // Insert in reverse so the final DOM order matches `buttons[]`.
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      if (leftGroup.children[i] === btn) continue;
      leftGroup.insertBefore(btn, leftGroup.firstChild);
    }
  };
  const obs = new MutationObserver(tryMount);
  obs.observe(chatPanel, { childList: true, subtree: true });
  tryMount();
}

const NEW_CHAT_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
  </svg>
`;

const SETTINGS_GEAR_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
`;

/** Composer icon button — visually matches VoiceButton's ghost-icon style. */
function buildComposerIconButton(opts: { title: string; svg: string; onClick: () => void }): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("aria-label", opts.title);
  btn.title = opts.title;
  btn.innerHTML = opts.svg;
  btn.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 8px;
    background: transparent; color: var(--muted-foreground);
    border: none; cursor: pointer;
    flex-shrink: 0;
  `;
  btn.addEventListener("click", (e) => { e.preventDefault(); opts.onClick(); });
  // Subtle hover affordance — matches pi-web-ui's ghost button.
  btn.addEventListener("pointerenter", () => { btn.style.background = "var(--accent, rgba(0,0,0,0.05))"; });
  btn.addEventListener("pointerleave", () => { btn.style.background = "transparent"; });
  return btn;
}

