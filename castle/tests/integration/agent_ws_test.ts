// Integration tests: connect to a running Castle server, drive the agent over /ws,
// assert read-only behavior. Skips gracefully if the server or HA isn't reachable.
//
// Required: Castle listening at $CASTLE_WS_URL (default ws://localhost:7090/ws), HA up,
// LM Studio reachable from the server.
//
// Run: deno task test:integration

import { assert, assertEquals } from "jsr:@std/assert@1";
import { findDemoCamera, getHaBaseUrl } from "./shared.ts";

const WS_URL = Deno.env.get("CASTLE_WS_URL") ?? "ws://localhost:7090/ws";
const WEATHER_ENTITY = Deno.env.get("CASTLE_TEST_WEATHER_ENTITY") ?? "weather.forecast_home";
const TIMEOUT_MS = Number(Deno.env.get("CASTLE_TEST_TIMEOUT_MS") ?? 90_000);

interface AgentEvent {
  type: string;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
}

async function reachable(): Promise<boolean> {
  try {
    const ws = new WebSocket(WS_URL);
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(false); }, 2000);
      ws.onopen = () => { clearTimeout(t); resolve(true); };
      ws.onerror = () => { clearTimeout(t); resolve(false); };
    });
    if (ok) {
      const closed = new Promise<void>((r) => { ws.onclose = () => r(); });
      ws.close();
      await closed;
    }
    return ok;
  } catch {
    return false;
  }
}

async function findCameraEntity(): Promise<string | null> {
  const explicit = Deno.env.get("CASTLE_TEST_CAMERA_ENTITY");
  if (explicit) return explicit;
  // Castle has no /states REST route; ask HA directly via the shared helper,
  // which authenticates with HA_TOKEN and pulls /api/states.
  return await findDemoCamera(getHaBaseUrl());
}

/** Open /ws, hello → snapshot → reset → snapshot → prompt → drain events until
 *  agent_end, then close cleanly. The reset between snapshots keeps this test
 *  isolated from history accumulated by earlier files in the same run. */
async function runConversation(prompt: string, timeoutMs = TIMEOUT_MS): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const ws = new WebSocket(WS_URL);
  const done = Promise.withResolvers<AgentEvent[]>();
  let agentEnded = false;
  let errorMessage: string | null = null;
  let resetSent = false;
  let promptSent = false;
  const timeout = setTimeout(() => {
    try { ws.close(); } catch { /* */ }
    done.reject(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello" }));
  ws.onmessage = (ev) => {
    const frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    if (frame.type === "snapshot") {
      if (!resetSent) {
        resetSent = true;
        ws.send(JSON.stringify({ type: "reset" }));
      } else if (!promptSent) {
        promptSent = true;
        ws.send(JSON.stringify({ type: "prompt", text: prompt }));
      }
    } else if (frame.type === "event") {
      events.push(frame.event);
      if (frame.event.type === "agent_end") {
        agentEnded = true;
        ws.close();
      }
    } else if (frame.type === "error") {
      errorMessage = frame.message;
      ws.close();
    }
  };
  ws.onclose = () => {
    clearTimeout(timeout);
    if (errorMessage) done.reject(new Error(`server error: ${errorMessage}`));
    else if (!agentEnded) done.reject(new Error("ws closed before agent_end"));
    else done.resolve(events);
  };
  ws.onerror = () => {
    clearTimeout(timeout);
    done.reject(new Error("websocket error"));
  };

  return await done.promise;
}

const serverUp = await reachable();
const cameraEntity = serverUp ? await findCameraEntity() : null;

Deno.test({
  name: "agent answers weather question via ha_get_entity (no mutating tool calls)",
  ignore: !serverUp,
  fn: async () => {
    const events = await runConversation(
      `What does ${WEATHER_ENTITY} report? Use ha_get_entity to inspect it. Answer in one sentence.`,
    );

    const toolStarts = events.filter((e) => e.type === "tool_execution_start");
    const toolNames = toolStarts.map((e) => e.toolName);
    assert(toolStarts.length > 0, `expected at least one tool call, got: ${JSON.stringify(toolNames)}`);
    assert(toolNames.includes("ha_get_entity"), `expected ha_get_entity, got: ${JSON.stringify(toolNames)}`);
    assertEquals(toolNames.filter((n) => n === "ha_call_service" || n === "ha_set_state").length, 0,
      `mutating tool call seen: ${JSON.stringify(toolNames)}`);

    const entityCall = toolStarts.find((e) => e.toolName === "ha_get_entity");
    assert(entityCall, "expected ha_get_entity tool_execution_start");
    assertEquals(entityCall.args?.entity_id, WEATHER_ENTITY);

    const entityEnd = events.find((e) =>
      e.type === "tool_execution_end" && e.toolCallId === entityCall.toolCallId
    );
    assert(entityEnd, "expected tool_execution_end for ha_get_entity");
    assertEquals(entityEnd.isError, false, `ha_get_entity returned an error: ${JSON.stringify(entityEnd.result)}`);

    const lastAssistantEnd = [...events].reverse().find((e) =>
      e.type === "message_end" && e.message?.role === "assistant"
    );
    assert(lastAssistantEnd, "expected an assistant message_end");
    const textBlocks = (lastAssistantEnd.message.content ?? [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");
    assert(textBlocks.length > 0, "assistant message had no text content");
  },
});

Deno.test({
  name: "agent can capture a camera snapshot via ha_get_camera_snapshot",
  ignore: !serverUp || !cameraEntity,
  fn: async () => {
    const events = await runConversation(
      `Use ha_get_camera_snapshot to capture ${cameraEntity}. Briefly confirm whether the capture succeeded.`,
    );

    const toolNames = events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName);
    const snapStart = events.find((e) =>
      e.type === "tool_execution_start" && e.toolName === "ha_get_camera_snapshot"
    );
    assert(snapStart, `ha_get_camera_snapshot was not called. Tools: ${JSON.stringify(toolNames)}`);
    assertEquals(snapStart.args?.entity_id, cameraEntity);

    const snapEnd = events.find((e) =>
      e.type === "tool_execution_end" && e.toolCallId === snapStart.toolCallId
    );
    assert(snapEnd, "expected tool_execution_end for ha_get_camera_snapshot");
    assertEquals(snapEnd.isError, false, `snapshot tool returned error: ${JSON.stringify(snapEnd.result)}`);

    const resultStr = typeof snapEnd.result === "string" ? snapEnd.result : JSON.stringify(snapEnd.result);
    assert(
      resultStr.includes("Snapshot") || resultStr.includes("captured") || resultStr.includes("KB"),
      `unexpected tool result shape: ${resultStr.slice(0, 200)}`,
    );

    assertEquals(toolNames.filter((n) => n === "ha_call_service" || n === "ha_set_state").length, 0,
      `mutating tool call seen: ${JSON.stringify(toolNames)}`);
  },
});
