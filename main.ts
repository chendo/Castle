import type { AgentEvent } from "npm:@mariozechner/pi-agent-core";
import { HAClient } from "./ha-client.ts";
import { buildCatalog, buildAgentsMd } from "./catalog.ts";
import { getAgentSession, submitPrompt } from "./agent.ts";

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123/";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "7090");

const ha = new HAClient(HA_URL, HA_TOKEN);

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
    const agentsMd = buildAgentsMd(buildCatalog(ha.getAllStates(), exposed, areas), houseInfo);
    const agentDir = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
    await Deno.writeTextFile(`${agentDir}/AGENTS.md`, agentsMd);
    console.log(`[hai] catalog refreshed (${exposed ? exposed.size : 'all'} entities)`);
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

  if (req.method === "GET") {
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;
  }

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 400 });
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
  };

  socket.onclose = () => sockets.delete(socket);
  socket.onerror = () => sockets.delete(socket);
}

writeModelsJson();
connectWithRetry(); // background — server starts immediately
Deno.serve({ port: PORT }, handler);
