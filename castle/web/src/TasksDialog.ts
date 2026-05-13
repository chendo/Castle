import type { TaskWire, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { tasksStore } from "./TasksStore";

/**
 * Slide-out panel listing scheduled tasks. Read-only browser of state +
 * cancel / delete actions. Result cards (post-fire) live here too — for v1
 * the notification summary is rendered inline on the task row rather than
 * being injected into the chat.
 */
export function openTasksDialog(agent: WebSocketRemoteAgent): void {
  if (document.getElementById("castle-tasks-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "castle-tasks-overlay";
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
    width: 100%; max-width: 520px; height: 100%;
    display: flex; flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.2);
  `;

  panel.innerHTML = `
    <div style="padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
      <div style="font-size: 16px; font-weight: 600;">Scheduled tasks</div>
      <button id="castle-tasks-close" title="Close" style="background:transparent;border:none;color:var(--muted-foreground);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    </div>
    <div id="castle-tasks-list" style="padding: 12px 20px; overflow-y: auto; flex: 1;"></div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const listEl = panel.querySelector("#castle-tasks-list") as HTMLElement;

  const unsubscribe = tasksStore.subscribe((tasks) => render(tasks));

  function render(tasks: TaskWire[]): void {
    if (tasks.length === 0) {
      listEl.innerHTML = `<div style="font-size: 13px; color: var(--muted-foreground); text-align: center; padding: 40px 0;">No scheduled tasks. Ask the agent to set one up — e.g. "remind me at 5pm" or "watch the front door for delivery".</div>`;
      return;
    }
    listEl.innerHTML = "";
    for (const t of tasks) listEl.appendChild(buildRow(t));
  }

  function buildRow(t: TaskWire): HTMLElement {
    const row = document.createElement("div");
    row.style.cssText = `
      border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px;
      padding: 12px;
    `;

    const head = document.createElement("div");
    head.style.cssText = "display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;";

    const left = document.createElement("div");
    left.style.cssText = "flex: 1; min-width: 0;";

    const brief = document.createElement("div");
    brief.style.cssText = "font-size: 13px; font-weight: 500; line-height: 1.4;";
    brief.textContent = t.brief;
    left.appendChild(brief);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size: 11px; color: var(--muted-foreground); margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap;";
    meta.appendChild(statusBadge(t.status));
    meta.appendChild(textChip(triggerLabel(t)));
    if (t.context.cameraFrames) meta.appendChild(textChip(`📷 ${t.context.cameraFrames.entity}`));
    meta.appendChild(textChip(`fires: ${t.cost.fires}`));
    if (t.cost.framesAnalyzed > 0) meta.appendChild(textChip(`frames: ${t.cost.framesAnalyzed}`));
    meta.appendChild(textChip(`age: ${fmtAgo(Date.now() - t.createdAt)}`));
    left.appendChild(meta);

    head.appendChild(left);

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; gap: 6px; flex-shrink: 0;";
    if (t.status === "watching") {
      const cancel = button("Cancel", "transparent", "var(--foreground)");
      cancel.onclick = () => agent.sendRaw({ type: "cancel_task", id: t.id });
      actions.appendChild(cancel);
    } else {
      const del = button("Delete", "transparent", "var(--destructive, #ef4444)");
      del.style.borderColor = "var(--destructive, #ef4444)";
      del.onclick = () => {
        if (!confirm(`Delete task "${t.brief.slice(0, 60)}"?`)) return;
        agent.sendRaw({ type: "delete_task", id: t.id });
      };
      actions.appendChild(del);
    }
    head.appendChild(actions);
    row.appendChild(head);

    if (t.notification) {
      const notif = document.createElement("div");
      notif.style.cssText = `
        margin-top: 10px; padding: 10px; border-radius: 6px;
        background: var(--muted-background, rgba(16, 185, 129, 0.08));
        border: 1px solid rgba(16, 185, 129, 0.4);
        font-size: 13px; line-height: 1.4;
      `;
      const line = document.createElement("div");
      line.innerHTML = `<strong>🔔 Notification</strong> · ${fmtTime(t.notification.ts)}${
        t.notification.confidence !== undefined
          ? ` · confidence ${(t.notification.confidence * 100).toFixed(0)}%`
          : ""
      }`;
      line.style.cssText = "color: var(--muted-foreground); font-size: 11px; margin-bottom: 4px;";
      const summary = document.createElement("div");
      summary.textContent = t.notification.summary;
      notif.append(line, summary);
      row.appendChild(notif);
    }

    if (t.lastObservation && t.status === "watching") {
      const obs = document.createElement("div");
      obs.style.cssText = `
        margin-top: 8px; font-size: 12px; color: var(--muted-foreground);
        line-height: 1.4;
      `;
      obs.innerHTML = `<span style="opacity: 0.7;">Last check ${fmtAgo(Date.now() - t.lastObservation.ts)} (${t.lastObservation.triggerKind}):</span> ${escapeHtml(t.lastObservation.narrative || "(no narrative)")}`;
      row.appendChild(obs);
    }

    return row;
  }

  function statusBadge(status: TaskWire["status"]): HTMLElement {
    const colors: Record<TaskWire["status"], string> = {
      watching: "#10b981",
      fired: "#3b82f6",
      expired: "#f59e0b",
      stopped: "#6b7280",
      errored: "#ef4444",
    };
    const el = document.createElement("span");
    el.textContent = status;
    el.style.cssText = `
      display: inline-flex; align-items: center; gap: 4px;
      padding: 1px 8px; border-radius: 999px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.04em;
      background: ${colors[status]}1f;
      color: ${colors[status]};
      border: 1px solid ${colors[status]}5f;
    `;
    return el;
  }

  function textChip(text: string): HTMLElement {
    const el = document.createElement("span");
    el.textContent = text;
    el.style.cssText = `
      padding: 1px 6px; border-radius: 4px;
      background: var(--muted-background, rgba(128, 128, 128, 0.08));
      font-size: 11px;
    `;
    return el;
  }

  function button(label: string, bg: string, color: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `
      padding: 4px 10px; font-size: 12px; cursor: pointer;
      background: ${bg}; color: ${color};
      border: 1px solid var(--border); border-radius: 6px;
    `;
    return b;
  }

  panel.querySelector("#castle-tasks-close")!.addEventListener("click", close);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    unsubscribe();
  }
}

function triggerLabel(t: TaskWire): string {
  const tr = t.trigger;
  if (tr.kind === "at" && typeof tr.ts === "number") return `at ${fmtTime(tr.ts)}`;
  if (tr.kind === "every" && typeof tr.intervalMs === "number") return `every ${fmtInterval(tr.intervalMs)}`;
  if (tr.kind === "on_state" && typeof tr.entity === "string") return `on ${tr.entity}${tr.to ? ` → ${tr.to}` : ""}`;
  if (tr.kind === "on_event" && typeof tr.eventType === "string") return `event ${tr.eventType}`;
  if (tr.kind === "any_of") return `any of (${(tr.triggers as unknown[] | undefined)?.length ?? 0})`;
  return tr.kind;
}

function fmtInterval(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function fmtAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
