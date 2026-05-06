import { HAClient } from "./ha-client.ts";
import { buildAgentsMd, buildCatalogData, buildServicesData, extractDomains } from "./catalog.ts";
import {
  getActiveModelId,
  getAgentSession,
  getLastWarmup,
  isWarmingUp,
  listSessions,
  listUpstreamModels,
  newConversation,
  recreateAgentSession,
  resumeSession,
  setActiveModel,
  submitPrompt,
  trimSessions,
  warmupPromptCache,
  writeModelsJson,
  deleteSession,
} from "./agent.ts";
import { parseHistoryPoints } from "./tools.ts";
import { ALL_TOOL_NAMES, loadSettings, saveSettings, TOOL_DESCRIPTIONS, type ToolName } from "./settings.ts";

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "7090");
const AUTH_TOKEN = Deno.env.get("CASTLE_AUTH_TOKEN") ?? "";

const ha = new HAClient(HA_URL, HA_TOKEN);


async function regenerateCatalog(): Promise<void> {
  try {
    const exposedList = await ha.getExposedEntities();
    const exposed = exposedList ? new Set(exposedList) : undefined;
    const areas = await ha.getAreas();
    // Areas may have shifted (HA UI lets users rename / reassign while we run).
    // Drop the cached frame so the next hello / catalog_regenerated push picks
    // up the fresh data.
    invalidateAreasCache();
    const houseInfo = await ha.getHouseInfo();
    const services = await ha.getServices();
    const states = ha.getAllStates();
    const exposedStates = exposed ? states.filter((s) => exposed.has(s.entity_id)) : states;
    const presentDomains = extractDomains(exposedStates);
    const servicesData = buildServicesData(services, presentDomains);
    const catalogData = buildCatalogData(states, exposed, areas);
    const settings = await loadSettings();
    const enabled = new Set<ToolName>(settings.enabledTools);
    const disabledTools = ALL_TOOL_NAMES
      .filter((n) => !enabled.has(n))
      .map((n) => ({ name: n, description: TOOL_DESCRIPTIONS[n] }));
    const agentsMd = buildAgentsMd({
      houseInfo,
      services: servicesData,
      catalog: catalogData,
      disabledTools,
    });
    const agentDir = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
    await Deno.writeTextFile(`${agentDir}/AGENTS.md`, agentsMd);
    console.log(`[castle] catalog refreshed (${exposed ? exposed.size : 'all'} entities, ${Object.keys(services).length} service domains)`);
  } catch (err) {
    console.error(`[castle] catalog refresh failed:`, (err as Error).message);
  }
}

/**
 * Bootstrap and supervision: wire callbacks once, then hand off to HAClient's
 * own connect/retry loop. start() returns after the first attempt settles; the
 * loop continues in the background indefinitely. Every successful (re)connect
 * triggers a catalog refresh; transitions also flush a health frame to the UI.
 */
let warmupKicked = false;

function setupHaSupervisor(): void {
  let firstReady = false;
  let catalogTimer: number | undefined;

  ha.onConnectionChange((connected) => {
    broadcastHealth();
    if (!connected) {
      // Stop the catalog timer while disconnected; restart on next reconnect.
      if (catalogTimer !== undefined) {
        clearInterval(catalogTimer);
        catalogTimer = undefined;
      }
      return;
    }
    // Connected (or reconnected). Refresh catalog so AGENTS.md picks up any
    // entity / area changes that happened while we were offline.
    void (async () => {
      try {
        await regenerateCatalog();
        const exposedList = await ha.getExposedEntities();
        const n = exposedList ? exposedList.length : "all";
        if (!firstReady) {
          console.log(`[castle] ready (${n} entities)`);
          firstReady = true;
          // Warm the LLM prompt cache once HA is up and AGENTS.md (the system
          // prompt) is fresh. Idempotent across HA reconnects — only the
          // first-ever connect kicks it. Fire-and-forget so the supervisor
          // loop doesn't block on the LLM call.
          if (!warmupKicked) {
            warmupKicked = true;
            void warmupPromptCache(ha).then((result) => {
              if (result) broadcastCacheWarmed(result);
            });
          }
        } else {
          console.log(`[castle] reconnected (${n} entities)`);
        }
      } catch (err) {
        console.error("[castle] post-connect setup failed:", (err as Error).message);
      }
    })();
    // Wire the long-running periodic refresh once, on the first successful connect.
    if (catalogTimer === undefined) {
      catalogTimer = setInterval(regenerateCatalog, 5 * 60 * 1000);
    }
  });

  // Single state_changed → WS broadcast wiring; the listener registry survives
  // HA reconnects so this only needs to run once.
  wireStateBroadcast();

  void ha.start();
}

const WEB_DIST = new URL("web/dist/", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  // Block traversal
  if (rel.includes("..")) return null;
  const filePath = `${WEB_DIST}${rel}`;
  try {
    const stat = await Deno.stat(filePath);
    if (!stat.isFile) return null;
    const file = await Deno.open(filePath, { read: true });
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
    return new Response(file.readable, {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return null;
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (url.pathname === "/health") {
    return Response.json(buildHealth());
  }

  if ((url.pathname.startsWith("/camera/") || url.pathname.startsWith("/camera_stream/")) && req.method === "GET") {
    const isStream = url.pathname.startsWith("/camera_stream/");
    const prefix = isStream ? "/camera_stream/" : "/camera/";
    const entityId = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!entityId.startsWith("camera.")) return new Response("Not a camera entity", { status: 400 });
    const haPath = isStream
      ? `/api/camera_proxy_stream/${encodeURIComponent(entityId)}`
      : `/api/camera_proxy/${encodeURIComponent(entityId)}`;
    try {
      const haRes = await ha.restCall(haPath);
      if (!haRes.ok) return new Response(`HA returned ${haRes.status}`, { status: haRes.status });
      const headers = new Headers();
      const ct = haRes.headers.get("content-type");
      if (ct) headers.set("Content-Type", ct);
      headers.set("Cache-Control", "no-store");
      return new Response(haRes.body, { headers });
    } catch (err) {
      return new Response(`Camera fetch failed: ${(err as Error).message}`, { status: 502 });
    }
  }

  if (url.pathname === "/models" && req.method === "GET") {
    // Browser model picker fetches this to populate its list. Proxies the
    // upstream OpenAI-compat /v1/models endpoint so the API key never leaves
    // the server. Returns { active: <id>, models: [{ id }, …] }.
    try {
      const list = await listUpstreamModels();
      return Response.json({ active: getActiveModelId(), models: list.map((m) => ({ id: m.id })) });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  }

  if (url.pathname === "/agents.md" && req.method === "GET") {
    // Serve the rendered system prompt so the user can inspect what the agent
    // actually sees. text/plain so the browser displays inline; ?download=1
    // forces a save dialog.
    try {
      const path = `${new URL(".pi-agent/AGENTS.md", import.meta.url).pathname}`;
      const text = await Deno.readTextFile(path);
      const headers = new Headers({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      if (url.searchParams.get("download") === "1") {
        headers.set("Content-Disposition", `attachment; filename="AGENTS.md"`);
      }
      return new Response(text, { headers });
    } catch (err) {
      return new Response(`AGENTS.md unavailable: ${(err as Error).message}`, { status: 503 });
    }
  }

  if (url.pathname === "/history" && req.method === "GET") {
    const entityIds = url.searchParams.getAll("entity_id");
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    if (entityIds.length === 0) return new Response("entity_id required", { status: 400 });
    const end = endParam ? new Date(endParam) : new Date();
    const start = startParam ? new Date(startParam) : new Date(end.getTime() - 24 * 3_600_000);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return new Response("Invalid start/end", { status: 400 });

    const out: Record<string, Array<{ t: string; v: number }>> = {};
    await Promise.all(entityIds.map(async (id) => {
      try {
        const raw = await ha.getHistory(id, start, end);
        const pts = parseHistoryPoints(raw) ?? [];
        out[id] = pts.map((p) => ({ t: p.rawIso, v: p.value }));
      } catch (err) {
        console.warn(`[history] ${id}:`, (err as Error).message);
        out[id] = [];
      }
    }));
    return Response.json(out);
  }

  if (req.method === "GET") {
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;
  }

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 400 });
    }
    if (AUTH_TOKEN) {
      // Browser WebSocket can't set Authorization headers, so token comes via ?token=...
      // or the Sec-WebSocket-Protocol subprotocol "bearer.<token>".
      const queryToken = url.searchParams.get("token") ?? "";
      const subproto = req.headers.get("sec-websocket-protocol") ?? "";
      const protoToken = subproto.split(",").map((s) => s.trim()).find((p) => p.startsWith("bearer."))?.slice(7) ?? "";
      if (queryToken !== AUTH_TOKEN && protoToken !== AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket).catch((err) => console.error("[ws] handler error:", err));
    return response;
  }

  return new Response("Not found", { status: 404 });
}

// --- WebSocket handling ----------------------------------------------------

const sockets = new Set<WebSocket>();
// Tracked per-agent: recreateAgentSession() rebuilds the agent, so a single
// module-level "wired" boolean would leave the new agent unsubscribed and the
// browser would silently miss every event from then on (fixed by full refresh,
// which loads the new state via the hello snapshot — exactly the symptom we hit).
const broadcastWiredAgents = new WeakSet<object>();

/**
 * Surface LLM call failures and retry attempts in the container logs. Without
 * this the agent silently swallows connection errors into agent state and the
 * operator only sees them via the browser UI — useless when running headless
 * or trying to diagnose a misconfigured LLM_URL.
 */
function logLlmFailure(event: unknown): void {
  // deno-lint-ignore no-explicit-any
  const e = event as any;
  if (!e || typeof e !== "object") return;
  const url = Deno.env.get("LLM_URL") ?? "(LLM_URL unset)";
  if (e.type === "auto_retry_start") {
    console.error(`[agent] LLM call failed, retrying (${e.attempt}/${e.maxAttempts}, ${e.delayMs}ms backoff): ${e.errorMessage}  [model server: ${url}]`);
    return;
  }
  if (e.type === "auto_retry_end" && e.success === false) {
    console.error(`[agent] LLM retries exhausted (${e.attempt} attempts): ${e.finalError ?? "unknown"}  [model server: ${url}]`);
    return;
  }
  if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error" && typeof e.message.errorMessage === "string") {
    // The retry path already logged this turn via auto_retry_start; only emit
    // for the final/un-retried failure to avoid double-logging.
    // We can't tell from this event alone whether a retry follows, so log at
    // warn level and let auto_retry_start be the louder error indicator.
    console.warn(`[agent] LLM call returned error: ${e.message.errorMessage}  [model server: ${url}]`);
  }
}

/**
 * Augment errorMessage on assistant failure messages with the LLM_URL the
 * agent was trying to reach. The bare "tcp connect error" / "fetch failed"
 * strings Deno produces don't say which endpoint timed out, so the user can't
 * tell whether their model server is down or misconfigured.
 */
function enrichErrorEvent(event: unknown): unknown {
  // deno-lint-ignore no-explicit-any
  const e = event as any;
  if (e?.type !== "message_end" || e.message?.role !== "assistant") return event;
  const msg = e.message;
  if (msg.stopReason !== "error" || typeof msg.errorMessage !== "string") return event;
  // Only annotate connection-shaped errors; rate-limit / 5xx already carry useful detail.
  if (!/connect|fetch failed|connection refused|enotfound|econnreset|timed out|terminated/i.test(msg.errorMessage)) {
    return event;
  }
  const url = Deno.env.get("LLM_URL") ?? "(LLM_URL unset)";
  if (msg.errorMessage.includes(url)) return event; // already present
  return {
    ...e,
    message: { ...msg, errorMessage: `${msg.errorMessage}\n[Model server: ${url}]` },
  };
}

async function ensureAgentBroadcast(): Promise<void> {
  const session = await getAgentSession(ha);
  if (broadcastWiredAgents.has(session.agent)) return;
  broadcastWiredAgents.add(session.agent);
  // Subscribe at the SESSION level (not session.agent) so the broadcast
  // includes auto_retry_start / auto_retry_end. The client uses those to
  // drop the prior failure message when a retry kicks in, matching the
  // server's own state.messages cleanup. Without this every retry stacked
  // a duplicate "Error: Connection Error" message in the chat.
  session.subscribe((event: unknown) => {
    logLlmFailure(event);
    // Drop every event generated by the warmup turn. The warmup runs the same
    // prompt path as user input, so without this filter pi-web-ui renders the
    // synthetic "Your output must be empty." round-trip in the chat panel.
    // Server-side state is cleared by agent.reset() in warmupPromptCache.
    if (isWarmingUp()) return;
    const enriched = enrichErrorEvent(event);
    const frame = JSON.stringify({ type: "event", event: enriched });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch (err) { console.error("[ws] send failed:", err); }
      }
    }
  });
  console.log("[ws] agent broadcast wired");
}

// Probed asynchronously; null means "not yet checked / unknown". Surfaced on
// the health frame so the UI can render an LLM-side status bubble.
let llmHealthy: boolean | null = null;

async function probeLlm(): Promise<void> {
  let healthy = false;
  try {
    const models = await listUpstreamModels();
    healthy = Array.isArray(models);
  } catch {
    healthy = false;
  }
  if (llmHealthy !== healthy) {
    llmHealthy = healthy;
    broadcastHealth();
  }
}

function startLlmProbe(): void {
  void probeLlm();
  // 15s cadence — listUpstreamModels has its own 5s abort, so worst-case the
  // probe burns 5s of every 15s when the LLM is unreachable. Cheap enough.
  setInterval(() => void probeLlm(), 15_000);
}

function buildHealth() {
  return {
    ha_ok: ha.isConnected,
    ha_url: HA_URL,
    llm_ok: llmHealthy,
    llm_url: Deno.env.get("LLM_URL") ?? "",
  };
}

function broadcastHealth(): void {
  const frame = JSON.stringify({ type: "health", health: buildHealth() });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch { /* ignore */ }
    }
  }
}

function broadcastCacheWarmed(result: { at: number; durationMs: number }): void {
  const frame = JSON.stringify({ type: "cache_warmed", at: result.at, durationMs: result.durationMs });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch { /* ignore */ }
    }
  }
}

/** Convert HA state list to the entity shape the sidebar / entity-detail UIs use. */
function serializeStates() {
  return ha.getAllStates().map((s) => ({
    entity_id: s.entity_id,
    state: s.state,
    attributes: s.attributes,
    domain: s.entity_id.split(".")[0],
    exposed: ha.isExposed(s.entity_id),
  }));
}

/** Snapshot of HA's area registry for the sidebar tree + dashboard area
 *  cards. Cached on first build and refreshed when the catalog regenerates
 *  (entity ↔ area mapping changes are rare; no need for a per-WS-frame
 *  push for every state_changed event). */
let cachedAreasFrame: string | null = null;

async function buildAreasFrame(): Promise<string> {
  if (cachedAreasFrame) return cachedAreasFrame;
  const areas = await ha.getAreas();
  const list = [...areas.entries()].map(([area_id, info]) => ({
    area_id,
    name: info.name,
    entity_ids: [...info.entities],
  }));
  cachedAreasFrame = JSON.stringify({ type: "areas_snapshot", areas: list });
  return cachedAreasFrame;
}

function invalidateAreasCache(): void {
  cachedAreasFrame = null;
}

/**
 * Wire the HA state_changed → WS clients fan-out exactly once. Idempotent:
 * subsequent calls are no-ops. Called from startup AFTER the HA connection
 * lands so HAClient's listener registry is alive.
 */
let stateBroadcastWired = false;
function wireStateBroadcast(): void {
  if (stateBroadcastWired) return;
  stateBroadcastWired = true;
  ha.onStateChange((entityId, newState) => {
    const payload = newState
      ? {
        entity_id: entityId,
        state: newState.state,
        attributes: newState.attributes,
        domain: entityId.split(".")[0],
        exposed: ha.isExposed(entityId),
      }
      // Removed entity — clients drop it from their local map.
      : { entity_id: entityId, removed: true as const };
    const frame = JSON.stringify({ type: "state_change", entity: payload });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch (err) { console.error("[ws] state push failed:", err); }
      }
    }
  });
  console.log("[ws] state_change broadcast wired");
}

function serializeSnapshot(session: Awaited<ReturnType<typeof getAgentSession>>) {
  const s = session.agent.state;
  // While a warmup is in flight, in-memory state contains the synthetic
  // warmup turn that agent.reset() will wipe in a moment. Hide it so a client
  // that connects mid-warm doesn't briefly render the placeholder prompt.
  const warming = isWarmingUp();
  return {
    messages: warming ? [] : s.messages,
    streamingMessage: warming ? null : s.streamingMessage,
    isStreaming: warming ? false : s.isStreaming,
    pendingToolCalls: Array.from(s.pendingToolCalls),
    model: s.model,
    systemPrompt: s.systemPrompt,
    thinkingLevel: s.thinkingLevel,
    tools: s.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      label: t.label,
    })),
    errorMessage: s.errorMessage,
  };
}

async function handleSocket(socket: WebSocket): Promise<void> {
  sockets.add(socket);
  // A user just opened the UI — if HA is currently down and we're sitting on
  // a multi-minute backoff window, kick a fresh connect attempt now so the
  // user doesn't have to wait it out.
  ha.ensureConnected();

  socket.onopen = async () => {
    try {
      await ensureAgentBroadcast();
    } catch (err) {
      console.error("[ws] broadcast setup failed:", err);
      socket.send(JSON.stringify({ type: "error", message: "agent unavailable" }));
    }
  };

  socket.onmessage = async (ev) => {
    let msg: { type: string; text?: string };
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
    catch { return; }

    if (msg.type === "hello") {
      try {
        await ensureAgentBroadcast();
        const session = await getAgentSession(ha);
        socket.send(JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) }));
        // Bootstrap the entity catalog over the WS. After this, state_change
        // frames are pushed for every HA state_changed event.
        socket.send(JSON.stringify({ type: "states_snapshot", states: serializeStates() }));
        socket.send(await buildAreasFrame());
        // Initial health frame; further updates are pushed when HA connection
        // state flips or the periodic LLM probe transitions ok ↔ bad.
        socket.send(JSON.stringify({ type: "health", health: buildHealth() }));
        const warmup = getLastWarmup();
        if (warmup) {
          socket.send(JSON.stringify({ type: "cache_warmed", at: warmup.at, durationMs: warmup.durationMs }));
        }
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: (err as Error).message }));
      }
      return;
    }

    if (msg.type === "prompt") {
      const text = msg.text?.trim();
      if (!text) return;
      if (!ha.isConnected) {
        socket.send(JSON.stringify({ type: "error", message: "Not connected to Home Assistant" }));
        return;
      }
      console.log(`[query] ${text}`);
      await ensureAgentBroadcast();
      submitPrompt(text, ha);
      return;
    }

    if (msg.type === "abort") {
      try {
        const session = await getAgentSession(ha);
        session.agent.abort();
      } catch (err) {
        console.error("[ws] abort failed:", err);
      }
      return;
    }

    if (msg.type === "get_settings") {
      const settings = await loadSettings();
      socket.send(JSON.stringify({
        type: "settings",
        settings,
        all_tools: ALL_TOOL_NAMES,
      }));
      return;
    }

    if (msg.type === "set_settings") {
      const incoming = (msg as unknown as { settings: { enabledTools?: ToolName[]; contextWindow?: number; allowUnexposedWrites?: boolean; conversationCapMb?: number } }).settings;
      const saved = await saveSettings(incoming);
      // Refresh AGENTS.md *before* rebuilding the session — the new agent reads
      // .pi-agent/AGENTS.md on construction, so a stale file would leave it
      // unaware of the just-flipped disabled-tool set until the next reconnect.
      await regenerateCatalog();
      // Tool changes only take effect on a fresh session — recreate, re-wire the
      // broadcast onto the new agent (recreateAgentSession nulls the old one), and
      // push a snapshot so every client sees the cleared state.
      await recreateAgentSession();
      // Trim sessions after any settings change — ensures we stay under the cap
      // even if files grew between saves (e.g. many long agent turns).
      const trimCount = await trimSessions(saved.conversationCapMb * 1_048_576);
      if (trimCount) console.log(`[settings] trimmed ${trimCount} session file(s)`);
      await ensureAgentBroadcast();
      const session = await getAgentSession(ha);
      const snapshotFrame = JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) });
      const settingsFrame = JSON.stringify({ type: "settings", settings: saved, all_tools: ALL_TOOL_NAMES });
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(snapshotFrame);
          ws.send(settingsFrame);
        }
      }
      console.log(`[settings] enabled tools: ${saved.enabledTools.join(", ")}`);
      return;
    }

    if (msg.type === "set_model") {
      const id = (msg as unknown as { model_id?: unknown }).model_id;
      if (typeof id !== "string" || !id) {
        socket.send(JSON.stringify({ type: "error", message: "set_model: model_id required" }));
        return;
      }
      try {
        await setActiveModel(id);
        // Session was reset; build a fresh one + broadcast snapshot so every
        // client sees state.model flip to the new id.
        await ensureAgentBroadcast();
        const session = await getAgentSession(ha);
        const snap = JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) });
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(snap);
        }
        console.log(`[castle] active model set to ${id}`);
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `set_model failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "service_call") {
      // Direct UI-initiated service call (entity card toggles, sliders, etc.).
      // Goes through the same HA WS connection the agent uses for
      // ha_call_service, but skips the agent loop entirely — no LLM round-
      // trip, no permission filter, no truncation. Used by interactive
      // entity cards to mutate state on click. Errors come back to the
      // caller via the returned ack frame so the card can revert its
      // optimistic UI.
      const m = msg as unknown as {
        id?: string;
        domain?: string;
        service?: string;
        entity_id?: string;
        service_data?: Record<string, unknown>;
      };
      if (typeof m.domain !== "string" || typeof m.service !== "string") {
        socket.send(JSON.stringify({ type: "service_call_ack", id: m.id, ok: false, error: "domain + service required" }));
        return;
      }
      try {
        await ha.callService(
          m.domain,
          m.service,
          m.entity_id ? { entity_id: m.entity_id } : undefined,
          m.service_data,
        );
        socket.send(JSON.stringify({ type: "service_call_ack", id: m.id, ok: true }));
      } catch (err) {
        socket.send(JSON.stringify({ type: "service_call_ack", id: m.id, ok: false, error: (err as Error).message }));
      }
      return;
    }

    if (msg.type === "set_exposure") {
      const payload = msg as unknown as { entity_ids?: string[]; expose?: boolean };
      const ids = Array.isArray(payload.entity_ids) ? payload.entity_ids.filter((s) => typeof s === "string") : [];
      if (ids.length === 0 || typeof payload.expose !== "boolean") {
        socket.send(JSON.stringify({ type: "error", message: "set_exposure: entity_ids[] and expose:boolean required" }));
        return;
      }
      try {
        await ha.setExposed(ids, payload.expose);
        // Push the catalog refresh in the background so the agent's next prompt
        // sees the new exposed list. Don't await — UI doesn't need to wait.
        regenerateCatalog().catch((err) => console.warn("[exposure] catalog refresh failed:", err));
        socket.send(JSON.stringify({ type: "exposure_updated", entity_ids: ids, expose: payload.expose }));
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `set_exposure failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "warm_cache") {
      if (!ha.isConnected) {
        socket.send(JSON.stringify({ type: "error", message: "Not connected to Home Assistant" }));
        return;
      }
      const result = await warmupPromptCache(ha);
      if (result) {
        broadcastCacheWarmed(result);
      } else {
        socket.send(JSON.stringify({ type: "error", message: "warm_cache failed" }));
      }
      return;
    }

    if (msg.type === "regenerate_catalog") {
      try {
        await regenerateCatalog();
        // Tear the agent down so the next prompt builds against the fresh
        // .pi-agent/AGENTS.md system prompt — the running session has the
        // old catalog cached in its message history otherwise.
        await recreateAgentSession();
        await ensureAgentBroadcast();
        const session = await getAgentSession(ha);
        const snapshot = JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) });
        const areasFrame = await buildAreasFrame();
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(snapshot);
            ws.send(areasFrame);
          }
        }
        socket.send(JSON.stringify({ type: "catalog_regenerated" }));
        console.log("[ws] catalog manually regenerated");
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `regenerate_catalog failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "reset") {
      try {
        await newConversation();
        await ensureAgentBroadcast();
        // Broadcast a fresh snapshot to ALL connected clients so every browser sees the cleared state.
        const session = await getAgentSession(ha);
        const snapshot = JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) });
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(snapshot);
        }
        console.log("[ws] session reset");
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `reset failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "list_sessions") {
      try {
        const sessions = await listSessions();
        socket.send(JSON.stringify({ type: "sessions_list", sessions }));
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `list_sessions failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "resume_session") {
      const path = (msg as unknown as { path?: string }).path;
      if (typeof path !== "string" || !path) {
        socket.send(JSON.stringify({ type: "error", message: "resume_session: path required" }));
        return;
      }
      try {
        await resumeSession(path);
        await ensureAgentBroadcast();
        const session = await getAgentSession(ha);
        const snapshot = JSON.stringify({ type: "snapshot", state: serializeSnapshot(session) });
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(snapshot);
        }
        socket.send(JSON.stringify({ type: "session_resumed", path }));
        console.log(`[ws] session resumed: ${path}`);
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `resume_session failed: ${(err as Error).message}` }));
      }
      return;
    }

    if (msg.type === "delete_session") {
      const path = (msg as unknown as { path?: string }).path;
      if (typeof path !== "string" || !path) {
        socket.send(JSON.stringify({ type: "error", message: "delete_session: path required" }));
        return;
      }
      try {
        const deleted = await deleteSession(path);
        if (!deleted) {
          socket.send(JSON.stringify({ type: "error", message: "session not found or is the active session" }));
          return;
        }
        // Refresh the list for all clients.
        const sessions = await listSessions();
        const frame = JSON.stringify({ type: "sessions_list", sessions });
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        }
        socket.send(JSON.stringify({ type: "session_deleted", path }));
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", message: `delete_session failed: ${(err as Error).message}` }));
      }
      return;
    }
  };

  socket.onclose = () => { sockets.delete(socket); };
  socket.onerror = () => { sockets.delete(socket); };
}

await writeModelsJson();
setupHaSupervisor(); // wires HAClient's auto-reconnect loop; runs in background
startLlmProbe();     // periodically pings LLM_URL/models so the UI bubble reflects reality
Deno.serve({ port: PORT }, handler);
