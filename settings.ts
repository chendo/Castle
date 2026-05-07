// Lightweight settings store backed by .pi-agent/settings.json.
// Single user, single file — no concurrency concerns.

const SETTINGS_PATH = new URL(".pi-agent/settings.json", import.meta.url).pathname;

export const ALL_TOOL_NAMES = [
  "ha_call_service",
  "ha_fire_event",
  "ha_set_state",
  "ha_get_states",
  "ha_get_entity",
  "ha_get_history",
  "ha_get_camera_snapshot",
  "ha_get_logs",
  "ha_get_notifications",
  "ha_list_dashboards",
  "ha_get_dashboard",
  "ha_edit_dashboard",
  "ha_render_chart",
  "ha_present_card",
  "ha_get_automation",
  "ha_update_automation",
  "ha_get_automation_trace",
  "castle_timeline_mute",
  "schedule_task",
  "list_tasks",
  "cancel_task",
] as const;
export type ToolName = typeof ALL_TOOL_NAMES[number];

// Short, agent-facing summaries of what each tool would do. Surfaced in the
// system prompt for tools the user has *disabled*, so the agent can tell the
// user which capability they'd need to re-enable to fulfil a request.
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  ha_call_service: "control devices / call HA services (turn_on, set_temperature, etc.)",
  ha_fire_event: "fire arbitrary HA events on the bus",
  ha_set_state: "write an entity's state directly (bypasses the service layer)",
  ha_get_states: "list / search entities and read their current state",
  ha_get_entity: "inspect one entity's attributes and capabilities",
  ha_get_history: "fetch historical sensor / state data",
  ha_get_camera_snapshot: "capture a still image from a camera entity",
  ha_get_logs: "read recent HA system / integration logs",
  ha_get_notifications: "read active persistent notifications",
  ha_list_dashboards: "list all Lovelace dashboards (url_path + title)",
  ha_get_dashboard: "fetch a Lovelace dashboard's config",
  ha_edit_dashboard: "modify a Lovelace dashboard's config",
  ha_render_chart: "render a chart from historical data",
  ha_present_card: "render an entity card (camera live feed, light controls, sensor badge, …) inline in the chat",
  ha_get_automation: "fetch an automation's YAML config",
  ha_update_automation: "create or modify automations",
  ha_get_automation_trace: "inspect a recent automation run to see why it did or didn't fire",
  castle_timeline_mute: "mute or unmute specific entities from the dashboard's Activity timeline (chatty entities the user explicitly wants hidden)",
  schedule_task: "set up a scheduled / triggered task (reminders, recurring checks, watch a camera or sensor and notify on a condition)",
  list_tasks: "list all scheduled tasks the home agent is currently watching",
  cancel_task: "stop a watching task by id",
};

export interface Settings {
  enabledTools: ToolName[];
  // LLM context window in tokens. Drives compaction thresholds in the agent.
  // Floored at 8k so things still work; no upper bound — user knows their backend.
  contextWindow: number;
  /**
   * When false (default), the agent's write tools (ha_call_service, ha_set_state)
   * refuse to target entities that aren't in HA's "exposed to assistants" list.
   * When true, the gate is lifted and the agent can mutate any entity it knows
   * about. Reads (ha_get_states, ha_get_history, ha_get_entity) are never gated.
   */
  allowUnexposedWrites: boolean;
  /**
   * Disk cap (in megabytes) for the .pi-agent/sessions/ JSONL store. Trimmed
   * oldest-first whenever the cap is exceeded; the active session is never
   * deleted. Floored at 10 MiB; no upper bound.
   */
  conversationCapMb: number;
  /**
   * Entities the user doesn't want surfaced in the dashboard activity
   * timeline. Set via `castle_timeline_mute` (agent tool). De-duplicated and
   * filtered on save.
   */
  timelineMutes: string[];
}

// 64k chosen per the roadmap; modern open-weights models comfortably support it.
// MODEL_CONTEXT_WINDOW env var lets a deployment change the seed default without
// touching settings.json (settings.json still wins once a value is saved there).
const DEFAULT_CONTEXT_WINDOW = (() => {
  const fromEnv = Number(Deno.env.get("MODEL_CONTEXT_WINDOW"));
  return Number.isFinite(fromEnv) && fromEnv >= 8192 ? fromEnv : 65536;
})();

const MIN_CONTEXT_WINDOW = 8192;
export const MIN_CONVERSATION_CAP_MB = 10;
const DEFAULT_CONVERSATION_CAP_MB = 100;

const DEFAULTS: Settings = {
  enabledTools: [...ALL_TOOL_NAMES],
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  allowUnexposedWrites: false,
  conversationCapMb: DEFAULT_CONVERSATION_CAP_MB,
  timelineMutes: [],
};

let cached: Settings | null = null;

function sanitize(s: Partial<Settings> | null | undefined): Settings {
  const enabled = Array.isArray(s?.enabledTools) ? s!.enabledTools : DEFAULTS.enabledTools;
  const filtered = enabled.filter((n): n is ToolName =>
    (ALL_TOOL_NAMES as readonly string[]).includes(n)
  );
  const cwRaw = typeof s?.contextWindow === "number" ? s!.contextWindow : DEFAULTS.contextWindow;
  const contextWindow = Number.isFinite(cwRaw) && cwRaw >= MIN_CONTEXT_WINDOW
    ? Math.floor(cwRaw)
    : DEFAULTS.contextWindow;
  const allowUnexposedWrites = typeof s?.allowUnexposedWrites === "boolean"
    ? s!.allowUnexposedWrites
    : DEFAULTS.allowUnexposedWrites;
  const capRaw = typeof s?.conversationCapMb === "number" ? s!.conversationCapMb : DEFAULTS.conversationCapMb;
  const conversationCapMb = Number.isFinite(capRaw) && capRaw >= MIN_CONVERSATION_CAP_MB
    ? Math.floor(capRaw)
    : DEFAULTS.conversationCapMb;
  const rawMutes = Array.isArray(s?.timelineMutes) ? s!.timelineMutes : [];
  const timelineMutes = [
    ...new Set(
      rawMutes.filter((id): id is string => typeof id === "string" && /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(id)),
    ),
  ];
  return {
    enabledTools: filtered.length ? filtered : [...ALL_TOOL_NAMES],
    contextWindow,
    allowUnexposedWrites,
    conversationCapMb,
    timelineMutes,
  };
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  try {
    const raw = await Deno.readTextFile(SETTINGS_PATH);
    cached = sanitize(JSON.parse(raw));
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export async function saveSettings(next: Partial<Settings>): Promise<Settings> {
  const merged = sanitize({ ...(cached ?? DEFAULTS), ...next });
  cached = merged;
  await Deno.writeTextFile(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
