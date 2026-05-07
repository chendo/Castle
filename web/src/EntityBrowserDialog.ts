// Entity browser as a slide-out panel. Opened from the AppMenu and from a
// "Browse entities" button in the Settings dialog. The actual tree comes
// from the existing Sidebar component — this file is just a host that
// presents it as a modal.
//
// The Sidebar instance is built fresh per open and torn down on close. It
// owns its own subscriptions to entityCache, so disposal happens via DOM
// removal + the cache's per-listener WeakRef path. Building it fresh
// (instead of caching one global instance) keeps the bookkeeping simple
// and avoids stale state between opens.

import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { buildSidebar } from "./Sidebar";

export function openEntityBrowserDialog(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("castle-entities-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "castle-entities-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200;
    display: flex; align-items: stretch; justify-content: flex-start;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: var(--card); color: var(--foreground);
    border-right: 1px solid var(--border);
    width: 100%; max-width: 360px; height: 100%;
    display: flex; flex-direction: column;
    box-shadow: 4px 0 24px rgba(0,0,0,0.2);
  `;

  const header = document.createElement("div");
  header.style.cssText = "padding: 16px 18px 12px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;";
  const title = document.createElement("div");
  title.textContent = "Browse entities";
  title.style.cssText = "font-size: 16px; font-weight: 600;";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.style.cssText = "background: transparent; border: none; color: var(--muted-foreground); font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1;";
  closeBtn.onclick = close;
  header.append(title, closeBtn);
  panel.appendChild(header);

  const sidebar = buildSidebar(agent);
  // Strip the Sidebar's collapsed-state styling so it always renders open
  // inside this dialog, and remove its own border (we already have one).
  sidebar.root.style.height = "100%";
  sidebar.root.style.flex = "1";
  sidebar.root.style.borderRight = "none";
  sidebar.root.style.minWidth = "0";
  sidebar.root.dataset.collapsed = "0";
  panel.appendChild(sidebar.root);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
}
