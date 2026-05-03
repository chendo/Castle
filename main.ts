import type { AgentEvent } from "npm:@mariozechner/pi-agent-core";
import { HAClient } from "./ha-client.ts";
import { buildAgentsMd, buildCatalogData, buildServicesData, extractDomains } from "./catalog.ts";
import { getAgentSession, resetAgentSession, submitPrompt } from "./agent.ts";
import { parseHistoryPoints } from "./tools.ts";
import { ALL_TOOL_NAMES, loadSettings, saveSettings, type ToolName } from "./settings.ts";

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "7090");
const AUTH_TOKEN = Deno.env.get("HAI_AUTH_TOKEN") ?? "";

const ha = new HAClient(HA_URL, HA_TOKEN);

let lastQueryAt: number | null = null;
let queryCount = 0;

// Some OpenAI-compat servers (LM Studio, vLLM with --enable-vision-info) expose
// per-model capability metadata at /api/v0/models/<id>: `type: "vlm"` or a
// `vision: true` flag means the model accepts image input. Returns ["text",
// "image"] when reported, ["text"] otherwise. Falls back to text-only on any
// error so startup never blocks against a server that doesn't implement /api/v0.
async function detectModelInput(baseUrl: string, apiKey: string, modelId: string): Promise<string[]> {
  // baseUrl is the OpenAI-compat URL ending in /v1 — the metadata API lives at /api/v0
  const restBase = baseUrl.replace(/\/v1\/?$/, "") + "/api/v0";
  const headers = { Authorization: `Bearer ${apiKey}` };
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
    // Fallback: list endpoint, in case the per-id route isn't available
    const listRes = await fetch(`${restBase}/models`, { headers, signal: AbortSignal.timeout(2000) });
    if (!listRes.ok) throw new Error(`models list ${listRes.status}`);
    const list = await listRes.json() as { data?: Array<{ id: string; type?: string; vision?: boolean }> };
    const found = list.data?.find((m) => m.id === modelId);
    if (found && (found.vision === true || found.type === "vlm")) return ["text", "image"];
    return ["text"];
  } catch (err) {
    console.warn(`[hai] capability probe failed (${(err as Error).message}); assuming text-only`);
    return ["text"];
  }
}

async function writeModelsJson(): Promise<void> {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  const url = Deno.env.get("OPENAI_URL") ?? "http://localhost:1234/v1";
  const modelId = Deno.env.get("MODEL_NAME");
  if (!modelId) throw new Error("MODEL_NAME env var is required");
  const input = await detectModelInput(url, key, modelId);
  console.log(`[hai] model ${modelId} input modalities: ${input.join(", ")}`);
  // Seed contextWindow from the same env var settings.ts reads. The value is
  // overwritten per-session from settings.json before the agent runs, so this
  // is just a sane initial value for the registry parse.
  const seedContextWindow = (() => {
    const fromEnv = Number(Deno.env.get("MODEL_CONTEXT_WINDOW"));
    return Number.isFinite(fromEnv) && fromEnv >= 8192 ? fromEnv : 65536;
  })();
  const config = {
    providers: {
      local: {
        baseUrl: url,
        api: "openai-completions",
        apiKey: key,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          {
            id: modelId,
            name: modelId,
            contextWindow: seedContextWindow,
            maxTokens: 4096,
            reasoning: false,
            input,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  const agentDir = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
  await Deno.writeTextFile(`${agentDir}/models.json`, JSON.stringify(config, null, 2));
}

async function regenerateCatalog(): Promise<void> {
  try {
    const exposedList = await ha.getExposedEntities();
    const exposed = exposedList ? new Set(exposedList) : undefined;
    const areas = await ha.getAreas();
    const houseInfo = await ha.getHouseInfo();
    const services = await ha.getServices();
    const states = ha.getAllStates();
    const exposedStates = exposed ? states.filter((s) => exposed.has(s.entity_id)) : states;
    const presentDomains = extractDomains(exposedStates);
    const servicesData = buildServicesData(services, presentDomains);
    const catalogData = buildCatalogData(states, exposed, areas);
    const agentsMd = buildAgentsMd({ houseInfo, services: servicesData, catalog: catalogData });
    const agentDir = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
    await Deno.writeTextFile(`${agentDir}/AGENTS.md`, agentsMd);
    console.log(`[hai] catalog refreshed (${exposed ? exposed.size : 'all'} entities, ${Object.keys(services).length} service domains)`);
  } catch (err) {
    console.error(`[hai] catalog refresh failed:`, (err as Error).message);
  }
}

async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ha.connect();
      const exposedList = await ha.getExposedEntities();
      const exposed = exposedList ? new Set(exposedList) : undefined;
      // Write static entity catalog to AGENTS.md once connected — this becomes the cached system prompt
      await regenerateCatalog();
      console.log(`[hai] ready (${exposed ? exposed.size : 'all'} entities)`);

      // Regenerate catalog every 5 minutes to pick up area/entity changes
      setInterval(regenerateCatalog, 5 * 60 * 1000);
      return;
    } catch (err) {
      console.error(`[hai] connection attempt ${attempt} failed:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
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
    return Response.json({
      ok: ha.isConnected,
      entities: ha.getAllStates().length,
      ws_clients: sockets.size,
      query_count: queryCount,
      last_query_at: lastQueryAt ? new Date(lastQueryAt).toISOString() : null,
      auth_required: AUTH_TOKEN !== "",
    });
  }

  if (url.pathname === "/states" && req.method === "GET") {
    const states = ha.getAllStates();
    return Response.json(states.map(s => ({
      entity_id: s.entity_id,
      state: s.state,
      attributes: s.attributes,
      domain: s.entity_id.split(".")[0],
      exposed: ha.isExposed(s.entity_id),
    })));
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
// Tracked per-agent: resetAgentSession() rebuilds the agent, so a single
// module-level "wired" boolean would leave the new agent unsubscribed and the
// browser would silently miss every event from then on (fixed by full refresh,
// which loads the new state via the hello snapshot — exactly the symptom we hit).
const broadcastWiredAgents = new WeakSet<object>();

async function ensureAgentBroadcast(): Promise<void> {
  const session = await getAgentSession(ha);
  if (broadcastWiredAgents.has(session.agent)) return;
  broadcastWiredAgents.add(session.agent);
  session.agent.subscribe((event: AgentEvent) => {
    const frame = JSON.stringify({ type: "event", event });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch (err) { console.error("[ws] send failed:", err); }
      }
    }
  });
  console.log("[ws] agent broadcast wired");
}

function serializeSnapshot(session: Awaited<ReturnType<typeof getAgentSession>>) {
  const s = session.agent.state;
  return {
    messages: s.messages,
    streamingMessage: s.streamingMessage,
    isStreaming: s.isStreaming,
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
      lastQueryAt = Date.now();
      queryCount++;
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
      const incoming = (msg as unknown as { settings: { enabledTools?: ToolName[]; contextWindow?: number; allowUnexposedWrites?: boolean } }).settings;
      const saved = await saveSettings(incoming);
      // Tool changes only take effect on a fresh session — reset, re-wire the
      // broadcast onto the new agent (resetAgentSession nulls the old one), and
      // push a snapshot so every client sees the cleared state.
      await resetAgentSession();
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

    if (msg.type === "reset") {
      try {
        await resetAgentSession();
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
  };

  socket.onclose = () => sockets.delete(socket);
  socket.onerror = () => sockets.delete(socket);
}

await writeModelsJson();
connectWithRetry(); // background — server starts immediately
Deno.serve({ port: PORT }, handler);
