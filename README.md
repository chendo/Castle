# Castle (Home Assistant add-on)

Local-first Home Assistant agent backed by your own OpenAI-compatible LLM
(LM Studio, llama.cpp, vLLM, etc.). Exposes a chat panel inside the HA sidebar
that can call services, query states, view history, modify automations and dashboards.

This project is in early alpha.

## Features

**Local-first, low-latency**
- Designed to run a model on your LAN — LM Studio, vLLM, llama.cpp, Ollama, etc. — so prompts and tool calls don't round-trip to a cloud API. Typical "turn on the kitchen lights" flows complete in well under a second once the model is warm.
- Pointing Castle at OpenAI / Anthropic / Google / Mistral is supported via `llm_type`, but the design target is a model you own.
- No telemetry. Castle talks only to your HA Supervisor and the LLM endpoint you configure.

**Control & inspect**
- Turn things on/off and call any HA service (lights, climate, media players, covers, locks, scripts, scenes — anything exposed to assistants).
- Read current state and attributes for any entity, list/search entities, fire arbitrary HA events, or write an entity's state directly.

**Show things in chat**
- Render entity cards inline — camera live feeds, light/climate/media controls, sensor readouts, side-by-side groups.
- Snapshot a camera into the conversation as a still image.
- Plot historical sensor data as a chart.

**History**
- Bucketed history for numeric sensors (min/max/avg per interval), per-bucket deltas for cumulative meters (kWh, m³ — meter resets handled), and state-change timelines for binary/enum entities.

**Automations**
- Read and edit automation YAML; create new ones.
- Inspect a recent run trace to see why an automation did or didn't fire.
- Castle keeps a versioned history of every automation it edits: list versions, diff any two versions, and roll back to a previous one.

**Dashboards**
- List all Lovelace dashboards and read their config.
- Edit a dashboard's config (cards, views, layout).
- Versioned history with diff and rollback, same as automations.

**Operations**
- Read recent HA system / integration logs.
- Read active persistent notifications.

**Scheduled & triggered tasks**
- Schedule reminders or recurring checks (one-shot at a time, every-N-minutes, etc.).
- Watch a camera or sensor and notify in chat when a condition trips (e.g. "tell me if someone arrives at the front door in the next hour").
- List or cancel any watching task.

**Security model**
- The agent's catalog (the system prompt listing entities it knows about) is built from entities you've **exposed to assistants** in HA (Settings → Voice assistants → Expose). Unexposed entities are not advertised.
- **Reads are not gated.** Any tool that fetches state, attributes, history, logs, or notifications will return data for unexposed entities too — if the agent goes looking, it can find them. Treat exposure as "what the agent is told about by default," not a confidentiality boundary.
- **Writes are gated.** `ha_call_service`, `ha_set_state`, and the automation/dashboard editors refuse to target unexposed entities. The in-app Settings dialog has a single flag — *Allow agent to control non-exposed entities* — that lifts this gate when you explicitly want it lifted.

## Prerequisites

- A Home Assistant install with **Supervisor** (HA OS, HA Supervised, or HA
  Container with Supervisor). Castle is a Supervisor add-on; vanilla HA Core
  installs can't run it.
- An OpenAI-compatible LLM endpoint reachable from the HA host. LM Studio is
  the default target — on a Mac/PC, enable its server and let it bind to the
  LAN so HA can reach it (e.g. `http://192.168.1.50:1234/v1`). vLLM,
  llama.cpp, and Ollama (via its OpenAI-compat shim) all work too.
- Entities exposed to assistants in HA (Settings → Voice assistants → Expose).
  Castle only sees what you've exposed; an empty exposure list means an empty
  agent.

## Install

1. **Add the repository.** In HA: **Settings → Add-ons → Add-on Store → ⋮
   (top-right menu) → Repositories**. Paste this repo's GitHub URL
   (`https://github.com/<owner>/castle`) and click **Add**.
2. **Install the add-on.** Refresh the store, find **Castle** under the new
   repository row, and click **Install**. First install builds from source on
   your HA host — expect 3–10 minutes depending on hardware and network. The
   Supervisor log shows the build progress.
3. **Configure.** Open the add-on's **Configuration** tab:
   - Set `llm_url` to your LLM endpoint's base URL (must include the trailing
     `/v1` for OpenAI-compatible servers).
   - Set `model_name` to the model id you want to use. Leave blank only if
     your endpoint serves a single model — otherwise the add-on errors at
     start with "no active model".
   - If your endpoint requires auth, set `llm_api_key`.
   - Leave `ha_url` / `ha_token` blank unless you're pointing at a different
     HA instance — Supervisor injects them automatically.
   - Save.
4. **Start the add-on.** Toggle **Start on boot** + **Watchdog** on the Info
   tab if you want it to come up with HA. Click **Start**.
5. **Open the panel.** A **Castle** entry appears in the HA sidebar. The
   panel opens straight into the chat view.

If anything goes wrong, the **Log** tab on the add-on page is the first
place to look — Castle prints structured boot logs (`[ha] authenticated`,
`[castle] catalog refreshed`, `[castle] prompt cache warmed`) and any LLM /
HA connection failures surface there with the endpoint URL appended.

## Updating

Push to the repo or wait for a release; in HA, **Add-on Store → Castle →
Update**. State under `/data` (sessions, tasks, settings) is preserved
across updates. The build runs again, so allow a few minutes.

## Options

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `llm_url` | yes | `http://homeassistant.local:1234/v1` | OpenAI-compatible base URL. Point at LM Studio or any compatible server. |
| `llm_type` | yes | `openai-completions` | Endpoint shape. Keep `openai-completions` for LM Studio / llama.cpp / vLLM / Ollama. The other values (`openai-responses`, `anthropic`, `google`, `google-vertex`, `azure-openai-responses`, `mistral`) exist for users routing through a specific cloud provider. |
| `llm_api_key` | no | _empty_ | Only needed if the LLM endpoint requires auth. |
| `model_name` | no | _empty_ | Leave blank to use the first model the endpoint reports. |
| `ha_url` | no | auto | Override only if pointing Castle at a different HA instance. Auto-detected via Supervisor by default. |
| `ha_token` | no | auto | Same — Supervisor auto-injects a scoped token, so no long-lived access token to manage. |

## Data persistence

All state lives under `/data` inside the add-on container, which Supervisor
maps to a managed volume that survives upgrades and restarts:

- `/data/settings.json` — feature toggles, context window, conversation cap, retention caps.
- `/data/sessions/` — JSONL conversation history, one file per session.
- `/data/tasks/` — scheduled tasks (one JSON per task + frame blobs).
- `/data/resource-history/` — per-automation / per-dashboard version history (the rollback store).
- `/data/AGENTS.md` — the auto-generated system prompt Castle hands the LLM.
- `/data/auth.json`, `/data/models.json` — pi-agent's internal auth store and the cached model list for the picker.

## Troubleshooting

The add-on **Log** tab is the first place to look. Castle prints structured
boot logs (`[ha] authenticated`, `[castle] catalog refreshed`,
`[castle] prompt cache warmed`) and LLM / HA connection failures surface
there with the endpoint URL appended.

**LLM status dot stays red.** The drawer footer in the panel shows a status
dot next to "LLM". If it's red, open the log and find `[castle] llm probe failed`
lines with the URL it tried. The most common cause is `llm_url` pointing at
`localhost` while the LLM is on the host machine — from inside Supervisor's
network, `localhost` resolves to the add-on container, not the host. Use the
host's LAN IP (e.g. `http://192.168.1.50:1234/v1`) instead.

**No entities visible in the catalog.** Castle filters by Home Assistant's
"exposed to assistants" list. Visit Settings → Voice assistants → Expose and
tick the entities you want Castle to see. The catalog refreshes within a few
seconds of the change.

**Chat starts then 401s.** The Supervisor-injected token has a fixed scope
and is sufficient for normal operation. If you've overridden `ha_token` in
options with a stale long-lived token, clear that field and let the add-on
fall back to Supervisor's auto-token.

## Development

Castle is a Deno + Vite project. Contributor docs (env vars, docker-compose
workflow, tests, conventions) live in `AGENTS.md` and `CLAUDE.md`.
