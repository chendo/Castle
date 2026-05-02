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
import { formatStates } from "./catalog.ts";

const AGENT_DIR = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
const CWD = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

const authStorage = AuthStorage.create(`${AGENT_DIR}/auth.json`);

// deno-lint-ignore no-explicit-any
function getQwenModel(): any {
  const registry = ModelRegistry.create(authStorage, `${AGENT_DIR}/models.json`);
  const err = registry.getError();
  if (err) throw new Error(`models.json error: ${err}`);
  // deno-lint-ignore no-explicit-any
  const models = (registry as any).models as Array<{ provider: string; id: string }>;
  const model = models.find((m) => m.provider === "lmstudio");
  if (!model) throw new Error("lmstudio model not found — check .pi-agent/models.json");
  console.log(`[agent] using model: ${model.provider}/${model.id}`);
  return model;
}

let sessionPromise: Promise<AgentSession> | null = null;

async function buildHomeStateText(ha: HAClient): Promise<string> {
  const exposedList = await ha.getExposedEntities();
  const exposed = exposedList ? new Set(exposedList) : undefined;
  return formatStates(ha.getAllStates(), exposed);
}

export function getAgentSession(ha: HAClient): Promise<AgentSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const result = await createAgentSession({
        cwd: CWD,
        agentDir: AGENT_DIR,
        authStorage,
        model: getQwenModel(),
        noTools: "builtin",
        tools: ["ha_call_service", "ha_fire_event", "ha_set_state", "ha_get_states", "ha_get_entity", "ha_get_history"],
        customTools: buildTools(ha),
        sessionManager: SessionManager.inMemory(),
        settingsManager: SettingsManager.inMemory({
          compaction: {
            enabled: true,
            reserveTokens: 4096,
            keepRecentTokens: 8192,
          },
        }),
        thinkingLevel: "low",
      });

      // Append metadata to the latest user message at LLM-call time only:
      // - Current time (every turn, since it changes)
      // - Current home state (first turn only; after that the agent uses ha_get_states)
      // transformContext mutates only what the LLM sees, so stored messages — and the UI —
      // keep showing the user's clean text.
      let homeStateInjected = false;
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

        const blocks: string[] = [`\n\nCurrent time: ${now} (${tz})`];

        if (!homeStateInjected) {
          homeStateInjected = true;
          const stateText = await buildHomeStateText(ha);
          blocks.push(`\nCurrent home state:\n${stateText}`);
        }

        const append = blocks.join("\n");
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
 * session so the next prompt starts fresh — including a re-injection of
 * "Current home state" on the new first turn.
 */
export async function resetAgentSession(): Promise<void> {
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
