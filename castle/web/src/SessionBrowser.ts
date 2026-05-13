import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

/** Format a date as "May 4, 2026 14:32" */
function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Derive a human-readable title from the JSONL path. */
function sessionTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  // Strip .jsonl extension and the leading timestamp-slug prefix.
  const slug = base.replace(/\.jsonl$/, "").split("-").slice(1).join("-");
  return slug || base;
}

/** Format bytes to a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Session browser — a slide-out panel on the right side listing saved sessions.
 * Clicking a row resumes that session; a delete button removes it.
 */
export function openSessionBrowser(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("castle-sessions-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "castle-sessions-overlay";
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 200;
    display: flex; align-items: stretch; justify-content: flex-end;
    font-family: ui-sans-serif, system-ui, sans-serif;
  `;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const panel = document.createElement("div");
  panel.style.cssText = `
    background: var(--card); color: var(--foreground);
    border-left: 1px solid var(--border);
    width: 100%; max-width: 480px; height: 100%;
    display: flex; flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.2);
  `;

  panel.innerHTML = `
    <div style="padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 16px; font-weight: 600;">Session history</div>
      <button id="castle-sessions-close" title="Close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    </div>
    <div id="castle-sessions-list" style="padding: 12px 20px; overflow-y: auto; flex: 1;">
      <div style="font-size: 13px; color: var(--muted-foreground); text-align: center; padding: 40px 0;">Loading…</div>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const listEl = panel.querySelector("#castle-sessions-list") as HTMLElement;

  const renderSessions = (sessions: Array<{ path: string; size: number; modified: Date }>) => {
    if (sessions.length === 0) {
      listEl.innerHTML = `<div style="font-size: 13px; color: var(--muted-foreground); text-align: center; padding: 40px 0;">No saved sessions yet.</div>`;
      return;
    }
    listEl.innerHTML = "";
    for (const s of sessions) {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px;
        cursor: pointer; transition: background 0.15s;
      `;
      row.onmouseenter = () => { row.style.background = "var(--muted-background, rgba(128,128,128,0.08))"; };
      row.onmouseleave = () => { row.style.background = ""; };

      const info = document.createElement("div");
      info.style.cssText = "flex: 1; min-width: 0;";

      const title = document.createElement("div");
      title.style.cssText = "font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
      title.textContent = sessionTitle(s.path);

      const meta = document.createElement("div");
      meta.style.cssText = "font-size: 11px; color: var(--muted-foreground); margin-top: 2px;";
      meta.textContent = `${formatDate(new Date(s.modified))} · ${formatBytes(s.size)}`;

      info.append(title, meta);

      const resumeBtn = document.createElement("button");
      resumeBtn.style.cssText = `
        padding: 4px 10px; font-size: 12px; cursor: pointer;
        background: var(--primary, #58a6ff); color: white;
        border: none; border-radius: 6px; flex-shrink: 0;
      `;
      resumeBtn.textContent = "Resume";
      resumeBtn.onclick = (e) => {
        e.stopPropagation();
        agent.resumeSession(s.path);
        close();
      };

      const delBtn = document.createElement("button");
      delBtn.style.cssText = `
        padding: 4px 10px; font-size: 12px; cursor: pointer;
        background: transparent; color: var(--destructive, #ef4444);
        border: 1px solid var(--destructive, #ef4444); border-radius: 6px; flex-shrink: 0;
      `;
      delBtn.textContent = "Delete";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`Delete session "${sessionTitle(s.path)}"?`)) return;
        agent.sendRaw({ type: "delete_session", path: s.path });
      };

      row.append(info, resumeBtn, delBtn);

      row.onclick = () => {
        agent.resumeSession(s.path);
        close();
      };

      listEl.appendChild(row);
    }
  };

  // Fetch sessions on open.
  agent.listSessions();

  // Listen for the session list response.
  const prevHandler = agent.onSessionsList;
  agent.onSessionsList = (sessions) => {
    renderSessions(sessions);
  };

  // Refresh the list when a session is deleted.
  const prevDeleteHandler = agent.onDeleteSession;
  agent.onDeleteSession = () => {
    agent.listSessions();
  };

  panel.querySelector("#castle-sessions-close")!.addEventListener("click", close);

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    agent.onSessionsList = prevHandler;
  }
}
