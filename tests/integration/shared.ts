// Shared infrastructure for integration tests: WS driver, assertion helpers,
// and HA REST API utilities. All tests import from this file.

import { assert, assertEquals } from "jsr:@std/assert@1";

/** Assert that a string contains a substring. */
function assertContains(haystack: string, needle: string, msg?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(msg ?? `Expected "${haystack}" to contain "${needle}"`);
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentEvent {
  type: string;
  event?: Record<string, unknown>;
  message?: Record<string, unknown>;
  args?: Record<string, unknown> | null;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
  states?: Array<{ entity_id: string; state: string }>;
  [k: string]: unknown;
}

interface WsFrame {
  type: string;
  event?: AgentEvent;
  message?: Record<string, unknown>;
  states?: Array<{ entity_id: string; state: string }>;
  error?: string;
  [k: string]: unknown;
}

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown> | null;
  toolCallId: string;
}

export interface AgentRunResult {
  events: AgentEvent[];
  toolCalls: ToolCallRecord[];
  assistantText: string;
}

// ── WS Driver ───────────────────────────────────────────────────────────────

/** Default timeout for a single agent turn (ms). */
export const DEFAULT_TIMEOUT = 30_000;
/** Longer timeout for complex operations (dashboard/automation CRUD). */
export const COMPLEX_TIMEOUT = 60_000;

interface RunConversationOpts {
  /** Override default timeout in ms. */
  timeoutMs?: number;
  /** WS URL — defaults to CASTLE_WS_URL env var or ws://localhost:7092/ws. */
  wsUrl?: string;
}

/**
 * Open /ws, hello → snapshot → prompt → drain until agent_end → close cleanly.
 * Returns structured events and tool call records.
 */
export async function runConversation(
  prompt: string,
  opts: RunConversationOpts = {},
): Promise<AgentRunResult> {
  const wsUrl = opts.wsUrl ?? Deno.env.get("CASTLE_WS_URL") ?? "ws://localhost:7092/ws";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return new Promise<AgentRunResult>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const events: AgentEvent[] = [];
    let agentEnded = false;
    let errorMessage: string | null = null;
    let _snapshotReceived = false;
    let promptSent = false;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* */ }
      reject(new Error(`timed out after ${timeoutMs}ms — agent did not end`));
    }, timeoutMs);

    ws.onopen = () => {
      // hello → wait for snapshot → send prompt
      ws.send(JSON.stringify({ type: "hello" }));
    };

    ws.onmessage = (ev) => {
      const frame: WsFrame = JSON.parse(typeof ev.data === "string" ? ev.data : "");

      if (frame.type === "snapshot") {
        _snapshotReceived = true;
        if (!promptSent) {
          promptSent = true;
          ws.send(JSON.stringify({ type: "prompt", text: prompt }));
        }
      } else if (frame.type === "event") {
        events.push(frame.event!);
        if (frame.event!.type === "agent_end" || frame.event!.type === "auto_retry_start") {
          agentEnded = true;
          ws.close();
        }
      } else if (frame.type === "error") {
        errorMessage = frame.error ?? String(frame.message ?? "unknown error");
        ws.close();
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (errorMessage) reject(new Error(`server error: ${errorMessage}`));
      else if (!agentEnded) reject(new Error("ws closed before agent_end"));
      else resolve(toResult(events));
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("websocket connection error"));
    };
  });
}

function toResult(events: AgentEvent[]): AgentRunResult {
  const toolCalls: ToolCallRecord[] = [];
  for (const e of events) {
    if (e.type === "tool_execution_start") {
      toolCalls.push({
        toolName: String(e.toolName ?? ""),
        args: (e.args as Record<string, unknown> | null) ?? null,
        toolCallId: String(e.toolCallId ?? ""),
      });
    }
  }

  // Last assistant message text
  let assistantText = "";
  for (const e of [...events].reverse()) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const content = e.message.content as Array<{ type: string; text?: string }> | undefined;
      if (content) {
        assistantText = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n");
      }
      break;
    }
  }

  return { events, toolCalls, assistantText };
}

// ── Tool Call Assertions ────────────────────────────────────────────────────

/** Assert that a tool with the given name was called at least once. */
export function assertToolCalled(
  result: AgentRunResult,
  name: string,
  argsMatcher?: (args: Record<string, unknown> | null) => boolean,
): ToolCallRecord {
  const found = result.toolCalls.filter((tc) => tc.toolName === name);
  if (found.length === 0) {
    throw new Error(
      `Expected tool "${name}" to be called. Called tools: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`,
    );
  }
  const match = argsMatcher ? found.find((tc) => argsMatcher(tc.args)) : found[0];
  if (!match && argsMatcher) {
    throw new Error(
      `Expected tool "${name}" called with matching args. Calls: [${found.map((t) => JSON.stringify(t.args)).join(", ")}]`,
    );
  }
  return match ?? found[0];
}

/** Assert that no mutating tools were called. */
export function assertNoMutatingTools(result: AgentRunResult): void {
  const mutating = result.toolCalls.filter((tc) =>
    tc.toolName === "ha_call_service" || tc.toolName === "ha_set_state"
  );
  assertEquals(
    mutating.length,
    0,
    `Expected no mutating tool calls on read-only prompt. Found: [${mutating.map((t) => t.toolName).join(", ")}]`,
  );
}

/** Assert a specific tool was NOT called at all. */
export function assertToolNotCalled(result: AgentRunResult, name: string): void {
  const found = result.toolCalls.filter((tc) => tc.toolName === name);
  assertEquals(found.length, 0, `Expected tool "${name}" NOT to be called, but it was.`);
}

/** Assert that a specific tool call ID had no error. */
export function assertToolSucceeded(result: AgentRunResult, toolCallId: string): void {
  const endEvent = result.events.find(
    (e) => e.type === "tool_execution_end" && String(e.toolCallId ?? "") === toolCallId,
  );
  assert(endEvent, `Expected tool_execution_end for ${toolCallId}`);
  assertEquals(endEvent.isError ?? false, false, `Tool returned error: ${String(endEvent.result)}`);
}

/** Assert the assistant message contains expected text. */
export function assertAssistantContains(result: AgentRunResult, needle: string): void {
  assertContains(
    result.assistantText.toLowerCase(),
    needle.toLowerCase(),
    `Expected assistant response to contain "${needle}". Got:\n${result.assistantText.slice(0, 500)}`,
  );
}

/** Assert at least N total tool calls were made. */
export function assertAtLeastNTotalTools(result: AgentRunResult, n: number): void {
  assert(
    result.toolCalls.length >= n,
    `Expected at least ${n} tool calls, got ${result.toolCalls.length}: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`,
  );
}

/** Assert all expected tools were called (in any order), with optional arg matchers. */
export function assertAllToolsCalled(
  result: AgentRunResult,
  expectations: Array<{ name: string; argsMatcher?: (args: Record<string, unknown> | null) => boolean }>,
): void {
  for (const exp of expectations) {
    assertToolCalled(result, exp.name, exp.argsMatcher);
  }
}

// ── HA REST API Helpers ─────────────────────────────────────────────────────

/** fetch() wrapper that injects HA's Bearer token from HA_TOKEN. ha-demo
 *  rejects unauthenticated /api/* requests with 401 — every helper below
 *  routes through this so a missing or stale token surfaces in one place. */
function haFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = Deno.env.get("HA_TOKEN") ?? "";
  const headers = new Headers(init?.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

/** Query an entity's current state via HA REST API. */
export async function getEntityState(
  haBaseUrl: string,
  entityId: string,
): Promise<{ state: string; attributes: Record<string, unknown> } | null> {
  const url = `${haBaseUrl}/api/states/${encodeURIComponent(entityId)}`;
  try {
    const res = await haFetch(url);
    if (!res.ok) return null;
    const json = await res.json() as { state: string; attributes: Record<string, unknown> };
    return json;
  } catch {
    return null;
  }
}

/** Query all entity states via HA REST API. */
export async function getAllStates(haBaseUrl: string): Promise<Record<string, { state: string; attributes: Record<string, unknown> }>> {
  const url = `${haBaseUrl}/api/states`;
  try {
    const res = await haFetch(url);
    if (!res.ok) return {};
    const json = Array.isArray(await res.json()) ? await res.json() : {};
    const result: Record<string, { state: string; attributes: Record<string, unknown> }> = {};
    for (const s of json as Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>) {
      result[s.entity_id] = { state: s.state, attributes: s.attributes };
    }
    return result;
  } catch {
    return {};
  }
}

/** Assert that an entity's state changed to the expected value. */
export async function assertEntityState(
  haBaseUrl: string,
  entityId: string,
  expectedState: string,
): Promise<void> {
  const state = await getEntityState(haBaseUrl, entityId);
  if (!state) throw new Error(`Entity ${entityId} not found`);
  assertEquals(state.state, expectedState, `Expected ${entityId} to have state "${expectedState}", got "${state.state}"`);
}

/** Assert that an entity has a specific attribute value. */
export async function assertEntityAttribute(
  haBaseUrl: string,
  entityId: string,
  attrName: string,
  expectedValue: unknown,
): Promise<void> {
  const state = await getEntityState(haBaseUrl, entityId);
  if (!state) throw new Error(`Entity ${entityId} not found`);
  assertEquals(
    (state.attributes as Record<string, unknown>)?.[attrName],
    expectedValue,
    `Expected ${entityId}.${attrName} to be ${expectedValue}, got ${(state.attributes as Record<string, unknown>)?.[attrName]}`,
  );
}

/** Wait for an entity state to change (polling) within a timeout. */
export async function waitForEntityState(
  haBaseUrl: string,
  entityId: string,
  expectedState: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getEntityState(haBaseUrl, entityId);
    if (state?.state === expectedState) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Entity ${entityId} did not reach state "${expectedState}" within ${timeoutMs}ms`,
  );
}

/** Discover available entities by domain from the running HA demo. */
export async function getEntitiesByDomain(haBaseUrl: string): Promise<Record<string, string[]>> {
  const allStates = await getAllStates(haBaseUrl);
  const byDomain: Record<string, Set<string>> = {};
  for (const [entityId, _info] of Object.entries(allStates)) {
    const domain = entityId.split(".")[0];
    if (!byDomain[domain]) byDomain[domain] = new Set();
    byDomain[domain].add(entityId);
  }
  return Object.fromEntries(Object.entries(byDomain).map(([k, v]) => [k, [...v].sort()]));
}

/** Get all light entity IDs from HA. */
export async function getLightEntityIds(haBaseUrl: string): Promise<string[]> {
  const domains = await getEntitiesByDomain(haBaseUrl);
  return (domains.light ?? []).sort();
}

/** Get all switch entity IDs from HA. */
export async function getSwitchEntityIds(haBaseUrl: string): Promise<string[]> {
  const domains = await getEntitiesByDomain(haBaseUrl);
  return (domains.switch ?? []).sort();
}

// ── Dashboard Helpers ───────────────────────────────────────────────────────

/** List dashboards via HA REST API. */
export async function listDashboards(haBaseUrl: string): Promise<Array<{ slug: string; name: string }>> {
  try {
    const res = await haFetch(`${haBaseUrl}/api/config/dashboard/list`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json) ? json : (json.dashboards ?? []);
  } catch {
    return [];
  }
}

/** Fetch raw dashboard YAML via HA REST API. */
export async function getDashboardRaw(
  haBaseUrl: string,
  slugOrPath: string,
): Promise<string | null> {
  try {
    const res = await haFetch(`${haBaseUrl}/api/config/dashboard/raw/${slugOrPath}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Fetch dashboard JSON config. */
export async function getDashboardConfig(
  haBaseUrl: string,
  slugOrPath: string,
): Promise<unknown | null> {
  try {
    const res = await haFetch(`${haBaseUrl}/api/config/dashboard/raw/${slugOrPath}`);
    if (!res.ok) return null;
    const yamlText = await res.text();
    // Try to parse as JSON first (some dashboards store JSON)
    try {
      return JSON.parse(yamlText);
    } catch { /* not JSON */ }
    return null;
  } catch {
    return null;
  }
}

// ── Automation Helpers ──────────────────────────────────────────────────────

/** List automations via HA REST API. */
export async function listAutomations(haBaseUrl: string): Promise<Array<{ id: number | string; name: string; entity_id: string }>> {
  try {
    const res = await haFetch(`${haBaseUrl}/api/config/automation/list`);
    if (!res.ok) return [];
    return (await res.json()) as Array<{ id: number | string; name: string; entity_id: string }>;
  } catch {
    return [];
  }
}

/** Fetch automation config by ID. */
export async function getAutomationConfig(
  haBaseUrl: string,
  automationId: number | string,
): Promise<unknown | null> {
  try {
    const res = await haFetch(`${haBaseUrl}/api/config/automation/${encodeURIComponent(String(automationId))}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Update automation config via HA REST API (for post-test verification). */
export async function updateAutomationConfig(
  haBaseUrl: string,
  automationId: number | string,
  config: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await haFetch(
      `${haBaseUrl}/api/config/automation/${encodeURIComponent(String(automationId))}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ── Port Resolution ─────────────────────────────────────────────────────────

/** Resolve the HA base URL for tests.
 *
 * Prefer HA_URL (set by the runner to http://ha-demo:8123 — the docker-network
 * service name castle itself uses). Fall back to localhost:CASTLE_TEST_HA_PORT
 * for cases where the harness runs on the host outside any container. */
export function getHaBaseUrl(): string {
  const url = Deno.env.get("HA_URL");
  if (url) return url.replace(/\/$/, "");
  const port = Deno.env.get("CASTLE_TEST_HA_PORT") ?? "9123";
  return `http://localhost:${port}`;
}

// ── Test Discovery Helper ───────────────────────────────────────────────────

/** Find a light entity ID from the running HA demo. */
export async function findDemoLight(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const lights = await getLightEntityIds(base);
  return lights.length > 0 ? lights[0] : null;
}

/** Find a switch entity ID from the running HA demo. */
export async function findDemoSwitch(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const switches = await getSwitchEntityIds(base);
  return switches.length > 0 ? switches[0] : null;
}

/** Find a camera entity ID from the running HA demo. */
export async function findDemoCamera(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const domains = await getEntitiesByDomain(base);
  const cameras = (domains.camera ?? []).sort();
  return cameras.length > 0 ? cameras[0] : null;
}

/** Find a climate entity ID from the running HA demo. */
export async function findDemoClimate(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const domains = await getEntitiesByDomain(base);
  const climates = (domains.climate ?? []).sort();
  return climates.length > 0 ? climates[0] : null;
}

/** Find a sensor entity ID from the running HA demo. */
export async function findDemoSensor(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const domains = await getEntitiesByDomain(base);
  const sensors = (domains.sensor ?? []).sort();
  return sensors.length > 0 ? sensors[0] : null;
}

/** Find a binary sensor entity ID from the running HA demo. */
export async function findDemoBinarySensor(haBaseUrl?: string): Promise<string | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const domains = await getEntitiesByDomain(base);
  const sensors = (domains.binary_sensor ?? []).sort();
  return sensors.length > 0 ? sensors[0] : null;
}

/** Find an automation ID from the running HA demo. */
export async function findDemoAutomation(haBaseUrl?: string): Promise<{ id: number | string; entity_id: string } | null> {
  const base = haBaseUrl ?? getHaBaseUrl();
  const automations = await listAutomations(base);
  return automations.length > 0 ? automations[0] : null;
}
