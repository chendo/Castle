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
| `HA_URL` | `http://homeassistant.local:8123/` | Home Assistant URL |
| `HA_TOKEN` | *(required)* | Long-lived access token |
| `LM_STUDIO_URL` | `http://host.docker.internal:1234/v1` | LM Studio OpenAI-compatible API |
| `LM_STUDIO_API_KEY` | `lm-studio` | API key for LM Studio |
| `PORT` | `7090` | Server listen port (mapped to 7091 externally) |

## Lima networking

Uses `host.docker.internal:host.docker.internal` for host access (not Docker Desktop). The `extra_hosts` entry in docker-compose.yml maps this explicitly. If LM Studio is unreachable, verify it's bound to `0.0.0.0:1234` and the Lima VM can route to the host IP.

## UI

Served at `/`. Sidebar with entity browser (grouped by domain) and chat interface. Entity list auto-refreshes every 10s via `/states`. Chat streams agent responses via SSE from `/query`.
