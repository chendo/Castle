// Queue UI: a strip above the chat composer that shows queued / running
// requests (so work in flight is visible and cancellable), plus a topbar pill
// that surfaces "something's running" while the user is on the Now / Dashboard
// tabs. Both are fed by WebSocketRemoteAgent.subscribeQueue — the server owns
// the queue and broadcasts it, so these survive a page close / reconnect.

import type { QueuedRequestWire, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

/** Requests that are still active (not finished). The strip and the pill both
 *  key off these — finished requests stay in the server log for history but
 *  don't need surfacing here. */
function active(requests: QueuedRequestWire[]): QueuedRequestWire[] {
  return requests.filter((r) => r.status === "queued" || r.status === "running");
}

function preview(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Build the queue strip mounted directly above the chat composer. Hidden whenever
 * nothing is queued or running. Shows the running turn with a Stop button, any
 * queued follow-ups with per-item cancel, and a small input to queue another
 * message while the agent is busy (the normal composer is disabled mid-stream).
 */
export function buildQueueStrip(agent: WebSocketRemoteAgent): HTMLElement {
  const strip = document.createElement("div");
  strip.style.cssText = `
    display: none; flex-direction: column; gap: 6px;
    padding: 8px 12px; margin-bottom: 6px;
    border: 1px solid var(--border); border-radius: 12px;
    background: var(--card, var(--background));
    font-size: 13px;
  `;

  const list = document.createElement("div");
  list.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
  strip.appendChild(list);

  // Follow-up composer — lets the user queue a message while a turn is running.
  const form = document.createElement("form");
  form.style.cssText = "display: flex; gap: 6px; align-items: center;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Queue a follow-up…";
  input.style.cssText = `
    flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--background);
    color: var(--foreground); font-size: 13px;
  `;
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Queue";
  send.style.cssText = `
    flex-shrink: 0; padding: 6px 12px; border-radius: 8px; border: none;
    background: var(--primary, #58a6ff); color: var(--primary-foreground, #fff);
    font-size: 13px; cursor: pointer;
  `;
  form.append(input, send);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    agent.enqueuePrompt(text);
    input.value = "";
  });
  strip.appendChild(form);

  const render = (requests: QueuedRequestWire[]): void => {
    const act = active(requests);
    if (act.length === 0) {
      strip.style.display = "none";
      list.innerHTML = "";
      return;
    }
    strip.style.display = "flex";
    list.innerHTML = "";
    for (const req of act) {
      list.appendChild(buildRow(req, agent));
    }
  };

  agent.subscribeQueue(render);
  return strip;
}

function buildRow(req: QueuedRequestWire, agent: WebSocketRemoteAgent): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display: flex; align-items: center; gap: 8px; min-width: 0;";

  const dot = document.createElement("span");
  const isRunning = req.status === "running";
  dot.textContent = isRunning ? "●" : "◦";
  dot.style.cssText = `color: ${isRunning ? "var(--primary, #58a6ff)" : "var(--muted-foreground)"}; flex-shrink: 0;`;
  if (isRunning) {
    dot.animate(
      [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }],
      { duration: 1400, iterations: Infinity },
    );
  }

  const label = document.createElement("span");
  label.textContent = preview(req.text);
  label.title = req.text;
  label.style.cssText = `
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--foreground);
  `;

  const status = document.createElement("span");
  status.textContent = isRunning ? "working…" : "queued";
  status.style.cssText = "flex-shrink: 0; color: var(--muted-foreground); font-size: 11px;";

  const cancel = document.createElement("button");
  cancel.textContent = "✕";
  cancel.title = isRunning ? "Stop" : "Remove from queue";
  cancel.setAttribute("aria-label", cancel.title);
  cancel.style.cssText = `
    flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px; border: none;
    background: transparent; color: var(--muted-foreground); cursor: pointer;
    line-height: 1;
  `;
  cancel.addEventListener("pointerenter", () => { cancel.style.background = "var(--accent, rgba(0,0,0,0.05))"; });
  cancel.addEventListener("pointerleave", () => { cancel.style.background = "transparent"; });
  cancel.addEventListener("click", () => agent.cancelRequest(req.id));

  row.append(dot, label, status, cancel);
  return row;
}

/**
 * Build the topbar pill that shows active request count on the Now / Dashboard
 * tabs (where the chat panel isn't in view). Hidden when idle. Clicking it
 * invokes `onActivate` so the shell can bring the chat into focus.
 */
export function buildQueueIndicator(
  agent: WebSocketRemoteAgent,
  onActivate: () => void,
): HTMLElement {
  const pill = document.createElement("button");
  pill.style.cssText = `
    display: none; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--card, var(--background)); color: var(--foreground);
    font-size: 12px; cursor: pointer; line-height: 1;
  `;
  pill.addEventListener("click", onActivate);

  const dot = document.createElement("span");
  dot.textContent = "●";
  dot.style.cssText = "color: var(--primary, #58a6ff);";
  dot.animate(
    [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }],
    { duration: 1400, iterations: Infinity },
  );

  const text = document.createElement("span");
  pill.append(dot, text);

  agent.subscribeQueue((requests) => {
    const act = active(requests);
    if (act.length === 0) {
      pill.style.display = "none";
      return;
    }
    const running = act.filter((r) => r.status === "running").length;
    const queued = act.length - running;
    pill.style.display = "inline-flex";
    text.textContent = queued > 0
      ? `${running} running · ${queued} queued`
      : `${running} running`;
    pill.title = "Agent is working — click to view chat";
  });

  return pill;
}
