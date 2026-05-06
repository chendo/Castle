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

export interface SessionInfo {
  path: string;
  size: number;
  modified: Date;
}

export type ToolPin = "off" | "auto" | "always";

export interface ServerSettings {
  enabledTools: string[];
  /** Per-tool pin policy. Missing keys default to "off" (umbrella-only).
   *  Core tools' entries are ignored at runtime; the server still echoes
   *  whatever was saved. */
  toolPins: Partial<Record<string, ToolPin>>;
  contextWindow: number;
  allowUnexposedWrites: boolean;
  conversationCapMb: number;
}

export interface EntityState {
  entity_id: string;
  state: string;
  // deno-lint-ignore no-explicit-any
  attributes: Record<string, any>;
  domain: string;
  exposed: boolean;
}

export type EntityStateChange =
  | EntityState
  | { entity_id: string; removed: true };

export interface HealthSnapshot {
  ha_ok: boolean;
  ha_url: string;
  /** null while the first probe is in flight; boolean once known. */
  llm_ok: boolean | null;
  llm_url: string;
}

type Frame =
  | { type: "snapshot"; state: any }
  | { type: "event"; event: AgentEvent }
  | { type: "settings"; settings: ServerSettings; all_tools: string[]; core_tools?: string[] }
  | { type: "states_snapshot"; states: EntityState[] }
  | { type: "state_change"; entity: EntityStateChange }
  | { type: "health"; health: HealthSnapshot }
  | { type: "catalog_regenerated" }
  | { type: "cache_warmed"; at: number; durationMs: number }
  | { type: "sessions_list"; sessions: SessionInfo[] }
  | { type: "session_resumed"; path: string }
  | { type: "session_deleted"; path: string }
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
  public onSettings?: (settings: ServerSettings, allTools: string[], coreTools: string[]) => void;
  /** Full state map sent on hello and after reconnects. */
  public onStatesSnapshot?: (states: EntityState[]) => void;
  /** Single entity update streamed as HA emits state_changed. */
  public onStateChange?: (change: EntityStateChange) => void;
  /** Server health snapshot — pushed on hello and on HA / ws-client / query changes. */
  public onHealth?: (health: HealthSnapshot) => void;
  /** Session list response from `list_sessions`. */
  public onSessionsList?: (sessions: SessionInfo[]) => void;
  /** Session deletion confirmation. */
  public onDeleteSession?: (path: string) => void;
  /** Most recent prompt-cache warmup (sent on hello and after every warm). */
  public onCacheWarmed?: (at: number, durationMs: number) => void;
  private catalogListeners = new Set<() => void>();

  /**
   * Subscribe to the server's "catalog regenerated" ack. Returns an unsubscribe
   * fn so the caller (e.g. a topbar button waiting to flip back from "rebuilding…")
   * can clean itself up after one shot.
   */
  onCatalogRegenerated(listener: () => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

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

  /** Switch the active model. Server validates, swaps, and broadcasts a fresh snapshot. */
  setModel(modelId: string): void {
    this.send({ type: "set_model", model_id: modelId });
  }

  /** Force regeneration of `.pi-agent/AGENTS.md` and tear down the agent session
    * so the next prompt picks up the new system prompt. */
  regenerateCatalog(): void {
    this.send({ type: "regenerate_catalog" });
  }

  /** Manually trigger a prompt-cache warmup. Server broadcasts a `cache_warmed`
    * frame on success that flows to `onCacheWarmed`. */
  warmCache(): void {
    this.send({ type: "warm_cache" });
  }

  /** Request the list of saved sessions. Response arrives via `onSessionsList`. */
  listSessions(): void {
    this.send({ type: "list_sessions" });
  }

  /** Resume a session from its JSONL path. Server rebuilds and broadcasts snapshot. */
  resumeSession(path: string): void {
    this.send({ type: "resume_session", path });
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
        this.onSettings?.(frame.settings, frame.all_tools, frame.core_tools ?? []);
      } else if (frame.type === "states_snapshot") {
        this.onStatesSnapshot?.(frame.states);
      } else if (frame.type === "state_change") {
        this.onStateChange?.(frame.entity);
      } else if (frame.type === "health") {
        this.onHealth?.(frame.health);
      } else if (frame.type === "cache_warmed") {
        this.onCacheWarmed?.(frame.at, frame.durationMs);
      } else if (frame.type === "catalog_regenerated") {
        for (const l of this.catalogListeners) {
          try { l(); } catch (err) { console.error("[ws] catalog listener:", err); }
        }
      } else if (frame.type === "sessions_list") {
        this.onSessionsList?.(frame.sessions);
      } else if (frame.type === "session_resumed") {
        // No callback needed — the server broadcasts a snapshot after resume.
      } else if (frame.type === "session_deleted") {
        this.onDeleteSession?.(frame.path);
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
