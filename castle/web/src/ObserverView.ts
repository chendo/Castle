// The Observer tab: what the background agent noticed, and what it would have
// done about it.
//
// Every proposal carries a visible "Dry run — not executed" badge. That badge
// is the whole contract of this release: the observer named a real action with
// real arguments and did not take it. If it ever stops being true, this is the
// first thing that must change.

import type {
  ObservationWire,
  ObserverStatusWire,
  WebSocketRemoteAgent,
} from "./WebSocketRemoteAgent";
import { observerStore } from "./ObserverStore";

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--muted-foreground, #888)",
  warn: "#d18616",
  critical: "#d64545",
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", `
    padding: 4px 10px; font-size: 12px; cursor: pointer;
    border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: inherit;
  `, label);
  b.addEventListener("click", onClick);
  return b;
}

function describeProposal(body: Extract<ObservationWire["body"], { type: "proposal" }>): string {
  const args = body.args as { domain?: string; service?: string; entity_id?: string; service_data?: unknown };
  const target = args.entity_id ? ` ${args.entity_id}` : "";
  const data = args.service_data ? ` ${JSON.stringify(args.service_data)}` : "";
  return `${args.domain}.${args.service}${target}${data}`;
}

function buildCard(o: ObservationWire, agent: WebSocketRemoteAgent): HTMLElement {
  const card = el("div", `
    border: 1px solid var(--border); border-radius: 10px;
    padding: 12px; display: flex; flex-direction: column; gap: 8px;
    opacity: ${o.status === "open" ? "1" : "0.6"};
  `);

  const head = el("div", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;");
  if (o.body.type === "concern") {
    const dot = el("span", `
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: ${SEVERITY_COLOR[o.body.severity] ?? SEVERITY_COLOR.info};
    `);
    head.appendChild(dot);
    head.appendChild(el("strong", "font-size: 14px;", o.body.summary));
  } else {
    const badge = el("span", `
      font-size: 11px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
      border: 1px solid var(--border); color: var(--muted-foreground, #888);
    `, "Dry run — not executed");
    head.appendChild(badge);
    head.appendChild(el("strong", "font-size: 14px;", "Would have acted"));
  }
  head.appendChild(el("span", "margin-left: auto; font-size: 12px; color: var(--muted-foreground, #888);", ago(o.lastSeenAt)));
  card.appendChild(head);

  if (o.body.type === "proposal") {
    const code = el("code", `
      display: block; font-family: ui-monospace, monospace; font-size: 12px;
      padding: 8px; border-radius: 6px; overflow-x: auto;
      background: var(--muted, rgba(127,127,127,0.12));
    `, describeProposal(o.body));
    card.appendChild(code);
    card.appendChild(el("div", "font-size: 13px; color: var(--muted-foreground, #888);", o.body.reason));
  } else if (o.body.detail) {
    card.appendChild(el("div", "font-size: 13px; color: var(--muted-foreground, #888);", o.body.detail));
  }

  const meta = el("div", "display: flex; gap: 6px; flex-wrap: wrap; align-items: center;");
  for (const entityId of o.body.entities) {
    meta.appendChild(el("span", `
      font-size: 11px; padding: 2px 6px; border-radius: 4px;
      background: var(--muted, rgba(127,127,127,0.12));
    `, entityId));
  }
  if (o.occurrences > 1) {
    meta.appendChild(el("span", "font-size: 12px; color: var(--muted-foreground, #888);", `seen ${o.occurrences}x`));
  }
  meta.appendChild(el("span", "font-size: 11px; color: var(--muted-foreground, #888);", `${o.pass.kind} pass`));
  card.appendChild(meta);

  const actions = el("div", "display: flex; gap: 6px; flex-wrap: wrap;");
  if (o.status === "open") {
    actions.appendChild(button("Acknowledge", () => agent.setObservationStatus(o.id, "acknowledged")));
    actions.appendChild(button("Dismiss", () => agent.setObservationStatus(o.id, "dismissed")));
  } else {
    actions.appendChild(el("span", "font-size: 12px; color: var(--muted-foreground, #888); align-self: center;", o.status));
    actions.appendChild(button("Reopen", () => agent.setObservationStatus(o.id, "open")));
  }
  // The one deliberate bridge into the chat transcript. User-initiated, so the
  // observation becomes a genuine user message rather than something injected
  // behind their back.
  actions.appendChild(button("Ask about this", () => {
    const what = o.body.type === "concern"
      ? o.body.summary
      : `you suggested ${describeProposal(o.body)} because ${o.body.reason}`;
    agent.enqueuePrompt(
      `The observer flagged: "${what}" (entities: ${o.body.entities.join(", ") || "none"}). ` +
        `Look into it and tell me what's going on.`,
    );
    location.hash = "";
    history.pushState({}, "", "/chat");
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
  }));
  card.appendChild(actions);
  return card;
}

function statusLine(s: ObserverStatusWire | null): string {
  if (!s) return "Observer status unknown.";
  if (!s.enabled) return "Observer is off. Enable it in Settings.";
  const bits = [`${s.passesThisHour} passes this hour`];
  if (s.running) bits.push("running now");
  else if (s.lastPassAt) bits.push(`last ${ago(s.lastPassAt)}`);
  if (s.lastDurationMs) bits.push(`${(s.lastDurationMs / 1000).toFixed(1)}s`);
  return bits.join(" · ");
}

export interface ObserverViewHandle {
  root: HTMLElement;
  dispose(): void;
}

export function buildObserverView(agent: WebSocketRemoteAgent): ObserverViewHandle {
  const root = el("section", "display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow-y: auto;");

  const header = el("div", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;");
  header.appendChild(el("h2", "margin: 0; font-size: 16px; letter-spacing: 0.04em;", "OBSERVER"));
  const status = el("span", "font-size: 12px; color: var(--muted-foreground, #888);");
  header.appendChild(status);
  const controls = el("div", "margin-left: auto; display: flex; gap: 6px;");
  controls.appendChild(button("Run now", () => agent.runObserverPass("reactive")));
  controls.appendChild(button("Reset context", () => {
    if (confirm("Start the observer with a fresh context? Memory and observations are kept.")) {
      agent.resetObserverContext();
    }
  }));
  header.appendChild(controls);
  root.appendChild(header);

  const list = el("div", "display: flex; flex-direction: column; gap: 10px;");
  root.appendChild(list);

  const empty = el("div", "font-size: 13px; color: var(--muted-foreground, #888);",
    "Nothing observed yet. Silence is the expected outcome — the observer only speaks up when something looks wrong.");
  root.appendChild(empty);

  const render = () => {
    status.textContent = statusLine(observerStore.status());
    const all = observerStore.all();
    list.replaceChildren(...all.map((o) => buildCard(o, agent)));
    empty.style.display = all.length === 0 ? "block" : "none";
  };

  const unsubscribe = observerStore.subscribe(render);
  // Relative timestamps go stale while the tab sits open; the interval is
  // cancelled in dispose(), which the shell calls when the route changes.
  const tick = setInterval(render, 30_000);

  return {
    root,
    dispose() {
      unsubscribe();
      clearInterval(tick);
    },
  };
}
