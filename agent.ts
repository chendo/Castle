import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "npm:@mariozechner/pi-coding-agent";
import type { HAClient } from "./ha-client.ts";
import { buildTools } from "./tools.ts";
import { loadSettings } from "./settings.ts";
import { logMessageEnd, resetConversationFile } from "./persistence.ts";

const AGENT_DIR = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
const CWD = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

const authStorage = AuthStorage.create(`${AGENT_DIR}/auth.json`);

// ---------------------------------------------------------------------------
// Model lifecycle.
//
// The active model id is mutable — the browser model picker can swap it at
// runtime. activeModelId is the source of truth; writeModelsJson rewrites
// .pi-agent/models.json from it before each session is built. setActiveModel
// also resets the in-flight session so the next prompt picks up the new model.
// ---------------------------------------------------------------------------

let activeModelId: string = Deno.env.get("MODEL_NAME") ?? "";

export function getActiveModelId(): string {
  return activeModelId;
}

/** Pulls the upstream /v1/models list. Used by the browser model picker. */
export async function listUpstreamModels(): Promise<Array<{ id: string }>> {
  const url = Deno.env.get("OPENAI_URL") ?? "http://localhost:1234/v1";
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${url.replace(/\/$/, "")}/models`, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`upstream /models returned ${res.status}`);
  const json = await res.json() as { data?: Array<{ id: string }> };
  return Array.isArray(json.data) ? json.data : [];
}

/**
 * Probe per-model capability metadata to figure out if image input is
 * supported. Some OpenAI-compat servers (LM Studio, vLLM with vision-info,
 * llama.cpp) expose this at /api/v0/models/<id>; everything else falls through
 * to text-only assumption. Side-effects: none — just returns the modalities.
 */
async function detectModelInput(baseUrl: string, apiKey: string, modelId: string): Promise<string[]> {
  const restBase = baseUrl.replace(/\/v1\/?$/, "") + "/api/v0";
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${restBase}/models/${encodeURIComponent(modelId)}`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const m = await res.json() as { type?: string; vision?: boolean };
      if (m.vision === true || m.type === "vlm") return ["text", "image"];
      return ["text"];
    }
    const listRes = await fetch(`${restBase}/models`, { headers, signal: AbortSignal.timeout(2000) });
    if (!listRes.ok) throw new Error(`models list ${listRes.status}`);
    const list = await listRes.json() as { data?: Array<{ id: string; type?: string; vision?: boolean }> };
    const found = list.data?.find((m) => m.id === modelId);
    if (found && (found.vision === true || found.type === "vlm")) return ["text", "image"];
    return ["text"];
  } catch (err) {
    console.warn(`[castle] capability probe failed (${(err as Error).message}); assuming text-only`);
    return ["text"];
  }
}

/**
 * Persist the current activeModelId into .pi-agent/models.json so
 * ModelRegistry.create() picks up the right model on the next session
 * construction. Always run before getAgentSession when the active model
 * has changed.
 */
export async function writeModelsJson(): Promise<void> {
  if (!activeModelId) throw new Error("no active model — set MODEL_NAME env var or POST set_model");
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  const url = Deno.env.get("OPENAI_URL") ?? "http://localhost:1234/v1";
  const input = await detectModelInput(url, key, activeModelId);
  console.log(`[castle] model ${activeModelId} input modalities: ${input.join(", ")}`);
  const config = {
    providers: {
      local: {
        baseUrl: url,
        api: "openai-completions",
        apiKey: key,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: activeModelId,
          name: activeModelId,
          // Placeholder — getAgentSession() overwrites this with settings.contextWindow
          // (agent.ts:165) before pi-coding-agent ever reads it. The real default + env
          // override (MODEL_CONTEXT_WINDOW) lives in settings.ts.
          contextWindow: 8192,
          maxTokens: 4096,
          reasoning: false,
          input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  await Deno.writeTextFile(`${AGENT_DIR}/models.json`, JSON.stringify(config, null, 2));
}

/**
 * Switch the active model. Re-detects modalities, rewrites models.json, and
 * tears down the current agent session so the next prompt builds against the
 * new model. Does NOT auto-prompt — the caller is expected to broadcast a
 * fresh snapshot to connected clients so they see the new state.model.
 */
export async function setActiveModel(id: string): Promise<void> {
  if (!id || typeof id !== "string") throw new Error("set_model: id required");
  if (id === activeModelId) return;
  console.log(`[castle] switching active model: ${activeModelId} → ${id}`);
  activeModelId = id;
  await writeModelsJson();
  await resetAgentSession();
}

// deno-lint-ignore no-explicit-any
function getLocalModel(): any {
  const registry = ModelRegistry.create(authStorage, `${AGENT_DIR}/models.json`);
  const err = registry.getError();
  if (err) throw new Error(`models.json error: ${err}`);
  // deno-lint-ignore no-explicit-any
  const models = (registry as any).models as Array<{ provider: string; id: string }>;
  const model = models.find((m) => m.provider === "local");
  if (!model) throw new Error("local model not found — check .pi-agent/models.json");
  console.log(`[agent] using model: ${model.provider}/${model.id}`);
  return model;
}

let sessionPromise: Promise<AgentSession> | null = null;

// Stable JSON serializer so identical arg objects fingerprint the same even
// when their keys arrive in different orders. Used for loop detection.
function stableJsonStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableJsonStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJsonStringify(obj[k])).join(",") + "}";
}

export function getAgentSession(ha: HAClient): Promise<AgentSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const settings = await loadSettings();
      const model = getLocalModel();
      // Override the bundled-in models.json contextWindow with the user-configured
      // value. The model object is mutated in place because pi-coding-agent reads
      // contextWindow off the model when sizing compaction thresholds.
      model.contextWindow = settings.contextWindow;
      const isMultimodal = Array.isArray(model.input) && model.input.includes("image");
      if (!isMultimodal) {
        console.log("[agent] model is text-only — ha_get_camera_snapshot will fall back to text descriptions");
      }
      console.log(`[agent] context window: ${settings.contextWindow} tokens`);
      // Per-turn cache for ha_get_dashboard so drill-down doesn't refetch the
      // (potentially huge) config on every call. Cleared on agent_end below.
      const dashboardCache = new Map<string, unknown>();

      // Scale compaction thresholds with the context window so a larger window
      // actually buys more retained history instead of always trimming back to 8k.
      const reserveTokens = Math.min(4096, Math.floor(settings.contextWindow * 0.0625));
      const keepRecentTokens = Math.max(8192, Math.floor(settings.contextWindow * 0.125));

      const result = await createAgentSession({
        cwd: CWD,
        agentDir: AGENT_DIR,
        authStorage,
        model,
        noTools: "builtin",
        tools: settings.enabledTools.slice(),
        customTools: buildTools(ha, {
          multimodal: isMultimodal,
          dashboardCache,
          allowUnexposedWrites: settings.allowUnexposedWrites,
        }),
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens,
            keepRecentTokens,
          },
        }),
        thinkingLevel: "low",
      });

      // Per-turn guardrails: stop the agent if it goes berserk with tool calls.
      // - Cap of 50 calls per turn (anything beyond that is almost certainly a runaway).
      // - Identical (toolName + args) called 5 times in a single turn → loop, abort.
      // Both states reset on agent_start.
      const MAX_TOOL_CALLS_PER_TURN = 50;
      const MAX_IDENTICAL_CALLS = 5;
      let perTurnToolCalls = 0;
      const callFingerprintCounts = new Map<string, number>();

      // Persist every completed message to the markdown conversation file.
      // Errors here must never break the agent loop, so we swallow them.
      // Also evict the dashboard cache once the turn ends — it's a within-turn
      // optimization; carrying stale config across turns isn't worth the risk.
      result.session.agent.subscribe((event) => {
        if (event.type === "agent_start") {
          perTurnToolCalls = 0;
          callFingerprintCounts.clear();
        } else if (event.type === "message_end") {
          // deno-lint-ignore no-explicit-any
          void logMessageEnd((event as any).message);
        } else if (event.type === "agent_end") {
          dashboardCache.clear();
        }
      });

      // Wrap (don't replace) the beforeToolCall hook pi-coding-agent already
      // installs for extension routing — defer to it first, then run our caps.
      const previousBefore = result.session.agent.beforeToolCall;
      result.session.agent.beforeToolCall = async (ctx, signal) => {
        if (previousBefore) {
          const r = await previousBefore(ctx, signal);
          if (r?.block) return r;
        }
        perTurnToolCalls++;
        if (perTurnToolCalls > MAX_TOOL_CALLS_PER_TURN) {
          console.warn(`[agent] tool-call cap of ${MAX_TOOL_CALLS_PER_TURN} exceeded — aborting turn`);
          // Abort asynchronously so the in-flight emission can settle. The
          // block reason is what the LLM sees in place of the tool result.
          queueMicrotask(() => result.session.agent.abort());
          return {
            block: true,
            reason: `Tool-call limit reached (${MAX_TOOL_CALLS_PER_TURN} per turn). Stopping to prevent runaway. If you genuinely needed more, the user can split the request.`,
          };
        }
        // deno-lint-ignore no-explicit-any
        const toolName = (ctx as any).toolCall?.name ?? "(unknown)";
        // deno-lint-ignore no-explicit-any
        const args = (ctx as any).args;
        const key = `${toolName}:${stableJsonStringify(args)}`;
        const count = (callFingerprintCounts.get(key) ?? 0) + 1;
        callFingerprintCounts.set(key, count);
        if (count >= MAX_IDENTICAL_CALLS) {
          console.warn(`[agent] tool ${toolName} called ${count}× with identical args — aborting`);
          queueMicrotask(() => result.session.agent.abort());
          return {
            block: true,
            reason: `Loop detected: tool "${toolName}" was called ${MAX_IDENTICAL_CALLS} times with identical arguments. Stopping. Try a different approach (different filter, different tool, or stop and ask the user for clarification).`,
          };
        }
        return undefined;
      };

      // Append the current wall-clock time to the latest user message at
      // LLM-call time. Home-state used to be injected here too, but it's a
      // meaningful chunk of context the agent rarely needs in full — now the
      // agent fetches what it needs via ha_get_states (with `filter`) instead.
      // transformContext mutates only what the LLM sees, so stored messages —
      // and the UI — keep showing the user's clean text.
      result.session.agent.transformContext = async (messages) => {
        const lastUserIdx = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") return i;
          }
          return -1;
        })();
        if (lastUserIdx < 0) return messages;

        const houseInfo = await ha.getHouseInfo();
        const tz = houseInfo.timezone || "UTC";
        const now = new Date().toLocaleString("en-US", {
          timeZone: tz,
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

        const append = `\n\nCurrent time: ${now} (${tz})`;
        const lastUser = messages[lastUserIdx] as { role: "user"; content: any; timestamp: number };
        const newContent = typeof lastUser.content === "string"
          ? lastUser.content + append
          // deno-lint-ignore no-explicit-any
          : [...(lastUser.content as any[]), { type: "text", text: append }];
        const transformed = messages.slice();
        transformed[lastUserIdx] = { ...lastUser, content: newContent };
        return transformed;
      };

      return result.session;
    })();
  }
  return sessionPromise;
}

// Sequential prompt queue — pi-agent-core throws if you call prompt while another is active.
const queue: Array<() => Promise<void>> = [];
let running = false;

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      await job();
    } catch (err) {
      console.error("[agent] prompt error:", err);
    }
  }
  running = false;
}

/**
 * Clear the current conversation. Aborts any in-flight turn and drops the
 * session so the next prompt starts fresh.
 */
export async function resetAgentSession(): Promise<void> {
  resetConversationFile();
  if (!sessionPromise) return;
  try {
    const session = await sessionPromise;
    session.agent.abort();
    session.agent.reset();
  } catch (err) {
    console.warn("[agent] reset error:", (err as Error).message);
  }
  sessionPromise = null;
}

export function submitPrompt(text: string, ha: HAClient): void {
  queue.push(async () => {
    const session = await getAgentSession(ha);
    await session.prompt(text);
    await session.agent.waitForIdle();
  });
  drainQueue();
}

/**
 * Send a one-shot prompt at startup so the upstream LLM caches our system
 * prompt + tool schema prefix. The first real user prompt then hits the cache
 * and time-to-first-token drops from cold (full prefix processing) to warm.
 *
 * Goes through the same prompt queue as user input so a real prompt arriving
 * mid-warmup just waits its turn rather than racing. After waitForIdle, we
 * agent.reset() so the warmup turn never appears in any UI snapshot — the
 * SessionManager is in-memory, so there's no on-disk trace either.
 */
export async function warmupPromptCache(ha: HAClient): Promise<void> {
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    queue.push(async () => {
      try {
        const session = await getAgentSession(ha);
        await session.prompt("Do not respond, prompt cache");
        await session.agent.waitForIdle();
        session.agent.reset();
        console.log(`[castle] prompt cache warmed in ${Math.round(performance.now() - t0)}ms`);
      } catch (err) {
        console.warn("[castle] warmup failed:", (err as Error).message);
      } finally {
        resolve();
      }
    });
    drainQueue();
  });
}
