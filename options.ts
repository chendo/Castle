// Home Assistant add-on options loader. Supervisor writes the add-on's
// user-supplied options to /data/options.json. We map those keys onto the env
// vars Castle already reads (so the dev workflow with .env stays untouched),
// and only fill in values the env didn't already provide — explicit env wins.
//
// Imported for side-effect at the top of main.ts so the env is populated
// before any other module's top-level reads (paths.ts, agent.ts, …).
//
// **Synchronous** on purpose: ES modules with top-level await are allowed to
// evaluate sibling imports in parallel. If options.ts used `await
// Deno.readTextFile`, agent.ts (which has no TLA) would run its module init
// before options.ts finished applying env vars, and would read MODEL_NAME as
// empty. `readTextFileSync` forces options.ts to a synchronous, no-TLA module
// that must complete before any sibling module's body runs.

const OPTIONS_PATH = "/data/options.json";

const ENV_KEYS: Record<string, string> = {
  llm_url: "LLM_URL",
  llm_type: "LLM_TYPE",
  llm_api_key: "LLM_API_KEY",
  model_name: "MODEL_NAME",
  ha_url: "HA_URL",
  ha_token: "HA_TOKEN",
  castle_auth_token: "CASTLE_AUTH_TOKEN",
  automation_history_max_versions: "CASTLE_AUTOMATION_HISTORY_MAX",
  dashboard_history_max_versions: "CASTLE_DASHBOARD_HISTORY_MAX",
};

try {
  const text = Deno.readTextFileSync(OPTIONS_PATH);
  const opts = JSON.parse(text) as Record<string, unknown>;
  for (const [k, env] of Object.entries(ENV_KEYS)) {
    const v = opts[k];
    let str: string;
    if (typeof v === "string" && v.length > 0) str = v;
    else if (typeof v === "number" && Number.isFinite(v)) str = String(v);
    else continue;
    if (Deno.env.get(env)) continue; // explicit env wins
    Deno.env.set(env, str);
  }
  console.log("[castle] applied /data/options.json");
} catch (err) {
  // Missing options.json is normal outside the add-on container.
  if (!(err instanceof Deno.errors.NotFound)) {
    console.warn("[castle] options.json load failed:", (err as Error).message);
  }
}
