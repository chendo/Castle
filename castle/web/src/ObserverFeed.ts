// A band above the chat transcript showing what the observer has flagged and
// you haven't looked at yet.
//
// Deliberately a sibling of the transcript rather than messages inside it. The
// two ways to interleave are both bad: a real message in agent.state.messages
// pollutes the chat LLM's context on every later turn and lands in the session
// JSONL that SessionManager owns; a client-injected fake desyncs on every
// `snapshot` frame, because the server ships state.messages wholesale and
// applySnapshot replaces the client's list — so injected rows would vanish on
// every settings change, model swap, reset, resume and reconnect.
//
// This band has neither problem, needs no MutationObserver, and can be deleted
// in one line if it turns out to be noise.

import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { observerStore } from "./ObserverStore";

const COLLAPSED_KEY = "castle.observerFeedCollapsed";
/** Beyond a couple of rows this stops being a glance and starts being a list;
 *  the Observer tab is where a list belongs. */
const MAX_ROWS = 3;

export function buildObserverFeed(agent: WebSocketRemoteAgent): HTMLElement {
  const strip = document.createElement("div");
  strip.style.cssText = `
    display: none; flex-direction: column; gap: 4px;
    padding: 8px 12px; flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--card, var(--background));
    font-size: 13px;
  `;

  const head = document.createElement("div");
  head.style.cssText = "display: flex; align-items: center; gap: 8px; cursor: pointer;";
  const caret = document.createElement("span");
  const title = document.createElement("span");
  title.style.cssText = "font-weight: 600;";
  const spacer = document.createElement("span");
  spacer.style.cssText = "margin-left: auto;";
  const viewAll = document.createElement("a");
  viewAll.textContent = "View all →";
  viewAll.href = "/observer";
  viewAll.style.cssText = "font-size: 12px; color: inherit; opacity: 0.7;";
  viewAll.addEventListener("click", (e) => {
    e.preventDefault();
    history.pushState({}, "", "/observer");
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
  });
  head.append(caret, title, spacer, viewAll);
  strip.appendChild(head);

  const list = document.createElement("div");
  list.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
  strip.appendChild(list);

  let collapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
  head.addEventListener("click", (e) => {
    if (e.target === viewAll) return;
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    render();
  });

  function render(): void {
    const open = observerStore.open();
    strip.style.display = open.length === 0 ? "none" : "flex";
    if (open.length === 0) return;
    caret.textContent = collapsed ? "▸" : "▾";
    title.textContent = `Observer flagged ${open.length}`;
    list.style.display = collapsed ? "none" : "flex";
    list.replaceChildren();
    for (const o of open.slice(0, MAX_ROWS)) {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; align-items: center; gap: 8px;";
      const label = document.createElement("span");
      label.style.cssText = "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
      label.textContent = o.body.type === "concern"
        ? o.body.summary
        : `would ${o.body.args.domain}.${o.body.args.service} ${o.body.args.entity_id ?? ""}`.trim();
      const dismiss = document.createElement("button");
      dismiss.textContent = "✕";
      dismiss.title = "Dismiss";
      dismiss.style.cssText = "background: none; border: none; cursor: pointer; color: inherit; opacity: 0.6;";
      dismiss.addEventListener("click", () => agent.setObservationStatus(o.id, "dismissed"));
      row.append(label, dismiss);
      list.appendChild(row);
    }
    if (open.length > MAX_ROWS) {
      const more = document.createElement("div");
      more.style.cssText = "font-size: 12px; opacity: 0.7;";
      more.textContent = `and ${open.length - MAX_ROWS} more`;
      list.appendChild(more);
    }
  }

  // The strip lives for the lifetime of the chat dock, which is the lifetime
  // of the page, so this subscription intentionally has no teardown path.
  observerStore.subscribe(render);
  return strip;
}
