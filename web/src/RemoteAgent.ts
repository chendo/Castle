import type { AgentEvent, AgentMessage, AgentState, AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";

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
  }

  /** Receive a single AgentEvent forwarded from the server. */
  async ingestEvent(event: AgentEvent): Promise<void> {
    this.reduce(event);
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
    switch (event.type) {
      case "agent_start":
        this._isStreaming = true;
        this._errorMessage = undefined;
        break;
      case "message_start":
      case "message_update":
        this._streamingMessage = event.message;
        break;
      case "message_end":
        this._streamingMessage = undefined;
        this._messages = [...this._messages, event.message];
        break;
      case "tool_execution_start": {
        const next = new Set(this._pendingToolCalls);
        next.add(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this._pendingToolCalls);
        next.delete(event.toolCallId);
        this._pendingToolCalls = next;
        break;
      }
      case "agent_end":
        this._streamingMessage = undefined;
        this._isStreaming = false;
        this._pendingToolCalls = new Set();
        break;
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
