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

// Per-message marker on the <assistant-message> element. Set after a successful
// chip injection so subsequent decorate passes can short-circuit messages whose
// chip is still attached and whose displayed value still matches the latest
// timing data. Without this, every rAF tick during streaming re-walks every
// assistant message in the chat — O(N) per frame as history grows.
const DECORATED_MARKER = "data-castle-chip-state";

function decorateMessages(root: HTMLElement): void {
  const msgs = root.querySelectorAll("assistant-message");
  if (msgs.length === 0) return;
  const lastTurn = turnTimings.getLastCompleted();
  // Encode the relevant turn-headline state so we know to invalidate the
  // last message's chip when a new turn lands and the headline shifts.
  const turnSig = lastTurn?.endedAt !== undefined ? `${lastTurn.submitAt}|${lastTurn.endedAt}` : "";

  msgs.forEach((el, idx) => {
    const isLast = idx === msgs.length - 1;
    // deno-lint-ignore no-explicit-any
    const msg = (el as any).message;
    if (!msg?.usage) return; // pi-web-ui hasn't rendered the tokens line yet
    const ts = msg?.timestamp;
    if (typeof ts !== "number") return;

    const pm = turnTimings.getMessageTiming(ts);
    const headline = isLast ? turnSig : "";
    // Stamp combines the per-message timing fingerprint and the turn headline
    // (only relevant on the last message). If the stamp matches what we wrote
    // last time AND the chip is still in the DOM, nothing has changed — skip.
    const sig = `${pm?.thinkingMs ?? 0}|${pm?.firstActivityAt ?? 0}|${pm?.endedAt ?? 0}|${headline}`;
    const target = el as HTMLElement;
    if (target.getAttribute(DECORATED_MARKER) === sig && target.querySelector(`span[${CHIP_MARKER}]`)) {
      return;
    }

    let tokensDiv: HTMLElement | null = null;
    el.querySelectorAll<HTMLElement>("div.text-muted-foreground").forEach((c) => {
      if (TOKENS_MATCH.test(c.textContent ?? "")) tokensDiv = c;
    });
    if (!tokensDiv) return;
    const tokensTarget = tokensDiv as unknown as HTMLElement;
    let chip = tokensTarget.querySelector<HTMLElement>(`span[${CHIP_MARKER}]`);
    if (!chip) {
      chip = document.createElement("span");
      chip.setAttribute(CHIP_MARKER, "1");
      chip.setAttribute("style", chipStyle());
      tokensTarget.appendChild(chip);
    }
    const parts: string[] = [];
    if (pm) {
      const m = describeMessageChip(pm);
      if (m) parts.push(m);
    }
    if (isLast && lastTurn?.endedAt !== undefined) {
      const tsum = describeTurnSuffix(lastTurn);
      if (tsum) parts.push(tsum);
    }
    const next = parts.join(" · ");
    if (chip.textContent !== next) chip.textContent = next;
    const nextDisplay = parts.length ? "inline-block" : "none";
    if (chip.style.display !== nextDisplay) chip.style.display = nextDisplay;
    target.setAttribute(DECORATED_MARKER, sig);
  });
}

/**
 * "Processing…" indicator that fills the dead air after a tool call returns
 * but before the model has started emitting tokens again. Disappears the
 * moment any text/thinking delta arrives. Animated dots so it doesn't look
 * frozen during long gaps. Same affordance pi-web-ui already has for
 * "Thinking…" but covers the gap that one doesn't.
 *
 * Placed inline inside the chat flow — sits right after the last message and
 * before <streaming-message-container> — so it reads as "the assistant is
 * working on a reply" rather than as a global page status.
 */
function buildProcessingIndicator(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-castle-processing", "");
  el.style.cssText = `
    align-self: flex-start;
    margin: 0 16px;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card, var(--background));
    color: var(--muted-foreground);
    font: 12px ui-sans-serif, system-ui, sans-serif;
    pointer-events: none;
    display: none;
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
    el.style.display = turnTimings.isProcessing() ? "inline-block" : "none";
  };
  turnTimings.subscribe(update);
  update();
  return el;
}

/**
 * Keep the processing indicator anchored just before pi-web-ui's
 * <streaming-message-container>, so it sits in the chat flow right below the
 * last user message. pi-web-ui never moves the streaming container once
 * AgentInterface has rendered, so re-attaching is cheap and only fires when
 * lit creates a new instance (e.g. fresh session). */
function reattachProcessingIndicator(chatPanel: HTMLElement, indicator: HTMLElement): void {
  const target = chatPanel.querySelector("streaming-message-container");
  if (!target?.parentElement) return;
  if (indicator.nextSibling === target) return; // already in the right slot
  target.parentElement.insertBefore(indicator, target);
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
  const processingIndicator = buildProcessingIndicator();

  // Coalesce the mutation storm during streaming into one decorate per frame.
  // pi-web-ui re-renders the message DOM on every text-delta; without this
  // batch, the browser was locking up.
  let rafId: number | null = null;
  const scheduleDecorate = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      decorateMessages(chatPanel);
      reattachProcessingIndicator(chatPanel, processingIndicator);
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
