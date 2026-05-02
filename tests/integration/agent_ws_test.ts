// Integration test: connects to a running hai server, asks the LLM about a
// weather entity, and asserts the response is sane and read-only.
//
// Requires:
//   - hai server reachable at $HAI_URL (default ws://localhost:7090/ws inside container, ws://localhost:7091/ws from host)
//   - LM Studio reachable from the server
//   - HA exposing weather.forecast_home (or set $HAI_TEST_WEATHER_ENTITY)
//
// Skip behavior: if $HAI_URL or the server is unreachable, the test skips
// rather than failing — pre-commit shouldn't block when LM Studio is offline.
//
// Run: deno task test:integration  (defined in deno.json)

import { assert, assertEquals } from "jsr:@std/assert@1";

const WS_URL = Deno.env.get("HAI_WS_URL") ?? "ws://localhost:7090/ws";
const WEATHER_ENTITY = Deno.env.get("HAI_TEST_WEATHER_ENTITY") ?? "weather.forecast_home";
const TIMEOUT_MS = Number(Deno.env.get("HAI_TEST_TIMEOUT_MS") ?? 60_000);

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
    if (ok) ws.close();
    return ok;
  } catch {
    return false;
  }
}

Deno.test({
  name: "agent answers weather question via ha_get_entity (no mutating tool calls)",
  ignore: !await reachable(),
  fn: async () => {
    const ws = new WebSocket(WS_URL);
    const events: AgentEvent[] = [];
    let snapshotReceived = false;
    const done = Promise.withResolvers<void>();
    const timeout = setTimeout(() => done.reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello" }));
    };

    ws.onmessage = (ev) => {
      const frame = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      if (frame.type === "snapshot") {
        snapshotReceived = true;
        ws.send(JSON.stringify({
          type: "prompt",
          text: `What does ${WEATHER_ENTITY} report? Use ha_get_entity to inspect it. Answer in one sentence.`,
        }));
      } else if (frame.type === "event") {
        events.push(frame.event);
        if (frame.event.type === "agent_end") {
          clearTimeout(timeout);
          ws.close();
          done.resolve();
        }
      } else if (frame.type === "error") {
        clearTimeout(timeout);
        ws.close();
        done.reject(new Error(`server error: ${frame.message}`));
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      done.reject(new Error("websocket error"));
    };

    await done.promise;

    assert(snapshotReceived, "expected snapshot from /ws hello handshake");

    // Tool calls — must include at least one ha_get_entity, must NOT include any mutators.
    const toolStarts = events.filter((e) => e.type === "tool_execution_start");
    const toolNames = toolStarts.map((e) => e.toolName);
    assert(toolStarts.length > 0, `expected at least one tool call, got: ${JSON.stringify(toolNames)}`);
    assert(toolNames.includes("ha_get_entity"), `expected ha_get_entity, got: ${JSON.stringify(toolNames)}`);
    assertEquals(toolNames.filter((n) => n === "ha_call_service" || n === "ha_set_state").length, 0,
      `mutating tool call seen: ${JSON.stringify(toolNames)}`);

    // ha_get_entity targeted the right entity.
    const entityCall = toolStarts.find((e) => e.toolName === "ha_get_entity");
    assert(entityCall, "expected ha_get_entity tool_execution_start");
    assertEquals(entityCall.args?.entity_id, WEATHER_ENTITY);

    // Tool succeeded.
    const entityEnd = events.find((e) =>
      e.type === "tool_execution_end" && e.toolCallId === entityCall.toolCallId
    );
    assert(entityEnd, "expected tool_execution_end for ha_get_entity");
    assertEquals(entityEnd.isError, false, `ha_get_entity returned an error: ${JSON.stringify(entityEnd.result)}`);

    // Final assistant message contains text.
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
