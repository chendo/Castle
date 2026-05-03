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
  "ha_get_dashboard",
  "ha_modify_dashboard",
  "ha_render_chart",
  "ha_show_camera",
] as const;
export type ToolName = typeof ALL_TOOL_NAMES[number];

export interface Settings {
  enabledTools: ToolName[];
  // LLM context window in tokens. Drives compaction thresholds in the agent.
  // Floored at 8k so things still work; no upper bound — user knows their backend.
  contextWindow: number;
}

// 64k chosen per the roadmap; modern open-weights models comfortably support it.
// MODEL_CONTEXT_WINDOW env var lets a deployment change the seed default without
// touching settings.json (settings.json still wins once a value is saved there).
const DEFAULT_CONTEXT_WINDOW = (() => {
  const fromEnv = Number(Deno.env.get("MODEL_CONTEXT_WINDOW"));
  return Number.isFinite(fromEnv) && fromEnv >= 8192 ? fromEnv : 65536;
})();

const MIN_CONTEXT_WINDOW = 8192;

const DEFAULTS: Settings = {
  enabledTools: [...ALL_TOOL_NAMES],
  contextWindow: DEFAULT_CONTEXT_WINDOW,
};

let cached: Settings | null = null;

function sanitize(s: Partial<Settings> | null | undefined): Settings {
  const enabled = Array.isArray(s?.enabledTools) ? s!.enabledTools : DEFAULTS.enabledTools;
  const filtered = enabled.filter((n): n is ToolName => (ALL_TOOL_NAMES as readonly string[]).includes(n));
  const cwRaw = typeof s?.contextWindow === "number" ? s!.contextWindow : DEFAULTS.contextWindow;
  const contextWindow = Number.isFinite(cwRaw) && cwRaw >= MIN_CONTEXT_WINDOW
    ? Math.floor(cwRaw)
    : DEFAULTS.contextWindow;
  return {
    enabledTools: filtered.length ? filtered : [...ALL_TOOL_NAMES],
    contextWindow,
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
