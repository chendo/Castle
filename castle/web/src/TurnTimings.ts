// Tracks wall-clock timings per turn and per assistant message so the UI can
// answer "how long was the user waiting, and where did the time go?".
//
// Keyed off `AssistantMessage.timestamp` because that's the only field that's
// stable across pi-web-ui re-renders (no ID exists on AgentMessage). The
// timestamp is set by the server when message_start fires and stays put.
//
// Three timings the user sees:
//   - submit → first activity (TTFA)  : how long before the model started
//   - submit → agent_end (total turn) : end-to-end wait
//   - cumulative thinking per message : where the slow LLM time went

import type { AgentEvent } from "@mariozechner/pi-agent-core";

export interface PerMessageTiming {
  /** First message_update for this message (text or thinking_start). */
  firstActivityAt?: number;
  /** Cumulative ms spent in thinking_start..thinking_end pairs for this message. */
  thinkingMs: number;
  /** Open thinking interval — set on thinking_start, cleared on thinking_end. */
  openThinkingAt?: number;
  /** message_end timestamp for this message. */
  endedAt?: number;
}

export interface TurnTiming {
  /** Wall time at user submit (RemoteAgent.prompt() entry). */
  submitAt: number;
  /** First sign of model activity in the current turn — text_start, thinking_start, or any message_update. */
  firstActivityAt?: number;
  /** agent_end wall time. Once set, the turn is complete. */
  endedAt?: number;
}

type Listener = () => void;

class TurnTimingsTracker {
  private listeners = new Set<Listener>();
  private current: TurnTiming | null = null;
  /** Last fully-completed turn — kept so the live ticker can clear cleanly. */
  private lastCompleted: TurnTiming | null = null;
  private perMessage = new Map<number, PerMessageTiming>();
  /** Completed turns keyed by the timestamp of the assistant message that
   *  ended the turn. Lets the timing chip stay attached to *that* message
   *  forever, instead of jumping to whichever message is currently last. */
  private turnByEndingMessage = new Map<number, TurnTiming>();
  /** Timestamp of the most recent assistant message in the current turn —
   *  used to bind the turn timing once agent_end lands. */
  private lastMessageTsThisTurn: number | undefined;
  /** Number of in-flight tool_execution_* calls. Drives the "processing" gap detection. */
  private activeTools = 0;
  /** True between a text_start / thinking_start delta and the matching message_end —
   * i.e. the model is actively producing tokens we can show. */
  private streamingContent = false;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch (err) { console.error("[turn-timings] listener:", err); }
    }
  }

  /** Called from RemoteAgent.prompt() the moment the user submits. */
  noteSubmit(): void {
    this.current = { submitAt: performance.now() };
    this.emit();
  }

  getCurrent(): TurnTiming | null { return this.current; }

  getLastCompleted(): TurnTiming | null { return this.lastCompleted; }

  getMessageTiming(timestamp: number): PerMessageTiming | undefined {
    return this.perMessage.get(timestamp);
  }

  /** If `timestamp` is the last assistant message of a completed turn,
   *  return that turn's timing. Lets per-message chips render the TTFT /
   *  total summary on the message it actually applies to. */
  getTurnEndedAt(timestamp: number): TurnTiming | undefined {
    return this.turnByEndingMessage.get(timestamp);
  }

  /**
   * "Processing" = the agent is mid-turn but neither running tools nor
   * streaming tokens to us. That's the gap between sending a tool result back
   * to the LLM and the LLM emitting its next text/thinking delta — the user
   * has nothing to look at otherwise.
   */
  isProcessing(): boolean {
    return this.current !== null && this.activeTools === 0 && !this.streamingContent;
  }

  /** Feed every AgentEvent (and the synthetic events RemoteAgent emits). */
  onEvent(event: AgentEvent): void {
    // Some events are extensions that the AgentEvent union doesn't list (e.g.
    // assistantMessageEvent, auto_retry_*). Cast loosely.
    // deno-lint-ignore no-explicit-any
    const e = event as any;

    if (e.type === "agent_start") {
      // RemoteAgent fires a synthetic agent_start in prompt() right after
      // noteSubmit; if a real one arrives later we don't want to wipe the
      // existing submit timestamp. Only initialize if we somehow missed
      // noteSubmit (e.g. reconnect mid-turn).
      if (!this.current) {
        this.current = { submitAt: performance.now() };
      }
      this.activeTools = 0;
      this.streamingContent = false;
      this.emit();
      return;
    }

    if (e.type === "tool_execution_start") {
      this.activeTools++;
      this.emit();
      return;
    }
    if (e.type === "tool_execution_end") {
      if (this.activeTools > 0) this.activeTools--;
      this.emit();
      return;
    }

    if (e.type === "message_start" && e.message?.role === "assistant") {
      const ts = e.message.timestamp as number;
      if (typeof ts === "number" && !this.perMessage.has(ts)) {
        this.perMessage.set(ts, { thinkingMs: 0 });
      }
      return;
    }

    if (e.type === "message_update" && e.message?.role === "assistant") {
      const ts = e.message.timestamp as number;
      let pm = this.perMessage.get(ts);
      if (!pm) {
        pm = { thinkingMs: 0 };
        this.perMessage.set(ts, pm);
      }
      const sub = e.assistantMessageEvent;
      const now = performance.now();
      if (this.current && this.current.firstActivityAt === undefined) {
        this.current.firstActivityAt = now;
      }
      if (pm.firstActivityAt === undefined) pm.firstActivityAt = now;
      if (sub?.type === "thinking_start" || sub?.type === "text_start") {
        // Token deltas have started — we're no longer "processing in the dark".
        this.streamingContent = true;
      }
      if (sub?.type === "thinking_start") {
        pm.openThinkingAt = now;
      } else if (sub?.type === "thinking_end" && pm.openThinkingAt !== undefined) {
        pm.thinkingMs += now - pm.openThinkingAt;
        pm.openThinkingAt = undefined;
      }
      this.emit();
      return;
    }

    if (e.type === "message_end" && e.message?.role === "assistant") {
      const ts = e.message.timestamp as number;
      const pm = this.perMessage.get(ts);
      if (pm) {
        // Defensive close: if a thinking_end never arrived, snap it shut now.
        if (pm.openThinkingAt !== undefined) {
          pm.thinkingMs += performance.now() - pm.openThinkingAt;
          pm.openThinkingAt = undefined;
        }
        pm.endedAt = performance.now();
      }
      // Track the most recent assistant message; on agent_end we'll bind
      // the turn-summary chip to it.
      if (typeof ts === "number") this.lastMessageTsThisTurn = ts;
      // The current assistant message is done — if tools follow, we'll go
      // back into "processing" until the next message starts streaming.
      this.streamingContent = false;
      this.emit();
      return;
    }

    if (e.type === "agent_end") {
      if (this.current) {
        this.current.endedAt = performance.now();
        this.lastCompleted = this.current;
        if (this.lastMessageTsThisTurn !== undefined) {
          this.turnByEndingMessage.set(this.lastMessageTsThisTurn, this.current);
        }
      }
      this.current = null;
      this.lastMessageTsThisTurn = undefined;
      this.activeTools = 0;
      this.streamingContent = false;
      this.emit();
      return;
    }
  }

  /** Test/debug. */
  reset(): void {
    this.current = null;
    this.lastCompleted = null;
    this.perMessage.clear();
    this.turnByEndingMessage.clear();
    this.lastMessageTsThisTurn = undefined;
    this.activeTools = 0;
    this.streamingContent = false;
    this.emit();
  }
}

export const turnTimings = new TurnTimingsTracker();

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)}s`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}
