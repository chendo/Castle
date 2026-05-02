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
}

const DEFAULTS: Settings = {
  enabledTools: [...ALL_TOOL_NAMES],
};

let cached: Settings | null = null;

function sanitize(s: Partial<Settings> | null | undefined): Settings {
  const enabled = Array.isArray(s?.enabledTools) ? s!.enabledTools : DEFAULTS.enabledTools;
  // Keep only known tool names.
  const filtered = enabled.filter((n): n is ToolName => (ALL_TOOL_NAMES as readonly string[]).includes(n));
  return { enabledTools: filtered.length ? filtered : [...ALL_TOOL_NAMES] };
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
