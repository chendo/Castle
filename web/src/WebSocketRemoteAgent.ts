import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { RemoteAgent } from "./RemoteAgent";

const PLACEHOLDER_MODEL: Model<any> = {
  id: "remote",
  name: "Remote",
  api: "openai-completions" as any,
  provider: "local" as any,
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
};

export interface ServerSettings {
  enabledTools: string[];
  contextWindow: number;
  allowUnexposedWrites: boolean;
}

type Frame =
  | { type: "snapshot"; state: any }
  | { type: "event"; event: AgentEvent }
  | { type: "settings"; settings: ServerSettings; all_tools: string[] }
  | { type: "error"; message: string };

/**
 * RemoteAgent that talks to the Deno backend over /ws.
 * On connect: sends `hello`, receives a snapshot, then ingests every AgentEvent
 * the server forwards. Reconnects with exponential backoff on close.
 */
export class WebSocketRemoteAgent extends RemoteAgent {
  private ws?: WebSocket;
  private url: string;
  private reconnectDelay = 500;
  private readonly maxReconnectDelay = 10_000;
  private closed = false;
  public onConnectionChange?: (connected: boolean) => void;
  public onError?: (message: string) => void;
  public onSettings?: (settings: ServerSettings, allTools: string[]) => void;

  constructor(url: string) {
    super({ model: PLACEHOLDER_MODEL });
    this.url = url;
    this.sendPromptText = (text) => this.send({ type: "prompt", text });
    this.sendAbort = () => this.send({ type: "abort" });
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  /** Ask the server to reset the conversation. The server will broadcast a fresh snapshot. */
  reset(): void {
    this.send({ type: "reset" });
  }

  /** Send any custom frame (used by SettingsDialog and friends). */
  sendRaw(frame: any): void {
    this.send(frame);
  }

  private send(frame: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else {
      console.warn("[ws] dropped frame, socket not open:", frame.type);
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelay = 500;
      this.onConnectionChange?.(true);
      this.send({ type: "hello" });
    };

    this.ws.onmessage = async (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
      catch { return; }

      if (frame.type === "snapshot") {
        this.applySnapshot(frame.state);
      } else if (frame.type === "event") {
        await this.ingestEvent(frame.event);
      } else if (frame.type === "settings") {
        this.onSettings?.(frame.settings, frame.all_tools);
      } else if (frame.type === "error") {
        console.error("[ws] server error:", frame.message);
        this.onError?.(frame.message);
      }
    };

    this.ws.onclose = () => {
      this.onConnectionChange?.(false);
      if (this.closed) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = () => { /* let onclose handle reconnect */ };
  }
}
