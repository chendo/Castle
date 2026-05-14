import type { AgentEvent, AgentMessage, AgentState, AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import { recordEnd, recordStart } from "./ToolDurations";
import { turnTimings } from "./TurnTimings";

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * Adapter that satisfies the public surface of pi-agent-core's `Agent` while
 * delegating prompts to a remote backend over a transport (WebSocket, fixture, etc).
 *
 * Subclasses provide the transport by overriding `sendPromptText` / `sendAbort` and
 * feeding incoming server frames into `applySnapshot` / `ingestEvent`.
 *
 * Reduction logic mirrors `Agent.processEvents` exactly so `state` evolves the
 * same way it would for a local Agent.
 */
export class RemoteAgent {
  private listeners = new Set<Listener>();
  private abortController?: AbortController;
  private resolveActive?: () => void;
  private _systemPrompt = "";
  private _model: Model<any>;
  private _thinkingLevel: AgentState["thinkingLevel"] = "off";
  private _tools: AgentTool<any>[] = [];
  private _messages: AgentMessage[] = [];
  private _isStreaming = false;
  private _streamingMessage: AgentMessage | undefined;
  private _pendingToolCalls: ReadonlySet<string> = new Set();
  private _errorMessage: string | undefined;

  /** Hooks AgentInterface assigns; we ignore them — prompts go over the transport. */
  public streamFn?: any;
  public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  public convertToLlm = (m: AgentMessage[]) => m as any;

  /** Transport hooks. Subclasses override. */
  public sendPromptText: (text: string) => void = () => {
    console.warn("[RemoteAgent] sendPromptText not wired");
  };
  public sendAbort: () => void = () => {};

  constructor(opts: { model: Model<any>; systemPrompt?: string; thinkingLevel?: AgentState["thinkingLevel"] }) {
    this._model = opts.model;
    this._systemPrompt = opts.systemPrompt ?? "";
    this._thinkingLevel = opts.thinkingLevel ?? "off";
  }

  // --- AgentState surface ---------------------------------------------------

  get state(): AgentState {
    const self = this;
    return {
      get systemPrompt() { return self._systemPrompt; },
      set systemPrompt(v: string) { self._systemPrompt = v; },
      get model() { return self._model; },
      set model(v: Model<any>) { self._model = v; },
      get thinkingLevel() { return self._thinkingLevel; },
      set thinkingLevel(v: AgentState["thinkingLevel"]) { self._thinkingLevel = v; },
      get tools() { return self._tools; },
      set tools(v: AgentTool<any>[]) { self._tools = v.slice(); },
      get messages() { return self._messages; },
      set messages(v: AgentMessage[]) { self._messages = v.slice(); },
      get isStreaming() { return self._isStreaming; },
      get streamingMessage() { return self._streamingMessage; },
      get pendingToolCalls() { return self._pendingToolCalls; },
      get errorMessage() { return self._errorMessage; },
    } as AgentState;
  }

  // --- Public Agent-shaped API ---------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Snapshot apply — server-pushed full state for first connect / reconnect. */
  applySnapshot(snapshot: {
    messages?: AgentMessage[];
    isStreaming?: boolean;
    streamingMessage?: AgentMessage;
    pendingToolCalls?: string[];
    errorMessage?: string;
    systemPrompt?: string;
    model?: Model<any>;
    thinkingLevel?: AgentState["thinkingLevel"];
    tools?: AgentTool<any>[];
  }): void {
    if (snapshot.messages) this._messages = snapshot.messages.slice();
    if (snapshot.isStreaming !== undefined) this._isStreaming = snapshot.isStreaming;
    this._streamingMessage = snapshot.streamingMessage;
    if (snapshot.pendingToolCalls) this._pendingToolCalls = new Set(snapshot.pendingToolCalls);
    this._errorMessage = snapshot.errorMessage;
    if (snapshot.systemPrompt !== undefined) this._systemPrompt = snapshot.systemPrompt;
    if (snapshot.model) this._model = snapshot.model;
    if (snapshot.thinkingLevel) this._thinkingLevel = snapshot.thinkingLevel;
    if (snapshot.tools) this._tools = snapshot.tools.slice();

    // applySnapshot mutates state silently — but AgentInterface only re-renders
    // in response to subscribed events. Without this, "New chat" replaces messages
    // server-side but the old conversation stays visible in the UI. Fire a
    // synthetic turn_start: it triggers requestUpdate in AgentInterface but has no
    // side effects on the streaming container (unlike agent_end, which would tear
    // down a live stream if a snapshot ever arrived mid-turn).
    const synthetic = { type: "turn_start" } as AgentEvent;
    const signal = new AbortController().signal;
    for (const l of this.listeners) void l(synthetic, signal);
  }

  /** Receive a single AgentEvent forwarded from the server. */
  async ingestEvent(event: AgentEvent): Promise<void> {
    // reduce() handles delta-only message_updates by mutating
    // `_streamingMessage` in place and back-filling event.message so the
    // downstream pi-web-ui listener sees a complete event. Done before
    // dispatch so subscribers and turnTimings observe a consistent shape.
    this.reduce(event);
    turnTimings.onEvent(event);
    const signal = this.abortController?.signal ?? new AbortController().signal;
    for (const l of this.listeners) await l(event, signal);
    if (event.type === "agent_end") {
      this.resolveActive?.();
      this.resolveActive = undefined;
    }
  }

  /** Mirrors Agent.prompt: returns once agent_end is observed from the server. */
  async prompt(input: string | AgentMessage | AgentMessage[], _images?: ImageContent[]): Promise<void> {
    if (this._isStreaming) {
      throw new Error("RemoteAgent is already processing a prompt.");
    }
    const text = this.extractText(input);
    if (!text) return;

    this.abortController = new AbortController();
    this._isStreaming = true;
    this._errorMessage = undefined;

    // Stamp the submit instant *before* anything else: the live timing readout
    // and per-message chips both anchor off this. Doing it inside the synthetic
    // agent_start path would lose the few ms of optimistic UI work below.
    turnTimings.noteSubmit();

    // Optimistically add the user message + push a synthetic agent_start so the
    // UI shows the new message and the progress pulse immediately, instead of
    // waiting for the first event to round-trip from the server (noticeable on
    // slow local LLMs). We tag the message with `_optimistic` so reduce() can
    // replace it when the server echoes message_end for the same prompt.
    const optimisticUser: AgentMessage & { _optimistic?: true } = {
      role: "user",
      content: text,
      timestamp: Date.now(),
      _optimistic: true,
    } as any;
    this._messages = [...this._messages, optimisticUser];

    const synthetic = { type: "agent_start" } as AgentEvent;
    const signal = new AbortController().signal;
    for (const l of this.listeners) void l(synthetic, signal);

    const done = new Promise<void>((resolve) => { this.resolveActive = resolve; });
    this.sendPromptText(text);
    await done;
  }

  abort(): void {
    this.abortController?.abort();
    this.sendAbort();
  }

  // --- internals ------------------------------------------------------------

  private reduce(event: AgentEvent): void {
    // Some events are AgentSessionEvent extensions (auto_retry_*). The core
    // pi-agent-core type doesn't include them, so cast to access loosely.
    // deno-lint-ignore no-explicit-any
    const e = event as any;
    switch (event.type) {
      case "agent_start":
        this._isStreaming = true;
        this._errorMessage = undefined;
        break;
      case "message_start":
        this._streamingMessage = event.message;
        break;
      case "message_update": {
        // Server strips event.message from text_delta / thinking_delta to cut
        // O(n²) bandwidth — see trimMessageUpdate in main.ts. We rebuild the
        // accumulated message here by appending the delta to the block at
        // contentIndex on the mirror we kept from the last *_start / *_end /
        // message_start, then re-attach it to the event so listeners
        // (pi-web-ui's AgentInterface) and turnTimings see a full event.
        const sub = (event as any).assistantMessageEvent as
          | { type: string; contentIndex?: number; delta?: string }
          | undefined;
        if (event.message) {
          this._streamingMessage = event.message;
          // pi-ai's provider uses `partial: output` as a LIVE reference and
          // mutates `currentBlock.thinking/text += delta` between pushes; the
          // WS subscriber serializes asynchronously, so a *_start event can
          // arrive over the wire with the first chunk(s) already accumulated
          // into the just-pushed block. Resetting on *_start gives us a
          // clean "" to append subsequent deltas onto without doubling up.
          if (typeof sub?.contentIndex === "number") {
            const block = (this._streamingMessage.content as any[])?.[sub.contentIndex];
            if (sub.type === "thinking_start" && block?.type === "thinking") {
              block.thinking = "";
            } else if (sub.type === "text_start" && block?.type === "text") {
              block.text = "";
            }
          }
        } else if (
          this._streamingMessage &&
          sub &&
          typeof sub.contentIndex === "number" &&
          typeof sub.delta === "string"
        ) {
          const block = (this._streamingMessage.content as any[])?.[sub.contentIndex];
          if (block) {
            if (sub.type === "thinking_delta" && typeof block.thinking === "string") {
              block.thinking += sub.delta;
            } else if (sub.type === "text_delta" && typeof block.text === "string") {
              block.text += sub.delta;
            }
          }
          // Back-fill so downstream listeners get the full event shape they expect.
          (event as any).message = this._streamingMessage;
        }
        break;
      }
      case "message_end": {
        this._streamingMessage = undefined;
        // If the server is echoing back the user message we already added
        // optimistically in prompt(), replace the optimistic entry with the
        // server's authoritative version (correct timestamp, normalized content)
        // instead of duplicating it.
        const last = this._messages[this._messages.length - 1] as AgentMessage & { _optimistic?: true } | undefined;
        if (last?._optimistic && last.role === "user" && event.message.role === "user") {
          this._messages = [...this._messages.slice(0, -1), event.message];
        } else {
          this._messages = [...this._messages, event.message];
        }
        break;
      }
      case "tool_execution_start": {
        const next = new Set(this._pendingToolCalls);
        next.add(event.toolCallId);
        this._pendingToolCalls = next;
        recordStart(event.toolCallId);
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this._pendingToolCalls);
        next.delete(event.toolCallId);
        this._pendingToolCalls = next;
        recordEnd(event.toolCallId);
        break;
      }
      case "agent_end":
        this._streamingMessage = undefined;
        this._isStreaming = false;
        this._pendingToolCalls = new Set();
        break;
      // AgentSessionEvent extras — see "default" branch below for non-AgentEvent types.
    }
    // pi-coding-agent's session emits auto_retry_start when an agent_end with
    // a retryable error is observed and the server-side state.messages has
    // been trimmed to remove the failure assistant message. We mirror that
    // here so the UI doesn't end up with one error per retry attempt.
    if (e?.type === "auto_retry_start") {
      const last = this._messages[this._messages.length - 1] as AgentMessage | undefined;
      if (last?.role === "assistant" && (last as { stopReason?: string }).stopReason === "error") {
        this._messages = this._messages.slice(0, -1);
      }
      // Surface the retry status in the (otherwise cleared) errorMessage banner
      // so the user knows we haven't given up yet — pi-web-ui doesn't render
      // this anywhere, but the banner area picks it up.
      const detail = e.errorMessage ? `${e.errorMessage}` : "";
      this._errorMessage = `Retrying (${e.attempt}/${e.maxAttempts})${detail ? ` — ${detail}` : ""}`;
    } else if (e?.type === "auto_retry_end") {
      // success=true clears the retry banner; success=false leaves the final
      // error message in place (it'll be the last assistant message).
      this._errorMessage = undefined;
    }
  }

  private extractText(input: string | AgentMessage | AgentMessage[]): string {
    if (typeof input === "string") return input;
    const msg = Array.isArray(input) ? input[0] : input;
    if (!msg) return "";
    if (msg.role === "user") {
      const c = msg.content;
      if (typeof c === "string") return c;
      const txt = c.find((b: any) => b.type === "text") as TextContent | undefined;
      return txt?.text ?? "";
    }
    return "";
  }
}
