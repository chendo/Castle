# Castle (Home Assistant add-on)

Local-first Home Assistant agent backed by your own OpenAI-compatible LLM
(LM Studio, llama.cpp, vLLM, etc.). Exposes a chat panel inside the HA sidebar
that can call services, query states, view history, modify automations and dashboards.

This project is in early alpha and is probably not ready for general use, expect breaking changes.

> ⚠️ **Use at your own risk.** Castle ships with the ability to call services on entities exposed to Assistants, and read access to all entities. You can enable tools to edit automations and dashboards.

## Features

**Local-first**
- Designed to run on locally-hostable models with low latency, tested with `unsloth/qwen3.6-35b-a3b`
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

**Automations** 🚧 *work in progress*
- Manage your automations (edits disabled by default).
- Inspect a recent run trace to see why an automation did or didn't fire.
- Castle keeps a versioned history of every automation it edits: list versions, diff any two versions, and roll back to a previous one.
- Models still get HA automations wrong often — wrong mode for the trigger pattern, template conditions where native ones exist, `device_id` instead of `entity_id`. The agent is gated on a vendored best-practices skill (see `castle/skills/`) before it can write, which helps but doesn't eliminate the problem. Treat agent-authored automations as drafts and verify before trusting them.

**Dashboards** 🚧 *work in progress*
- List all Lovelace dashboards and read their config.
- Edit a dashboard's config (cards, views, layout).
- Versioned history with diff and rollback, same as automations.
- Same caveat as automations: the agent can get card configs subtly wrong (mismatched entity types per card, layout choices that don't render cleanly). The rollback store gives you a one-call escape if an edit lands badly.

**Operations**
- Read recent HA system / integration logs.
- Read active persistent notifications.

## Security model

A fresh install is conservative on purpose: read anything exposed to
assistants, change small things on those same entities, and *cannot*
touch automation YAML, dashboards, add-ons, or HA Core itself unless
you explicitly turn those tools on in Castle's Settings dialog.

Three layers, narrowest to widest:

1. **Catalog is exposure-filtered.** The agent's system prompt lists only entities you've **exposed to assistants** in HA (Settings → Voice assistants → Expose). Unexposed entities aren't advertised, so the agent has to actively search to find them.

2. **Reads are not gated.** Any tool that fetches state, attributes, history, logs, or notifications will return data for unexposed entities too — if the agent searches for an unexposed entity by name, it'll find it. Treat exposure as "what the agent knows about by default," not a confidentiality boundary.

3. **Writes are gated.** `ha_call_service`, `ha_set_state`, and any other write that takes an entity_id refuse to target unexposed entities. The Settings dialog has *Allow agent to control non-exposed entities* if you want to lift that gate; checked on every tool call, so HA-UI exposure flips take effect immediately.

**Tools that are disabled by default**, separate from the exposure gate:

| Tool | What it does | Why it's off by default |
| --- | --- | --- |
| `ha_update_automation` | Replace an existing automation's full config | Bad write fires real triggers; rollback exists but the bad state is live until you notice |
| `ha_edit_dashboard` | Modify a Lovelace dashboard's config | Same reasoning |
| `ha_update_addon` | Update one HA add-on to its latest version | Wide Supervisor permission; restarts the targeted add-on |
| `ha_manage` | `check_config`, `reload`, or `restart` of HA Core itself | `restart` takes HA down for ~30s; `reload` silently rewrites every YAML-reloadable integration |

The agent's system prompt still *advertises* these tools (so it can tell you what it would need to fulfil a request — "I'd need ha_manage to restart HA"), it just can't invoke them. Flip individual checkboxes on in **Settings → Tools** when you trust a specific operation.

`ha_create_automation`, the various `*_rollback_*` tools, and `ha_list_addons` are **on** by default — creating a new automation can't break anything that wasn't already broken, rollbacks are recovery operations, and listing add-ons is read-only.

## Prerequisites

- A Home Assistant install with **Supervisor** (HA OS, HA Supervised, or HA
  Container with Supervisor). Castle is a Supervisor add-on; vanilla HA Core
  installs can't run it.
- An OpenAI-compatible LLM endpoint reachable from the HA host. LM Studio is
  the default target — on a Mac/PC, enable its server and let it bind to the
  LAN so HA can reach it (e.g. `http://192.168.1.50:1234/v1`).
- Entities exposed to assistants in HA (Settings → Voice assistants → Expose).
  Castle only sees what you've exposed; an empty exposure list means an empty
  agent.

## Recommended models

Castle is built around a tool-calling LLM and the system prompt grows with
your entity catalog, so the model needs **strong tool-use, a long enough
context window, and an instruction-following temperament**. Reasoning models
also help — the agent often needs to plan a multi-step tool sequence (look up
an entity, then call a service on it, then verify).

**Daily-driver pick: `unsloth/qwen3.6-35b-a3b`**

Qwen 3.6 35B with 3B active parameters — a mixture-of-experts model, so only
~3B params are hot per token. That gives near-3B inference speed at ~35B
quality and lands well within typical local-LLM memory budgets at common
GGUF quants. It's solid at structured tool calls, has a 32k–128k context
window depending on quant, and is the model the author runs day-to-day.

Where to get it: search `unsloth/qwen3.6-35b-a3b` in LM Studio, or pull a
GGUF from Hugging Face for llama.cpp / Ollama. Pick the largest quant your
hardware fits.

Other models may work but are untested. 

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
