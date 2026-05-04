# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical contributor guide — read it for environment variables, secret-handling rules, the docker-compose layout, and the entity-exposure model. This file captures the things you'll get wrong if you only read AGENTS.md once.

## Running commands

Deno is **not installed on the host**. Every `deno`/`npm` invocation must go through Docker:

```bash
docker compose exec castle deno task test:unit       # unit only (no LLM/HA)
docker compose exec castle deno task test:integration # WS round-trip via real LM Studio
docker compose exec castle deno task check           # deno check + lint
./scripts/check.sh                                   # full gate: deno check/lint/unit + web tsc
```

`./scripts/check.sh` auto-detects whether `castle` is running and uses `docker compose exec` (warm) or `docker compose run --rm` (cold). The pre-commit hook at `scripts/git-hooks/` runs it; wire it with `git config core.hooksPath scripts/git-hooks` after cloning.

Run a single Deno test file:

```bash
docker compose exec castle deno test --allow-all tests/catalog_test.ts
docker compose exec castle deno test --allow-all tests/catalog_test.ts --filter "name substring"
```

After editing `*.ts` (Deno backend): `docker compose restart castle`. After editing `web/src/*`: rebuild bundle with `docker compose --profile dev up -d web-watch` (continuous) or `docker compose run --rm web-build` (one-shot). The browser must be refreshed manually — there's no HMR.

## Architecture

Castle is a Deno HTTP/WebSocket server that bridges a Home Assistant install to an OpenAI-compatible LLM (LM Studio by default), exposing natural-language control through a Lit-based browser UI.

**Request path:** browser ⇄ `/ws` (main.ts) ⇄ pi-coding-agent session (agent.ts) ⇄ HA tools (tools.ts) ⇄ HA WebSocket API (ha-client.ts).

Key modules:

- **main.ts** — `Deno.serve` HTTP entry. Routes: `GET /` (Lit UI from `web/dist/`), `GET /health`, `GET /models`, `GET /agents.md` (download-able catalog), `GET /history`, `GET /camera/<id>` + `/camera_stream/<id>`, `WS /ws` (the real protocol — every UI action is a WS message: `hello`, `prompt`, `abort`, `reset`, `set_settings`, `set_model`, `set_exposure`, `get_settings`). Handles auth via `CASTLE_AUTH_TOKEN` (query `?token=` or `Sec-WebSocket-Protocol: bearer.<token>` because browsers can't send `Authorization` on WS).
- **ha-client.ts** — Single-connection WS client to HA with auto-reconnect/backoff. Owns the state cache (`getAllStates`), exposure list (`getExposedEntities` via `homeassistant/expose_entity/list`), services, areas, and house metadata. Push state changes via `onStateChange` listeners.
- **agent.ts** — Wraps `@mariozechner/pi-coding-agent` into a long-lived session. `activeModelId` is a mutable runtime value (browser model picker writes it via `setActiveModel`); `writeModelsJson` rewrites `.pi-agent/models.json` before each session build. `resetAgentSession()` tears the session down — this leaves the broadcast subscription dangling, which is why `ensureAgentBroadcast` tracks subscriptions per agent in a `WeakSet` and re-wires after every reset (see comment at main.ts:264).
- **tools.ts** — All HA tools (`ha_call_service`, `ha_get_states`, `ha_get_entity`, `ha_get_history`, `ha_fire_event`, `ha_set_state`, `ha_get_camera_snapshot`, `ha_show_camera`, `ha_get_logs`, `ha_get_notifications`, `ha_get_dashboard`, `ha_edit_dashboard`, `ha_render_chart`, `ha_get_automation`, `ha_update_automation`, `ha_get_automation_trace`). The full canonical list lives in `settings.ts` as `ALL_TOOL_NAMES` — keep that in sync when adding a tool. Tools include byte-budgeted truncation helpers (`okText`, `withTruncationFooter`) since LLM context is the binding constraint.
- **catalog.ts** — Filters entities by HA exposure status and renders `.pi-agent/AGENTS.md` (the system prompt the agent sees — distinct from this file).
- **settings.ts** — Persists `.pi-agent/settings.json` (enabled tools, context window, `allowUnexposedWrites`). Changing settings forces `resetAgentSession()` because tool wiring is baked in at session creation.
- **persistence.ts** — Append-only conversation logging.

**Entity exposure is the security model.** The default agent prompt only sees entities exposed to assistants in HA (via `homeassistant/expose_entity/list`). Write tools (`ha_call_service`, `ha_set_state`) reject unexposed entities unless `settings.allowUnexposedWrites` is true. Reads are not gated. If the HA token lacks write permission for that endpoint, exposure list fetch fails and the agent falls back to *all* entities — log line `[castle] catalog refreshed (all entities, …)` is the tell.

**`.pi-agent/` is generated, not source.** `models.json`, `AGENTS.md`, `auth.json`, `settings.json` all live here. They are overwritten on reconnect / settings save. Never hand-edit; never commit (gitignored).

## Frontend

`web/` is a separate Vite/Lit project (`web/package.json`) consuming `@mariozechner/pi-web-ui`. The build output lands in `web/dist/` and is served as static files by `main.ts`. There is no SSR and no API client layer — the UI talks to the server only via the `/ws` protocol (look at `WebSocketRemoteAgent.ts` and `main.ts`'s `handleSocket` for the message shapes: `hello`, `prompt`, `abort`, `reset`, `set_settings`, `set_model`, `set_exposure`).

## When deleting or refactoring

Sweep the diff for dead code every time. After removing or renaming something, check for: unused imports, now-orphaned helper functions, unread struct/interface fields, dead conditional branches that handled a removed case, comments describing behaviour that no longer exists, and tests for code that no longer exists. `deno lint` catches *some* unused locals but not unread fields, dead branches, or stale comments. A half-finished delete that leaves wreckage behind is worse than no delete — chase it down before you commit.

Also re-read `AGENTS.md`, `CLAUDE.md`, and any nearby doc comments in the same pass. When you change a route, env var, protocol, tool list, or architectural shape, the docs that describe it become wrong instantly — fix them in the same commit. Stale docs that confidently describe a system that no longer exists are worse than missing docs.

## Committing

- **One commit, one focused change.** A UI tweak, a tool-description edit, and a server-side bugfix are three commits even when they're all in the same session's dirty tree. Mixed commits are hostile to bisection, review, and `git revert` — split them.
- **Validate before staging.** Either tests cover it end-to-end, or you ran the code and watched the new behaviour work (the page renders, the tool call succeeds, the flag actually toggles the thing). Never commit a change you haven't seen run.
- **Subject line is for `git log --oneline` skimmers** — humans and agents both. Imperative mood, ≤ 72 chars, no trailing period. Bias toward "*what changed and why*" rather than "*how*": `Fix camera widget memory leak from per-instance body observer` beats `Refactor CameraRenderer.ts`. Make it findable from a one-line history grep.
- **Body explains the why.** Context (what was wrong, what constraint forced the choice), the approach in a sentence or two, non-obvious trade-offs. Future-you reads these in `git blame`; write them so the reasoning survives the diff being touched again later.

## Performance and lifecycles

Every observer, listener, interval, timeout, subscription, and long-lived closure is a potential leak *and* a potential CPU drain. Before adding one, answer two questions: (1) what cleans this up when its owning element / session / turn ends? (2) how often does it run, and what's the cost-per-run × worst-case rate?

Specific shapes that bite us repeatedly in this codebase:

- `MutationObserver` scoped wider than necessary — especially `document.body` with `subtree: true`. Every mutation in the entire app fires the callback. Per-instance observers compound this.
- Per-instance globals (`document.addEventListener`, ...) with no removal path. Use a Lit custom element with `disconnectedCallback` instead of inventing a cleanup observer.
- Intervals that don't self-cancel when the state they're updating goes away.
- Maps that grow per turn / per message without pruning.
- Subscriptions taken inside render functions, re-taken on every render. The Set grows unbounded.

When you touch a hot path (anything that runs per token delta, per state change, per chat message), re-check the cost and the cleanup story. Default to the cheapest mechanism that solves the problem. If you can't articulate the answer to (1) and (2), the code probably leaks.

## Conventions worth knowing

- The agent's system prompt is the auto-generated `.pi-agent/AGENTS.md` (entity catalog), **not** the project's `AGENTS.md` (contributor guide). Don't confuse them.
- Tool output is truncated by byte budget (not token count) with a footer surfacing the elision. Renderers in `web/src/HAToolRenderer.ts` show a warning badge when `details.truncated` is set.
- LLM call failures are logged at the host with the `OPENAI_URL` appended (see `logLlmFailure` / `enrichErrorEvent` in main.ts) — bare "fetch failed" errors omit the endpoint, which is the #1 misconfiguration symptom.
- Tests under `tests/integration/` require a running LM Studio + reachable HA and are skipped by `test:unit`. The integration test asserts the agent only invokes read-only tools when asked about a weather entity; override the entity with `CASTLE_TEST_WEATHER_ENTITY` if `weather.forecast_home` doesn't exist.
- Pre-commit hook scrubs for tokens, private IPs, JWTs. If a secret slips through, **rotate first**, then rewrite history with `git filter-repo --replace-text` — deleting the file in a follow-up commit leaves the value reachable in the original blob.
