# Castle — Home Assistant Agent

Deno app that bridges an OpenAI-compatible LLM (LM Studio by default) to Home Assistant, exposing natural-language control via a WebSocket protocol consumed by a Lit browser UI.

## Run locally

```bash
deno run --allow-all --unstable-node-globals main.ts
```

Requires `.env` with at least `HA_TOKEN`, `MODEL_NAME`, and (usually) `OPENAI_API_KEY`. See `.env.example` and the env-var table below for all knobs.

## Run via Docker

```bash
docker compose up --build -d
```

Container mounts the workspace directory — no rebuild needed for source changes. Deno cache volume (`deno-cache`) persists across restarts.

## Running commands

Deno is **not installed on the host**. Always execute commands inside the container:

```bash
docker compose exec castle deno run --allow-all main.ts          # run a script
docker compose logs -f castle                                  # view logs
docker compose exec castle sh                                     # shell into container
```

## Development

After cloning, wire the pre-commit hook (it lives at `scripts/git-hooks/`):

```bash
git config core.hooksPath scripts/git-hooks
```

Frontend iteration: `docker compose --profile dev up -d web-watch` keeps `web/dist/` continuously rebuilt; refresh the browser after each save. Edit `*.ts` (Deno) → `docker compose restart castle`.

Run all checks manually:

```bash
./scripts/check.sh                           # deno check + lint + unit tests + web tsc
docker compose exec castle deno task test       # both unit and integration
docker compose exec castle deno task test:unit  # unit only (no LLM/HA needed)
docker compose exec castle deno task test:integration  # WS round-trip via LM Studio
```

The integration test asks the LLM about a weather entity via `/ws` and asserts only read-only tools are called. Override the entity with `CASTLE_TEST_WEATHER_ENTITY` if `weather.forecast_home` doesn't exist on your HA instance.

## Rules for committing

These are non-negotiable; the pre-commit hook enforces some, but agents working on this repo must self-enforce all of them.

**No dangling dead code after a delete or refactor.** When you remove or rename code, sweep the surrounding context for the wreckage: unused imports, now-unreferenced helpers, unread struct fields, dead branches that handled a removed case, comments describing behaviour that no longer exists, and tests for code that no longer exists. `deno lint` catches some of this but not all — eyeball the diff. A half-finished delete is worse than no delete.

**Update the docs alongside the code.** When you change something user- or agent-visible — routes, env vars, the protocol, the tool list, the architecture diagram — update `AGENTS.md`, `CLAUDE.md`, `README.md` (if present), and the relevant doc comments in the same commit. Stale docs are confidently wrong, which is worse than missing.

**Run the test suite before every commit.** `./scripts/check.sh` (or at minimum `deno task test:unit`) must be green. If you added behavior, add a test for it in `tests/` first; if you changed behavior, update the existing test. Never commit with red or skipped tests "to fix later".

**Never commit secrets.** Tokens, API keys, long-lived access tokens, network IPs that identify a private deployment, hostnames that aren't public DNS — none of these belong in tracked files. They go in `.env` (gitignored) or `docker-compose.override.yml` (gitignored). When in doubt, treat it as a secret.

- Do not hardcode anything that looks like a token, key, or private IP — read it from an env var with a generic public default (e.g. `homeassistant.local`, `host.docker.internal`).
- Do not commit `.env`, `.pi-agent/`, `docker-compose.override.yml`, or any file under `workspace/` (scratch / dev notes).
- Before committing, scan the diff for accidental secret leakage: tokens (`eyJ…` JWTs, `sk-…` keys), private IPs (`10.…`, `172.16–31.…`, `192.168.…`), and HA tokens. The pre-commit hook is a safety net, not a substitute for looking.
- If a secret is committed by mistake, **stop and rotate the secret first**, then rewrite history with `git filter-repo --replace-text` (see existing scrub flow). Do not just delete the file in a follow-up commit — the value stays reachable in the original blob.

## Architecture

- **main.ts** — HTTP server (`Deno.serve`). Routes: `GET /` (Lit UI from `web/dist/`), `GET /health`, `GET /models`, `GET /agents.md`, `GET /history`, `WS /ws` (the real protocol — every UI action is a WS message: `hello`, `prompt`, `abort`, `reset`, `set_settings`, `set_model`, `set_exposure`, `get_settings`).
- **ha-client.ts** — WebSocket client to HA (`get_states`, `subscribe_events`, `call_service`, `history`). Fetches exposed entities via `homeassistant/expose_entity/list`.
- **agent.ts** — Wraps `@mariozechner/pi-coding-agent` into a long-lived session. The system prompt is the auto-generated `.pi-agent/AGENTS.md` (entity catalog), not injected per-prompt.
- **tools.ts** — 16 HA tools: `ha_call_service`, `ha_fire_event`, `ha_set_state`, `ha_get_states`, `ha_get_entity`, `ha_get_history`, `ha_get_camera_snapshot`, `ha_show_camera`, `ha_get_logs`, `ha_get_notifications`, `ha_get_dashboard`, `ha_edit_dashboard`, `ha_render_chart`, `ha_get_automation`, `ha_update_automation`, `ha_get_automation_trace`. The canonical list lives in `settings.ts:ALL_TOOL_NAMES`.
- **catalog.ts** — Filters entities by HA exposure status, renders the system-prompt entity catalog from `templates/AGENTS.md.jinja2`. Skips noisy domains (update, device_tracker, etc.).
- **settings.ts** — Persists `.pi-agent/settings.json` (enabled tools, context window, `allowUnexposedWrites`).

## .pi-agent/ directory

Auto-generated on each HA connection. Contains:
- `models.json` — written from env vars at startup; consumed by pi-coding-agent library
- `AGENTS.md` — auto-generated entity catalog; becomes the KV-cached system prompt in LM Studio
- `auth.json` — auth storage for the agent library

**Do not hand-edit these files.** They are overwritten on every HA reconnection.

## Entity filtering

Entities included in the agent context come from HA's `homeassistant/expose_entity/list` websocket command. Only entities explicitly exposed to assistants (conversation, Alexa, Google) appear — no hardcoded allowlists.

The HA token must have **write permission** for this API endpoint. If the call fails with "Unauthorized", all entities are included as fallback. Create a new long-lived access token in HA Settings → People if needed.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | `http://homeassistant.local:8123` | Home Assistant URL |
| `HA_TOKEN` | *(required)* | HA long-lived access token |
| `OPENAI_URL` | `http://host.docker.internal:1234/v1` (in Docker) / `http://localhost:1234/v1` (host) | OpenAI-compatible API base URL (LM Studio, vLLM, llama.cpp, OpenRouter, real OpenAI, etc.) |
| `OPENAI_API_KEY` | *(empty)* | API key for the OpenAI-compatible endpoint |
| `MODEL_NAME` | *(required)* | Model id passed in chat completions (e.g. `qwen/qwen3-vl-30b`, `gpt-4o-mini`) |
| `CASTLE_AUTH_TOKEN` | *(empty)* | Optional bearer token guarding Castle's own WS/HTTP server |
| `PORT` | `7090` | Server listen port (mapped to 7091 externally) |

Put real values in a local `.env` (gitignored). Never hardcode network addresses or tokens in tracked files. See `.env.example` for the template.

## Host networking

`docker-compose.yml` uses `host.docker.internal` to reach a model server on the host. If your runtime resolves that differently (Lima, Podman, custom bridge), add an `extra_hosts` entry in a local `docker-compose.override.yml` (also gitignored). Verify the model server is bound to `0.0.0.0`.

## UI

Served at `/` from `web/dist/` (built by Vite). Sidebar with entity browser (grouped by domain) and chat interface. The browser opens a single `/ws` connection — entity catalog and chat updates both arrive as WS frames (`states_snapshot`, `state_change`, `snapshot`, `event`, `health`). No HTTP polling.
