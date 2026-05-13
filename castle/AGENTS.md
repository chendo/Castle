# Castle — Home Assistant Agent

Deno app that bridges an OpenAI-compatible LLM (LM Studio by default) to Home Assistant, exposing natural-language control via a WebSocket protocol consumed by a Lit browser UI.

## Run locally

```bash
deno run --allow-all --unstable-node-globals main.ts
```

Requires `.env` with at least `HA_TOKEN`, `MODEL_NAME`, and (usually) `LLM_API_KEY`. See `.env.example` and the env-var table below for all knobs.

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

After cloning, wire the pre-commit hook (it lives at `castle/scripts/git-hooks/`). Run from the **repo root**:

```bash
git config core.hooksPath castle/scripts/git-hooks
```

Then `cd castle/` for everything that follows — the source, compose file, tests, and scripts all live inside the add-on directory.

Frontend iteration: `docker compose --profile dev up -d web-watch` keeps `web/dist/` continuously rebuilt; refresh the browser after each save. Edit `*.ts` (Deno) → `docker compose restart castle`.

Run all checks manually:

```bash
./scripts/check.sh                           # deno check + lint + unit tests + web tsc
docker compose exec castle deno task test       # both unit and integration
docker compose exec castle deno task test:unit  # unit only (no LLM/HA needed)
docker compose exec castle deno task test:smoke  # ~1 min smoke against a real LLM
docker compose exec castle deno task test:integration  # full ~9 min suite via LM Studio
```

### Integration tests against HA demo instance

The project includes a full integration test suite that runs Castle against a
test-specific Home Assistant instance using the `demo:` configuration. This
provides ~50 deterministic entities (lights, switches, climate, cameras,
automations, dashboards) for reproducible testing.

```bash
# Full pipeline: boots ha-demo + castle, waits for readiness, runs tests, tears down
./scripts/run-integration-tests.sh

# Or run just the Deno tests inside a running container (requires HA and LM Studio reachable)
docker compose exec castle deno task test:integration
```

**Prerequisites:** `.env.test` (copy from `.env.test.example`) with `MODEL_NAME`,
`LLM_API_KEY`, etc. An external OpenAI-compatible server must be reachable from
the castle container — typically `http://host.docker.internal:1234/v1`.

The test suite covers all 16 HA tools, plus scenario tests for context inference,
multi-tool problem solving, automation/dashboard CRUD, and camera operations. The
eval harness scores models on two axes: (1) which tools were called with correct args,
and (2) whether actual HA entity states changed after write operations. Excess tool
calls are warn-only; missing or wrong tool calls fail the test.

Test files live in `tests/integration/`:

| File | Coverage |
|---|---|
| `shared.ts` | WS driver, assertion helpers, HA REST API utilities |
| `tools_basic_test.ts` | All 16 tools individually tested with all args |
| `tools_dashboard_test.ts` | Dashboard CRUD: get, set, delete, insert + YAML verification |
| `tools_automation_test.ts` | Automation CRUD + trace debugging + strict validation |
| `tools_camera_test.ts` | Snapshot capture, live feed, context-based entity resolution |
| `agent_context_test.ts` | Multi-turn context, cross-domain coordination, problem solving |
| `agent_eval_test.ts` | Model eval harness with weighted scoring across ~20 cases |

Run integration tests after every notable change to agent behavior, tool definitions,
or the WebSocket protocol. They are not part of the pre-commit hook (require a real LLM).

## Engineering standards

Rules for every change. Optimize for whoever reads this commit in six months without context. The pre-commit hook enforces some of these; agents working on this repo must self-enforce all of them.

### Principles
- Smallest change that solves the problem. Resist scope creep, especially your own.
- Code says what; commits say why. Reasoning lives in commit messages and `git blame`.
- Types are load-bearing. Make wrong states unrepresentable.
- Dead code is debt. Delete it. Git remembers.
- Read more than you write.

### Before changing code
- Read the relevant files in full. Surrounding code teaches conventions.
- Find prior art and match it. Don't introduce a third way of doing the same thing.
- For non-trivial changes, state the plan in one paragraph: what, why, what you won't touch.
- If the request is ambiguous, ask. Always ask before irreversible operations.

### Writing code
- **Types.** Sum types over flags. `Result<T, E>` over thrown strings. Newtypes for ids that mustn't mix (`UserId` ≠ `OrgId`). No `any`, no unwrapping fallible values without a comment justifying it.
- **Parse, don't validate.** Convert untrusted input to a typed value at the boundary, once.
- **Errors are values.** Return them, type them. No empty catch. No rethrow without added context. Crash on programmer error, surface user error, retry transient error.
- **Names describe intent, not type.** `pendingApprovals` not `items`. `cancelOrder` not `processOrder2`.
- **One thing, one level of abstraction per function.** If you need "and" to describe it, split it.
- **Pure core, imperative shell.** Push side effects to the edges.
- **Comments justify non-obvious choices.** If a comment paraphrases the next line, delete one.
- **Don't abstract for hypothetical futures.** Two call sites is a coincidence; three is a pattern. Until then, inline.
- **Default to no shared mutable state.** Module-level buffers and singletons are concurrency hazards.

### Size discipline
- Files over 1000 lines should be split. If you're touching one, leave it smaller than you found it. Splits go in their own commit.
- Target commits under ~100 lines diff. Over ~200, justify why it can't be split. Mechanical refactors (renames, formatter runs) excepted but should be obviously mechanical.
- Each commit builds and passes tests on its own. `git bisect` only works when every commit is green.

### Refactoring and dead code
- Refactors go in separate commits from feature work. A reviewer should never have to ask "is this a behaviour change or a rename?"
- Pure refactors don't change behaviour. If tests fail after, it wasn't a refactor.
- Refactor opportunistically, but bound it. Improve what's in your way; don't rewrite the module.
- If you find a deeper problem, name it and stop. Surface it; let the human decide if it's in scope.
- Delete unused code, exports, deps, flags. Don't comment out, don't `if (false)`. Removals in their own commit.
- Resolve or delete stale TODOs.

When deleting or renaming, sweep the diff for the wreckage: unused imports, now-unreferenced helpers, unread struct/interface fields, dead branches that handled a removed case, comments describing behaviour that no longer exists, and tests for code that no longer exists. `deno lint` catches some of this but not all — eyeball the diff. A half-finished delete is worse than no delete.

### Tests
- Test behaviour, not implementation. Assertions on observable outcomes survive refactors.
- One reason to fail per test.
- A failing test is a finished test. Watch it fail with a wrong expected value first.
- Don't test what types prove. Don't test framework code.
- Run the test suite before every commit. `./scripts/check.sh` (or at minimum `deno task test:unit`) must be green. If you added behaviour, add a test for it in `tests/` first; if you changed behaviour, update the existing test. Never commit with red or skipped tests "to fix later".
- Run integration tests (`tests/integration/`) after notable changes to agent behaviour, tool definitions, or the WS protocol — they're not in the pre-commit hook because they need a real LLM.

### Validate before you commit
A commit means "this works." Either tests cover the change end-to-end, or you ran the code and verified the new/changed behaviour manually (pages render, tool calls succeed, the new flag actually flips the thing). Don't commit changes you haven't watched run.

### One commit = one focused change
Tight, single-purpose commits. A topbar UI tweak, a tool-description edit, and a server-side bugfix are three commits, not one — even when they all sit in the same dirty tree at the end of a session. If you find yourself listing five unrelated bullets in a commit message, stop and split. Mixed commits are hostile to bisection, review, and `git revert`.

### Commit messages
Subject (≤ 72 chars, imperative mood, no trailing period) is for `git log --oneline` skimmers. Bias toward "*what changed and why*" over "*how*" — `Fix camera widget memory leak from per-instance body observer` beats `Refactor CameraRenderer.ts`. Then a blank line, then the body: why this is needed (problem solved, symptom or ticket that prompted it), the approach in a sentence or two, alternatives considered, non-obvious trade-offs. Don't restate the diff. Future-you and future-agents will read these in `git log` and `git blame`; write them so the reasoning survives the diff being touched again later.

### Token efficiency
- Read targeted ranges, not whole files. Whole files only when you'll read them linearly.
- Edit with surgical replacements, not rewrites.
- Don't paste large outputs back into reasoning. Summarize; reference paths and line numbers.
- Don't restate the request before answering. Just do it.
- Match response length to question.

### Communication
- Report outcomes, not attempts. Failed approaches go in the commit body if useful, else discarded.
- Surface uncertainty. "I changed X. Y is suspect because Z" beats false confidence.
- Flag what you noticed but didn't fix. Don't silently fix; don't silently ignore.

### When in doubt
Ask. Read the surrounding code one more time. Make the smaller version first.

### Performance and lifecycles
Every observer, listener, interval, timeout, subscription, or long-lived closure is a potential leak and a potential CPU drain. Before you ship code that adds one of those, answer two questions out loud: (1) what cleans this up when the owning element / session / turn ends? (2) how often does it run, and what's the cost per run × the worst-case rate? Specific shapes to watch for: `MutationObserver` scoped wider than necessary (especially `document.body` with `subtree: true`), per-instance global listeners with no removal path, intervals that don't self-cancel when their state goes away, growing maps with no pruning, and subscriptions taken inside render functions that re-take on every render. Lit elements with `connectedCallback` / `disconnectedCallback` are usually the right home for anything DOM-bound — they get the lifecycle hooks for free instead of you reinventing them with cleanup observers. Default to the cheapest mechanism that solves the problem, and re-check perf hotspots whenever they're touched.

### Update the docs alongside the code
When you change something user- or agent-visible — routes, env vars, the protocol, the tool list, the architecture diagram — update `AGENTS.md`, `CLAUDE.md`, `README.md` (if present), and the relevant doc comments in the same commit. Stale docs are confidently wrong, which is worse than missing.

### Never invoke `git` with `-C <path>`
It re-targets the repo path explicitly, trips the harness's permission prompt on every call, and adds noise. If your shell is somewhere other than the repo root (e.g. `web/` after a `tsc` run), `cd` to the repo root once and then run plain `git status` / `git add …` / `git commit …`.

### Never commit secrets
Tokens, API keys, long-lived access tokens, network IPs that identify a private deployment, hostnames that aren't public DNS — none of these belong in tracked files. They go in `.env` (gitignored) or `docker-compose.override.yml` (gitignored). When in doubt, treat it as a secret.

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
| `LLM_URL` | `http://host.docker.internal:1234/v1` (in Docker) / `http://localhost:1234/v1` (host) | Model server base URL (LM Studio, vLLM, llama.cpp, OpenRouter, real OpenAI, etc.) |
| `LLM_API_KEY` | *(empty)* | API key for the model server |
| `LLM_TYPE` | `openai-completions` | Provider dialect; only `openai-completions` is wired up today |
| `MODEL_NAME` | *(required)* | Model id passed in chat completions (e.g. `qwen/qwen3-vl-30b`, `gpt-4o-mini`) |
| `CASTLE_AUTH_TOKEN` | *(empty)* | Optional bearer token guarding Castle's own WS/HTTP server |
| `PORT` | `7090` | Server listen port (mapped to 7091 externally) |

Put real values in a local `.env` (gitignored). Never hardcode network addresses or tokens in tracked files. See `.env.example` for the template.

## Host networking

`docker-compose.yml` uses `host.docker.internal` to reach a model server on the host. If your runtime resolves that differently (Lima, Podman, custom bridge), add an `extra_hosts` entry in a local `docker-compose.override.yml` (also gitignored). Verify the model server is bound to `0.0.0.0`.

## UI

Served at `/` from `web/dist/` (built by Vite). Sidebar with entity browser (grouped by domain) and chat interface. The browser opens a single `/ws` connection — entity catalog and chat updates both arrive as WS frames (`states_snapshot`, `state_change`, `snapshot`, `event`, `health`). No HTTP polling.
