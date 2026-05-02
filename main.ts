import type { AgentEvent } from "npm:@mariozechner/pi-agent-core";
import { HAClient } from "./ha-client.ts";
import { buildAgentsMd, buildCatalog, buildServicesMd, extractDomains } from "./catalog.ts";
import { getAgentSession, resetAgentSession, submitPrompt } from "./agent.ts";
import { parseHistoryPoints } from "./tools.ts";

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123/";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "7090");
const AUTH_TOKEN = Deno.env.get("HAI_AUTH_TOKEN") ?? "";

const ha = new HAClient(HA_URL, HA_TOKEN);

let lastQueryAt: number | null = null;
let queryCount = 0;

function writeModelsJson(): void {
  const key = Deno.env.get("LM_STUDIO_API_KEY") ?? "lm-studio";
  const url = Deno.env.get("LM_STUDIO_URL") ?? "http://host.docker.internal:1234/v1";
  const config = {
    providers: {
      lmstudio: {
        baseUrl: url,
        api: "openai-completions",
        apiKey: key,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          {
            id: "unsloth/qwen3.6-35b-a3b",
            name: "Qwen3 35B (Local)",
            contextWindow: 32768,
            maxTokens: 4096,
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  const agentDir = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
  Deno.writeTextFileSync(`${agentDir}/models.json`, JSON.stringify(config, null, 2));
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
    const servicesMd = buildServicesMd(services, presentDomains);
    const catalogMd = buildCatalog(states, exposed, areas);
    const agentsMd = buildAgentsMd(catalogMd, { houseInfo, servicesMd });
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
let agentBroadcastSetup = false;

async function setupAgentBroadcast(): Promise<void> {
  if (agentBroadcastSetup) return;
  agentBroadcastSetup = true;
  const session = await getAgentSession(ha);
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
      await setupAgentBroadcast();
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

    if (msg.type === "reset") {
      try {
        await resetAgentSession();
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

writeModelsJson();
connectWithRetry(); // background — server starts immediately
Deno.serve({ port: PORT }, handler);
