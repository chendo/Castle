# hai — Home Assistant Agent

Deno app that bridges a local LLM (LM Studio) to Home Assistant, exposing natural-language control via HTTP SSE.

## Run locally

```bash
deno run --allow-all --unstable-node-globals main.ts
```

Requires `.env` with `HA_TOKEN` and `LM_STUDIO_API_KEY`. See `docker-compose.yml` for all env vars and defaults.

## Run via Docker

```bash
docker compose up --build -d
```

Container mounts the workspace directory — no rebuild needed for source changes. Deno cache volume (`deno-cache`) persists across restarts.

## Running commands

Deno is **not installed on the host**. Always execute commands inside the container:

```bash
docker compose exec hai deno run --allow-all main.ts          # run a script
docker compose logs -f hai                                     # view logs
docker compose exec hai sh                                     # shell into container
```

## Development

After cloning, wire the pre-commit hook (it lives at `scripts/git-hooks/`):

```bash
git config core.hooksPath scripts/git-hooks
```

Frontend iteration: `docker compose --profile dev up -d web-watch` keeps `web/dist/` continuously rebuilt; refresh the browser after each save. Edit `*.ts` (Deno) → `docker compose restart hai`.

Run all checks manually:

```bash
./scripts/check.sh                           # deno check + lint + unit tests + web tsc
docker compose exec hai deno task test       # both unit and integration
docker compose exec hai deno task test:unit  # unit only (no LLM/HA needed)
docker compose exec hai deno task test:integration  # WS round-trip via LM Studio
```

The integration test asks the LLM about a weather entity via `/ws` and asserts only read-only tools are called. Override the entity with `HAI_TEST_WEATHER_ENTITY` if `weather.forecast_home` doesn't exist on your HA instance.

## Rules for committing

These are non-negotiable; the pre-commit hook enforces some, but agents working on this repo must self-enforce all of them.

**Run the test suite before every commit.** `./scripts/check.sh` (or at minimum `deno task test:unit`) must be green. If you added behavior, add a test for it in `tests/` first; if you changed behavior, update the existing test. Never commit with red or skipped tests "to fix later".

**Never commit secrets.** Tokens, API keys, long-lived access tokens, network IPs that identify a private deployment, hostnames that aren't public DNS — none of these belong in tracked files. They go in `.env` (gitignored) or `docker-compose.override.yml` (gitignored). When in doubt, treat it as a secret.

- Do not hardcode anything that looks like a token, key, or private IP — read it from an env var with a generic public default (e.g. `homeassistant.local`, `host.docker.internal`).
- Do not commit `.env`, `.pi-agent/`, `docker-compose.override.yml`, or any file under `workspace/` (scratch / dev notes).
- Before committing, scan the diff for accidental secret leakage: tokens (`eyJ…` JWTs, `sk-…` keys), private IPs (`10.…`, `172.16–31.…`, `192.168.…`), and HA tokens. The pre-commit hook is a safety net, not a substitute for looking.
- If a secret is committed by mistake, **stop and rotate the secret first**, then rewrite history with `git filter-repo --replace-text` (see existing scrub flow). Do not just delete the file in a follow-up commit — the value stays reachable in the original blob.

## Architecture

- **main.ts** — HTTP server (Deno.serve). Routes: `GET /` (UI), `GET /health`, `GET /states`, `POST /query` (SSE stream)
- **ha-client.ts** — WebSocket client to HA (`get_states`, `subscribe_events`, `call_service`, `history`). Fetches exposed entities via `homeassistant/expose_entity/list`.
- **agent.ts** — Wraps `@mariozechner/pi-coding-agent` into a streaming query handler. Injects current entity states + custom tools into each prompt.
- **tools.ts** — Three HA tools: `ha_call_service`, `ha_get_states`, `ha_get_history`.
- **catalog.ts** — Filters entities by HA exposure status, formats state snapshots for the agent prompt. Skips noisy domains (update, device_tracker, etc.).

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
| `HAI_AUTH_TOKEN` | *(empty)* | Optional bearer token guarding hai's own WS/HTTP server |
| `PORT` | `7090` | Server listen port (mapped to 7091 externally) |

Put real values in a local `.env` (gitignored). Never hardcode network addresses or tokens in tracked files. See `.env.example` for the template.

## Host networking

`docker-compose.yml` uses `host.docker.internal` to reach a model server on the host. If your runtime resolves that differently (Lima, Podman, custom bridge), add an `extra_hosts` entry in a local `docker-compose.override.yml` (also gitignored). Verify the model server is bound to `0.0.0.0`.

## UI

Served at `/`. Sidebar with entity browser (grouped by domain) and chat interface. Entity list auto-refreshes every 10s via `/states`. Chat streams agent responses via SSE from `/query`.
