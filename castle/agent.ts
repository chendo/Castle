import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  type SessionInfo,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "npm:@mariozechner/pi-coding-agent";
import type { HAClient } from "./ha-client.ts";
import { buildTools } from "./tools.ts";
import { loadSettings, type ToolName } from "./settings.ts";
import { DATA_DIR, SOURCE_DIR } from "./paths.ts";

const AGENT_DIR = DATA_DIR;
const CWD = SOURCE_DIR;
export const SESSIONS_DIR = `${AGENT_DIR}/sessions`;

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

/** LLM endpoint base URL. Single accessor so renames stay surgical and the
 *  default is consistent across probe / models-list / models.json writers. */
function llmUrl(): string {
  return Deno.env.get("LLM_URL") ?? "http://localhost:1234/v1";
}
function llmApiKey(): string {
  return Deno.env.get("LLM_API_KEY") ?? "";
}
/** API dialect string passed to pi-coding-agent's provider config. Today
 *  only `openai-completions` is wired up; setting LLM_TYPE makes future
 *  alternative dialects opt-in without another env-var rename. */
function llmType(): string {
  return Deno.env.get("LLM_TYPE") ?? "openai-completions";
}

/** Pulls the upstream /v1/models list. Used by the browser model picker. */
export async function listUpstreamModels(): Promise<Array<{ id: string }>> {
  const url = llmUrl();
  const key = llmApiKey();
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
  const key = llmApiKey();
  const url = llmUrl();
  const input = await detectModelInput(url, key, activeModelId);
  console.log(`[castle] model ${activeModelId} input modalities: ${input.join(", ")}`);
  const config = {
    providers: {
      local: {
        baseUrl: url,
        api: llmType(),
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
  await recreateAgentSession();
}

// deno-lint-ignore no-explicit-any
export function getLocalModel(): any {
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

// Path of the JSONL the next session should open. `undefined` means "create a
// fresh one". Cleared by newConversation(); set by resumeSession(); preserved
// across model/settings/catalog changes so a swap doesn't drop history.
let resumeFile: string | undefined = undefined;
// Path of the session file currently open (set after the session is built).
// Used by trimSessions() to avoid deleting the live conversation.
let currentSessionFile: string | undefined = undefined;

export function getCurrentSessionFile(): string | undefined {
  return currentSessionFile;
}

// pi-coding-agent's TypeBox validator and "tool not found" branch both
// surface only the failure pointer + received-args dump back to the LLM.
// Without the *correct* shape, qwen-class models tend to retry the same
// broken call rather than self-correct. enrichToolErrorMessage detects
// these specific failure messages and appends:
//   - the full JSON-Schema for the tool that was being called, so the
//     model sees what fields exist and which are required;
//   - or, for "tool not found", the list of enabled tools.
// Idempotent — re-runs of transformContext won't double-enrich.

const ENRICH_MARKER_SCHEMA = "\n\nCorrect schema for ";
const ENRICH_MARKER_AVAILABLE = "\n\nAvailable tools: ";

function formatSchemaForLLM(schema: unknown): string {
  // TypeBox schemas are JSON Schema with extra Symbol metadata — those
  // symbols are quietly dropped by JSON.stringify. The remaining JSON is
  // exactly the schema that ought to be matched.
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return "(schema unavailable)";
  }
}

export function enrichErrorText(
  text: string,
  schemas: Map<string, unknown>,
  enabledTools: string[],
): string {
  if (text.includes(ENRICH_MARKER_SCHEMA) || text.includes(ENRICH_MARKER_AVAILABLE)) {
    return text;
  }
  const validationMatch = /^Validation failed for tool "([^"]+)":/.exec(text);
  if (validationMatch) {
    const name = validationMatch[1];
    const schema = schemas.get(name);
    if (schema !== undefined) {
      return `${text}${ENRICH_MARKER_SCHEMA}${name}:\n${formatSchemaForLLM(schema)}\n\nFix the arguments to match this schema and retry.`;
    }
  }
  // pi-coding-agent throws this exact phrasing in two places — quoted
  // and unquoted — so handle both.
  const notFoundMatch = /^Tool "?([^"\s]+)"? not found/.exec(text);
  if (notFoundMatch) {
    return `${text}${ENRICH_MARKER_AVAILABLE}${enabledTools.join(", ")}\n\nUse one of the available tools above; tool names are case-sensitive.`;
  }
  return text;
}

// deno-lint-ignore no-explicit-any
export function enrichToolErrorMessage(m: any, schemas: Map<string, unknown>, enabledTools: string[]): any {
  if (!m || m.role !== "toolResult") return m;
  const content = m.content;
  if (!Array.isArray(content)) return m;
  let mutated = false;
  // deno-lint-ignore no-explicit-any
  const newContent = content.map((c: any) => {
    if (c?.type !== "text" || typeof c.text !== "string") return c;
    const next = enrichErrorText(c.text, schemas, enabledTools);
    if (next === c.text) return c;
    mutated = true;
    return { ...c, text: next };
  });
  if (!mutated) return m;
  return { ...m, content: newContent };
}

// Stable JSON serializer so identical arg objects fingerprint the same even
// when their keys arrive in different orders. Used for loop detection.
function stableJsonStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableJsonStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJsonStringify(obj[k])).join(",") + "}";
}

/**
 * Non-building accessor for the live session. Returns the in-flight session
 * promise if one exists, or null when no session has been built. Callers that
 * only want to peek (e.g. to abort a running turn from a WS close handler)
 * should use this instead of `getAgentSession`, which lazily builds a fresh
 * session on first call — wasteful if there's nothing to operate on.
 */
export function peekAgentSession(): Promise<AgentSession> | null {
  return sessionPromise;
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

      // Per-session memo of which skill bundles the agent has loaded via
      // ha_skill. The write-class automation/dashboard tools refuse until
      // "ha_best_practices" is in here. Recreated implicitly by every
      // session rebuild (recreateAgentSession nulls out sessionPromise,
      // so the next getAgentSession constructs a fresh buildTools call).
      const loadedSkills = new Set<string>();
      const customTools = buildTools(ha, {
        multimodal: isMultimodal,
        dashboardCache,
        allowUnexposedWrites: settings.allowUnexposedWrites,
        automationHistoryMaxVersions: settings.automationHistoryMaxVersions,
        dashboardHistoryMaxVersions: settings.dashboardHistoryMaxVersions,
        loadedSkills,
      }).filter((t) => settings.enabledTools.includes(t.name as ToolName));
      const enabledTools = customTools.map((t) => t.name as string);
      console.log(`[agent] enabled tools: ${enabledTools.join(", ")}`);
      // Map for the transformContext validation-error enricher: when
      // pi-coding-agent's TypeBox validator rejects a tool call, it
      // returns a tool-result message containing only the validator's
      // pointer-list. Useful for the LLM to know *what* failed, but no
      // signal as to the *correct* shape — so it tends to retry the
      // same broken arguments. We append the relevant schema below so
      // the recovery path has the information it needs.
      // deno-lint-ignore no-explicit-any
      const toolSchemaByName = new Map<string, any>(
        // deno-lint-ignore no-explicit-any
        customTools.map((t) => [t.name as string, (t as any).parameters]),
      );

      const result = await createAgentSession({
        cwd: CWD,
        agentDir: AGENT_DIR,
        authStorage,
        model,
        noTools: "builtin",
        tools: enabledTools,
        customTools,
        sessionManager: resumeFile
          ? SessionManager.open(resumeFile, SESSIONS_DIR, CWD)
          : SessionManager.create(CWD, SESSIONS_DIR),
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

      // pi's SessionManager handles JSONL persistence on its own. We just hook
      // for the per-turn guardrail counters and dashboard-cache eviction.
      result.session.agent.subscribe((event) => {
        if (event.type === "agent_start") {
          perTurnToolCalls = 0;
          callFingerprintCounts.clear();
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
        // First: enrich every tool-result message that carries a bare
        // validator failure. We rewrite in place inside a copy so the
        // session JSONL keeps the original concise text.
        const enriched = messages.map((m) => enrichToolErrorMessage(m, toolSchemaByName, enabledTools));

        const lastUserIdx = (() => {
          for (let i = enriched.length - 1; i >= 0; i--) {
            if (enriched[i].role === "user") return i;
          }
          return -1;
        })();
        if (lastUserIdx < 0) return enriched;
        // Mutate `messages` reference in the closure below to read from
        // the enriched copy from here on — the rest of this function
        // appends time-of-day to the last user message.
        messages = enriched;

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

        // Epoch ms is included alongside the human-readable form because LLMs
        // are reliably bad at computing it manually — the 35B-class model in
        // local testing burned a full minute counting days from 1970 doing
        // wall-clock arithmetic without it.
        const append = `\n\nCurrent time: ${now} (${tz}) [epoch ms: ${Date.now()}]`;
        const lastUser = messages[lastUserIdx] as { role: "user"; content: any; timestamp: number };
        const newContent = typeof lastUser.content === "string"
          ? lastUser.content + append
          // deno-lint-ignore no-explicit-any
          : [...(lastUser.content as any[]), { type: "text", text: append }];
        const transformed = messages.slice();
        transformed[lastUserIdx] = { ...lastUser, content: newContent };
        return transformed;
      };

      currentSessionFile = result.session.sessionManager.getSessionFile();
      if (currentSessionFile) {
        console.log(`[agent] session file: ${currentSessionFile}`);
      }
      return result.session;
    })();
  }
  return sessionPromise;
}

// ---------------------------------------------------------------------------
// Request queue.
//
// pi-agent-core throws if you call prompt() while another turn is active, so
// every prompt (and the warmup turn) runs through one sequential queue. User
// prompts carry an observable `QueuedRequest` so the UI can show what's
// queued / running, survive a page close, and cancel a specific request by id.
// Internal jobs (warmup) carry `req: null` so they never surface in that view.
// ---------------------------------------------------------------------------

export type RequestStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface QueuedRequest {
  id: string;
  text: string;
  status: RequestStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

interface QueueJob {
  /** Observable metadata for user prompts; null for internal jobs (warmup). */
  req: QueuedRequest | null;
  run: () => Promise<void>;
  /**
   * Stop this job's in-flight turn. Owned by the job rather than derived from
   * the module-level chat session, because a job's turn does not necessarily
   * run on that session — the observer's passes run on a second AgentSession.
   * Cancelling by reaching for peekAgentSession() would abort the wrong agent.
   */
  abort: () => void;
}

const queue: QueueJob[] = [];
let running = false;
/** The job drainQueue is currently awaiting, or null when idle. */
let runningJob: QueueJob | null = null;

/** Abort whatever turn is in flight, whichever session it belongs to. */
function abortRunningJob(): void {
  if (!runningJob) return;
  try { runningJob.abort(); }
  catch (err) { console.warn("[queue] abort threw:", (err as Error).message); }
}

/** Abort the in-flight turn of the shared chat session. The default `abort`
 *  for jobs that run on it; peek avoids forcing a lazy session build. */
function abortChatSession(): void {
  const live = peekAgentSession();
  void live?.then((s) => s.agent.abort()).catch(() => { /* never built */ });
}

// Observable request log: queued + running + a bounded tail of finished
// requests, oldest-first. main.ts subscribes to broadcast it over the WS.
const requests: QueuedRequest[] = [];
const MAX_FINISHED = 20;
let runningId: string | null = null;

const queueListeners = new Set<(reqs: QueuedRequest[]) => void>();

/** Subscribe to request-queue changes. The callback fires on every status
 *  transition with a fresh snapshot. Returns an unsubscribe fn. */
export function subscribeQueue(cb: (reqs: QueuedRequest[]) => void): () => void {
  queueListeners.add(cb);
  return () => queueListeners.delete(cb);
}

/** Snapshot of all tracked requests (deep-copied so callers can't mutate state). */
export function getRequests(): QueuedRequest[] {
  return requests.map((r) => ({ ...r }));
}

function notifyQueue(): void {
  const snapshot = getRequests();
  for (const cb of queueListeners) {
    try { cb(snapshot); } catch (err) { console.error("[queue] listener error:", err); }
  }
}

/** Keep all active requests plus the most recent MAX_FINISHED finished ones,
 *  so the log doesn't grow without bound across a long-lived session. */
function pruneFinished(): void {
  const finished = requests.filter(
    (r) => r.status === "done" || r.status === "error" || r.status === "cancelled",
  );
  if (finished.length <= MAX_FINISHED) return;
  const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED));
  for (let i = requests.length - 1; i >= 0; i--) {
    if (drop.has(requests[i])) requests.splice(i, 1);
  }
}

function genRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    runningJob = job;
    const req = job.req;
    if (req) {
      req.status = "running";
      req.startedAt = Date.now();
      runningId = req.id;
      notifyQueue();
    }
    try {
      await job.run();
      // A cancel may have flipped status mid-run; only a still-"running"
      // request completed normally.
      if (req && req.status === "running") req.status = "done";
    } catch (err) {
      console.error("[agent] prompt error:", err);
      if (req && req.status === "running") {
        req.status = "error";
        req.error = (err as Error).message;
      }
    } finally {
      runningJob = null;
      if (req) {
        req.completedAt = Date.now();
        runningId = null;
        pruneFinished();
        notifyQueue();
      }
    }
  }
  running = false;
}

/** Cancel a queued or running request by id. Queued requests are dropped
 *  before they run; the running request is aborted (drainQueue's finally
 *  stamps completedAt and broadcasts). No-op for unknown / finished ids. */
export function cancelRequest(id: string): void {
  const req = requests.find((r) => r.id === id);
  if (!req) return;
  if (req.status === "queued") {
    req.status = "cancelled";
    req.completedAt = Date.now();
    const idx = queue.findIndex((j) => j.req === req);
    if (idx >= 0) queue.splice(idx, 1);
    pruneFinished();
    notifyQueue();
  } else if (req.status === "running") {
    // Mark cancelled now so drainQueue's done-branch won't overwrite it, then
    // abort the in-flight turn via the job's own hook.
    req.status = "cancelled";
    abortRunningJob();
  }
}

/** Cancel whatever request is currently running. Backs the bare `abort` frame. */
export function cancelRunning(): void {
  if (runningId) cancelRequest(runningId);
}

/** True when nothing is queued or running. Background work only enqueues when
 *  this holds — a background pass that has to wait is better dropped, since by
 *  the time it ran its evidence would be stale anyway. */
export function isQueueIdle(): boolean {
  return !running && queue.length === 0;
}

/**
 * Abort an in-flight *internal* job so a user's prompt doesn't sit behind it.
 * Called at the top of every user-facing enqueue. User jobs are never touched.
 *
 * This is what keeps the observer from costing the user latency: the worst
 * case for a typed prompt is one abort round-trip, not a whole observer pass.
 */
export function preemptInternalJob(): void {
  if (runningJob && runningJob.req === null) abortRunningJob();
}

/**
 * Enqueue background work on the shared queue. `req: null` keeps it out of the
 * UI's request list, matching the warmup turn.
 *
 * Everything goes through one queue because pi-agent-core throws if two turns
 * overlap on one agent instance — and while the observer runs on its *own*
 * instance (so it could technically run concurrently), we deliberately don't
 * let it: two agents against one local GPU contend for VRAM and thrash the
 * prompt cache. `abort` is supplied by the caller because the job's turn runs
 * on the caller's session, not the chat one.
 */
export function submitInternalJob(run: () => Promise<void>, abort: () => void): void {
  queue.push({ req: null, run, abort });
  drainQueue();
}

// Hooks fired when the chat session is torn down. The observer registers here
// rather than being imported by agent.ts, which would be a cycle: the observer
// needs the queue, and the queue must not need the observer.
const sessionResetHooks = new Set<() => Promise<void>>();

export function onAgentSessionReset(fn: () => Promise<void>): () => void {
  sessionResetHooks.add(fn);
  return () => { sessionResetHooks.delete(fn); };
}

async function fireSessionResetHooks(): Promise<void> {
  for (const fn of sessionResetHooks) {
    try { await fn(); }
    catch (err) { console.warn("[agent] session reset hook failed:", (err as Error).message); }
  }
}

/**
 * Tear down the in-memory agent session, preserving the resume target so the
 * next getAgentSession() call rebuilds against the same JSONL file. Used by
 * model swaps, settings changes, catalog rebuilds — anything where session
 * config must change but the conversation should continue.
 */
export async function recreateAgentSession(): Promise<void> {
  // A settings save must not race a background pass that is mid-turn on the
  // old configuration, and every dependent session (the observer's) has to be
  // rebuilt against the new settings too.
  preemptInternalJob();
  await fireSessionResetHooks();
  if (!sessionPromise) {
    currentSessionFile = undefined;
    return;
  }
  try {
    const session = await sessionPromise;
    session.agent.abort();
    session.agent.reset();
  } catch (err) {
    console.warn("[agent] reset error:", (err as Error).message);
  }
  // If the live session was on a file (it always is now), make that the
  // resume target so the rebuild reopens the same JSONL instead of starting
  // a fresh one.
  if (currentSessionFile) resumeFile = currentSessionFile;
  sessionPromise = null;
  currentSessionFile = undefined;
}

/**
 * Start a brand-new conversation. Aborts the in-flight turn, drops the
 * session, and clears the resume target so the next prompt opens a fresh file.
 */
export async function newConversation(): Promise<void> {
  resumeFile = undefined;
  await recreateAgentSession();
  // recreateAgentSession() set resumeFile = currentSessionFile if there was
  // one — undo that so we genuinely start fresh.
  resumeFile = undefined;
}

/**
 * Switch the active conversation to the JSONL at `path`. Aborts any in-flight
 * turn; the next getAgentSession() call will hydrate state from the file.
 */
export async function resumeSession(path: string): Promise<void> {
  // Guard against path traversal — only allow files within SESSIONS_DIR.
  const abs = new URL(path, import.meta.url).pathname;
  const sessionsAbs = new URL(SESSIONS_DIR, import.meta.url).pathname;
  if (!abs.startsWith(sessionsAbs)) {
    console.warn(`[agent] resume rejected: path outside sessions dir (${path})`);
    return;
  }
  resumeFile = abs;
  // Don't go through recreateAgentSession() because it would overwrite
  // resumeFile with currentSessionFile.
  if (sessionPromise) {
    try {
      const session = await sessionPromise;
      session.agent.abort();
      session.agent.reset();
    } catch (err) {
      console.warn("[agent] resume error:", (err as Error).message);
    }
    sessionPromise = null;
    currentSessionFile = undefined;
  }
}

/** List all stored sessions, newest first. */
export async function listSessions(): Promise<SessionInfo[]> {
  const sessions = await SessionManager.list(CWD, SESSIONS_DIR);
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Delete oldest .jsonl files in SESSIONS_DIR until total size is under
 * `capBytes`. Never deletes the active session file. Returns deleted count.
 */
export async function trimSessions(capBytes: number): Promise<number> {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return 0;
  let entries: Array<{ path: string; size: number; mtime: number }>;
  try {
    entries = [];
    for await (const e of Deno.readDir(SESSIONS_DIR)) {
      if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
      const path = `${SESSIONS_DIR}/${e.name}`;
      try {
        const stat = await Deno.stat(path);
        entries.push({ path, size: stat.size, mtime: stat.mtime?.getTime() ?? 0 });
      } catch { /* race with deletion, skip */ }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return 0;
    throw err;
  }
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= capBytes) return 0;
  // Oldest first — but never delete the live session file.
  entries.sort((a, b) => a.mtime - b.mtime);
  let deleted = 0;
  for (const e of entries) {
    if (total <= capBytes) break;
    if (e.path === currentSessionFile) continue;
    try {
      await Deno.remove(e.path);
      total -= e.size;
      deleted++;
    } catch (err) {
      console.warn(`[trim] couldn't delete ${e.path}:`, (err as Error).message);
    }
  }
  if (deleted) console.log(`[trim] removed ${deleted} session file(s); ${(total / 1_048_576).toFixed(1)} MiB remain`);
  return deleted;
}

/** Delete a specific session JSONL file. Returns true if it existed and was removed. */
export async function deleteSession(path: string): Promise<boolean> {
  // Guard against path traversal — only allow files within SESSIONS_DIR.
  const abs = new URL(path, import.meta.url).pathname;
  const sessionsAbs = new URL(SESSIONS_DIR, import.meta.url).pathname;
  if (!abs.startsWith(sessionsAbs)) return false;
  // Never delete the active session file.
  if (abs === currentSessionFile) return false;
  try {
    await Deno.remove(abs);
    console.log(`[trim] deleted session: ${path}`);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    console.warn(`[trim] couldn't delete ${path}:`, (err as Error).message);
    return false;
  }
}

/** Enqueue a user prompt. Returns its request id immediately (the turn runs
 *  asynchronously); status transitions broadcast via subscribeQueue. */
export function submitPrompt(text: string, ha: HAClient): string {
  // A person is here now; don't make them wait behind a background pass.
  preemptInternalJob();
  const req: QueuedRequest = {
    id: genRequestId(),
    text,
    status: "queued",
    createdAt: Date.now(),
  };
  requests.push(req);
  queue.push({
    req,
    abort: abortChatSession,
    run: async () => {
      const session = await getAgentSession(ha);
      await session.prompt(text);
      await session.agent.waitForIdle();
    },
  });
  notifyQueue();
  drainQueue();
  return req.id;
}

/**
 * Run one conversation turn on behalf of the Home Assistant Assist bridge and
 * resolve with the assistant's final text. Shares the single agent session (and
 * therefore the conversation history) with the browser UI, and goes through the
 * same sequential queue as user/warmup prompts — so a voice turn never races a
 * browser prompt and never violates pi-coding-agent's one-turn-at-a-time rule.
 *
 * The turn is observable (carries a QueuedRequest) so it shows in the queue
 * strip and streams into the chat panel like any other prompt.
 */
export function runConversationTurn(
  text: string,
  ha: HAClient,
  onDelta?: (delta: string) => void,
): Promise<string> {
  preemptInternalJob();
  return new Promise<string>((resolve, reject) => {
    const req: QueuedRequest = {
      id: genRequestId(),
      text,
      status: "queued",
      createdAt: Date.now(),
    };
    requests.push(req);
    queue.push({
      req,
      abort: abortChatSession,
      run: async () => {
        let unsubscribe: (() => void) | undefined;
        try {
          const session = await getAgentSession(ha);
          if (onDelta) {
            // Tap this turn's assistant text deltas for the streaming caller.
            // Safe because the queue is sequential — only our turn's events are
            // in flight right now — and we unsubscribe in finally.
            unsubscribe = session.subscribe((event) => {
              const delta = extractTextDelta(event);
              if (delta) onDelta(delta);
            });
          }
          await session.prompt(text);
          await session.agent.waitForIdle();
          resolve(extractAssistantText(session.agent.state.messages));
        } catch (err) {
          // Reject the caller's promise, then rethrow so drainQueue marks the
          // QueuedRequest as errored and broadcasts the failure like any prompt.
          reject(err);
          throw err;
        } finally {
          unsubscribe?.();
        }
      },
    });
    notifyQueue();
    drainQueue();
  });
}

/** Pull the incremental text out of a streaming agent event, or null when the
 *  event isn't an assistant text delta (thinking deltas, tool calls, etc.). */
function extractTextDelta(event: unknown): string | null {
  const e = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: unknown } };
  if (e?.type !== "message_update") return null;
  const sub = e.assistantMessageEvent;
  if (!sub || sub.type !== "text_delta" || typeof sub.delta !== "string") return null;
  return sub.delta;
}

/** Pull the plain text out of the most recent assistant message. Throws if that
 *  message ended in an error so the caller surfaces it instead of an empty reply. */
function extractAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
    if (m.role !== "assistant") continue;
    if (m.stopReason === "error" && typeof m.errorMessage === "string") {
      throw new Error(m.errorMessage);
    }
    return textFromContent(m.content);
  }
  return "";
}

/** Concatenate the text blocks of a message's content, ignoring thinking and
 *  tool-call blocks. Tolerates the plain-string content shape too. */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

export interface WarmupResult { at: number; durationMs: number }

let lastWarmup: WarmupResult | null = null;
let warming = false;

export function getLastWarmup(): WarmupResult | null {
  return lastWarmup;
}

/** True between the moment a warmup turn enters the prompt queue and the
 *  matching agent.reset(). The broadcast layer reads this to suppress the
 *  warmup turn so it never lands in the chat panel; the snapshot serializer
 *  reads it to keep `messages` empty for any client that connects mid-warm. */
export function isWarmingUp(): boolean {
  return warming;
}

/**
 * Send a one-shot prompt so the upstream LLM caches our system prompt + tool
 * schema prefix. The first real user prompt then hits the cache and
 * time-to-first-token drops from cold (full prefix processing) to warm.
 *
 * Goes through the same prompt queue as user input so a real prompt arriving
 * mid-warmup just waits its turn rather than racing. After waitForIdle, we
 * agent.reset() so the warmup turn never appears in any UI snapshot — the
 * SessionManager is in-memory, so there's no on-disk trace either.
 *
 * Resolves with the wall-clock timestamp and duration on success, or null on
 * failure. Caller decides whether to broadcast.
 */
export async function warmupPromptCache(ha: HAClient): Promise<WarmupResult | null> {
  const t0 = performance.now();
  return await new Promise<WarmupResult | null>((resolve) => {
    queue.push({ req: null, abort: abortChatSession, run: async () => {
      // `warming` brackets the entire prompt+reset sequence so the broadcast
      // layer can drop every event the warmup turn generates. Cleared in
      // finally so a thrown agent error doesn't leave us stuck filtering.
      warming = true;
      try {
        const session = await getAgentSession(ha);
        await session.prompt("Your output must be empty.");
        await session.agent.waitForIdle();
        session.agent.reset();
        const result: WarmupResult = { at: Date.now(), durationMs: Math.round(performance.now() - t0) };
        lastWarmup = result;
        console.log(`[castle] prompt cache warmed in ${result.durationMs}ms`);
        resolve(result);
      } catch (err) {
        console.warn("[castle] warmup failed:", (err as Error).message);
        resolve(null);
      } finally {
        warming = false;
      }
    } });
    drainQueue();
  });
}
