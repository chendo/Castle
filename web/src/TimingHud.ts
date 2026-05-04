// UI surface for TurnTimings. Two pieces:
//   1) A live "elapsed" pill rendered above the chat input while a turn runs,
//      so the user can see how long they've been waiting in real time.
//   2) Per-message timing chips appended next to pi-web-ui's tokens line on
//      every completed assistant message.
//
// Performance shape: pi-web-ui re-renders the assistant-message DOM on every
// streaming token, so a naive MutationObserver would fire hundreds of times
// per second mid-stream. We rAF-batch the observer (at most one decorate per
// frame) and skip any message that doesn't yet have `usage` set — that's the
// signal pi-web-ui itself uses to render the tokens line, so we save the work
// until there's something to attach to.

import { turnTimings, formatMs, type PerMessageTiming, type TurnTiming } from "./TurnTimings";

const CHIP_MARKER = "data-castle-timing-chip";
const TOKENS_MATCH = /[↑↓RW]/; // formatUsage emits these arrows; cheap heuristic.

function chipStyle(): string {
  return `
    display: inline-block;
    margin-left: 8px;
    padding: 0 6px;
    font-size: inherit;
    color: inherit;
    border: 1px solid var(--border);
    border-radius: 4px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  `;
}

function describeMessageChip(t: PerMessageTiming): string {
  const parts: string[] = [];
  if (t.thinkingMs > 0) parts.push(`thought ${formatMs(t.thinkingMs)}`);
  if (t.firstActivityAt !== undefined && t.endedAt !== undefined) {
    parts.push(`msg ${formatMs(t.endedAt - t.firstActivityAt)}`);
  }
  return parts.join(" · ");
}

function describeTurnSuffix(t: TurnTiming): string {
  const parts: string[] = [];
  if (t.firstActivityAt !== undefined) {
    parts.push(`TTFT ${formatMs(t.firstActivityAt - t.submitAt)}`);
  }
  if (t.endedAt !== undefined) {
    parts.push(`total ${formatMs(t.endedAt - t.submitAt)}`);
  }
  return parts.join(" · ");
}

function decorateMessages(root: HTMLElement): void {
  const msgs = root.querySelectorAll("assistant-message");
  if (msgs.length === 0) return;
  const lastTurn = turnTimings.getLastCompleted();
  msgs.forEach((el, idx) => {
    // Skip until pi-web-ui has rendered the tokens line — `usage` is undefined
    // mid-stream, so there's nothing to attach to and re-trying on every
    // streaming mutation just burns CPU.
    // deno-lint-ignore no-explicit-any
    const msg = (el as any).message;
    if (!msg?.usage) return;
    const ts = msg?.timestamp;
    if (typeof ts !== "number") return;
    const pm = turnTimings.getMessageTiming(ts);
    let tokensDiv: HTMLElement | null = null;
    el.querySelectorAll<HTMLElement>("div.text-muted-foreground").forEach((c) => {
      if (TOKENS_MATCH.test(c.textContent ?? "")) tokensDiv = c;
    });
    if (!tokensDiv) return;
    const target = tokensDiv as unknown as HTMLElement;
    let chip = target.querySelector<HTMLElement>(`span[${CHIP_MARKER}]`);
    if (!chip) {
      chip = document.createElement("span");
      chip.setAttribute(CHIP_MARKER, "1");
      chip.setAttribute("style", chipStyle());
      target.appendChild(chip);
    }
    const parts: string[] = [];
    if (pm) {
      const m = describeMessageChip(pm);
      if (m) parts.push(m);
    }
    // Last assistant message of the latest completed turn carries the headline.
    if (idx === msgs.length - 1 && lastTurn?.endedAt !== undefined) {
      const tsum = describeTurnSuffix(lastTurn);
      if (tsum) parts.push(tsum);
    }
    const next = parts.join(" · ");
    // Only mutate if the value would actually change — avoids needless
    // characterData mutations the observer would see (childList: subtree
    // doesn't catch text changes, but Lit might still notice).
    if (chip.textContent !== next) chip.textContent = next;
    const nextDisplay = parts.length ? "inline-block" : "none";
    if (chip.style.display !== nextDisplay) chip.style.display = nextDisplay;
  });
}

/**
 * "Processing…" indicator that fills the dead air after a tool call returns
 * but before the model has started emitting tokens again. Disappears the
 * moment any text/thinking delta arrives. Animated dots so it doesn't look
 * frozen during long gaps. Same affordance pi-web-ui already has for
 * "Thinking…" but covers the gap that one doesn't.
 */
function buildProcessingIndicator(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card, var(--background));
    color: var(--muted-foreground);
    font: 12px ui-sans-serif, system-ui, sans-serif;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms;
  `;
  // Dots animate so the user can tell the page isn't frozen.
  if (!document.getElementById("castle-dots-style")) {
    const style = document.createElement("style");
    style.id = "castle-dots-style";
    style.textContent = `
      @keyframes castle-dots {
        0%, 20%   { content: "."; }
        40%       { content: ".."; }
        60%, 100% { content: "..."; }
      }
      .castle-processing-dots::after {
        content: ".";
        display: inline-block;
        animation: castle-dots 1.4s infinite steps(1);
        width: 1ch;
        text-align: left;
      }
    `;
    document.head.appendChild(style);
  }
  el.innerHTML = `Processing<span class="castle-processing-dots"></span>`;

  const update = () => {
    const next = turnTimings.isProcessing() ? "1" : "0";
    if (el.style.opacity !== next) el.style.opacity = next;
  };
  turnTimings.subscribe(update);
  update();
  return el;
}

/**
 * Live elapsed-time pill, mounted once into the chat area. Re-renders on a
 * 250ms interval while a turn is in flight; hides itself once agent_end lands.
 */
function buildLiveTicker(): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    position: absolute;
    top: 8px;
    right: 12px;
    z-index: 5;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card, var(--background));
    color: var(--muted-foreground);
    font: 12px ui-sans-serif, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms;
  `;

  let timer: number | undefined;

  const render = () => {
    const cur = turnTimings.getCurrent();
    if (!cur) {
      if (el.style.opacity !== "0") el.style.opacity = "0";
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return;
    }
    if (el.style.opacity !== "1") el.style.opacity = "1";
    const elapsed = performance.now() - cur.submitAt;
    const text = cur.firstActivityAt === undefined
      ? `waiting · ${formatMs(elapsed)}`
      : `TTFT ${formatMs(cur.firstActivityAt - cur.submitAt)} · elapsed ${formatMs(elapsed)}`;
    if (el.textContent !== text) el.textContent = text;
  };

  turnTimings.subscribe(() => {
    const cur = turnTimings.getCurrent();
    if (cur && timer === undefined) {
      timer = setInterval(render, 250) as unknown as number;
    }
    render();
  });

  return el;
}

/**
 * Attach both pieces to the chat area. `chatWrap` should be the positioned
 * parent that contains the ChatPanel — the ticker is positioned absolutely
 * inside it.
 */
export function mountTimingHud(chatWrap: HTMLElement, chatPanel: HTMLElement): void {
  if (!chatWrap.style.position) chatWrap.style.position = "relative";

  chatWrap.appendChild(buildLiveTicker());
  chatWrap.appendChild(buildProcessingIndicator());

  // Coalesce the mutation storm during streaming into one decorate per frame.
  // pi-web-ui re-renders the message DOM on every text-delta; without this
  // batch, the browser was locking up.
  let rafId: number | null = null;
  const scheduleDecorate = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      decorateMessages(chatPanel);
    });
  };

  // Initial pass + watch for new messages / re-renders. childList+subtree
  // catches new <assistant-message> nodes and pi-web-ui's swap-in of the
  // tokens div once a message ends. We deliberately skip characterData —
  // streaming text-deltas would fire it on every chunk.
  scheduleDecorate();
  const obs = new MutationObserver(scheduleDecorate);
  obs.observe(chatPanel, { childList: true, subtree: true });

  // Final-pass on agent_end: by this point pi-web-ui has rendered the tokens
  // line for the last assistant message, and the turn-level summary needs to
  // land on it. The MutationObserver usually catches this too, but the rAF
  // above might lose a frame to a heavy re-render and miss the very last one.
  turnTimings.subscribe(() => {
    if (!turnTimings.getCurrent() && turnTimings.getLastCompleted()) {
      scheduleDecorate();
    }
  });
}
