# Changelog

## Unreleased

- **Proactive observer (dry run).** A second, background agent reads Home Assistant's event stream and records what it notices — automations that fired without effect, entities that went unavailable, security-relevant events, and repeated manual actions worth automating. It has **no write tools**: `perform_action` carries the real name and schema of a service call but records the action instead of executing it, so the dry run measures the behaviour a live mode would actually have. Off by default; a new **Observer** tab lists findings, and a band above the chat transcript surfaces unread ones. Enable it under Settings → Observer.
  - Four tools only (`get_state`, `get_history`, `get_camera_snapshot`, `perform_action`) so the schema block stays small and passes stay fast. The observer can see *that* an automation fired and what did or did not change, but not its trace — "Ask about this" hands a finding to the chat agent, which can.
  - Cameras are opt-in and empty by default, capped at one snapshot per pass with a five-minute per-camera cooldown, and not registered at all on a text-only model.
  - Its own session with a 64k rolling context that compacts to the most recent 16k; anything that must outlive that goes in a plain-text, hand-editable `MEMORY.md` re-injected into every pass.
  - Passes run as internal jobs on the existing request queue, so one can never overlap a user turn, and typing preempts a running pass.
  - Findings deduplicate on a server-computed fingerprint, and dismissing one suppresses it for a week.

## 0.4.0

- **Castle can now be a Home Assistant Assist conversation agent.** The add-on bundles a `castle_conversation` custom integration and installs it into HA's config dir on boot (one HA restart to load, then Supervisor discovery auto-prompts setup — or add it manually with **Add Integration → Castle**). Pick **Castle** as the conversation agent under **Settings → Voice assistants** and voice satellites, the Assist dialog, and the companion app route through Castle's LLM. Replies stream into the Assist chat as they generate (chat-log API, needs HA 2025.x+), and Assist turns share the conversation with the chat panel. Backed by a new `POST /conversation` endpoint (JSON or SSE).
- **Request queue with cancellation and background execution.** Prompts now queue visibly: a strip above the chat lists queued/running requests with per-request cancel, a topbar pill shows background activity from the Now/Dashboard views, and you can line up a follow-up while a turn is running. Closing the page no longer aborts an in-flight turn — the server runs it to completion and the result is waiting on reconnect.

## 0.3.5

- **Fix: charts for non-`binary_sensor` on/off entities showed "No data in range."** `ha_render_chart` mapped `on`/`off` history to 1/0 only for the `binary_sensor.` domain; fans, switches, lights, `input_boolean`, and every other on/off entity fell through to the numeric path, where `"on"`/`"off"` aren't finite numbers, so all points were dropped and the series came back empty. The mapping is now keyed off the state value rather than the domain (any `on`/`off` → 1/0), and the frontend re-derives binary-ness from the data (a series is binary when every point is 0/1), so the stepped line, on/off axis labels, and tooltip apply to all on/off domains.

## 0.3.4

- **Vendor the [homeassistant-ai/skills](https://github.com/homeassistant-ai/skills) best-practices bundle and gate write-class automation/dashboard tools on it.** New `ha_skill` tool returns `SKILL.md` (decision workflow + anti-patterns catalogue) by default, or one of ten deep-dive references (automation-patterns, safe-refactoring, helper-selection, template-guidelines, device-control, dashboard-guide, dashboard-cards, yaml-only-integrations, domain-docs, examples) when asked. `ha_create_automation`, `ha_update_automation`, and `ha_edit_dashboard` now refuse with a one-line instructional message until the skill has been loaded once per session. Reads, diffs, lists, and rollbacks are unaffected. The gate fires before HA is touched, so an accidental refusal is a no-op. `scripts/sync-skills.sh` re-pulls the bundle at a pinned upstream commit.
- **Fix dashboard entity validation.** The shared automation/dashboard validator only matched the `entity_id` key, which is rare in dashboards — most cards use `entity` (singular) or `entities` (mixed string-or-object list). `ha_edit_dashboard` now actually surfaces typos in dashboard card references; previously the "validates entity_ids" claim in the tool description was a no-op for the common card shapes.
- **Clean up the stale `ha_invoke` block in the system prompt.** The describe-then-invoke meta-tool was removed in 0.2.x but its instructions lingered in `AGENTS.md.jinja2`; replaced with concise notes about `ha_skill` and the read/write tool split.

## 0.3.3

- **Fix: thinking/text tokens doubled at the start of every block in the streaming UI.** 0.3.2's delta-only protocol appended deltas onto whatever the wire `*_start` event already contained, but pi-ai uses a live reference for `partial` and mutates it between event pushes, so by the time the WS subscriber serialized `thinking_start` the first chunk(s) had already accumulated. Reset the just-started content block to empty on `*_start` and let the deltas be the source of truth.
- **Fix: camera live feed / snapshot URLs were unreachable under HA ingress.** `<img>` srcs hard-coded `/camera/...` and `/camera_stream/...`, which resolved to the HA host root (404) instead of the add-on. Wrapped them with `withBase()`; the helper was already in use for `/ws`, `/history`, `/models`.
- **Per-socket filter on state_change broadcasts.** Track `(state, attrJSON, exposed, label)` per socket; skip identical re-emissions, send a `partial: true` frame carrying only `state` when only `state` moved (sensor noise, the common case). Client merges partials onto its cached EntityState. Measured against a 1062-entity install: 30 s window cut from ~300 B/frame full payloads to ~114 B/frame partials, all partials, zero fulls.
- **Drive `return_response` from the service registry instead of the LLM.** `ha_call_service` no longer exposes a `return_response` parameter — the server passes `true` iff the service registry says the service returns a response, and unconditionally renders the response when HA returns one. Removes a parameter the LLM was getting wrong on both sides (passing it on response-less services errors in HA; omitting it on response-bearing services silently discards data).
- **"New conversation" button in the chat composer.** Mirrors the drawer's "New chat" entry, so the bare `/chat` view that HA's ingress iframe loads now has a one-click reset. Same `agent.reset()` plumbing; prior session is preserved under `.pi-agent/sessions/` and resumable via the Sessions browser.

## 0.3.2

- **Compress and cache the browser bundle.** A post-build step (`web/scripts/compress-dist.mjs`) precomputes brotli (quality 11) and gzip siblings for every compressible asset > 1 KB; `serveStatic` negotiates `Accept-Encoding` and serves the matching precomputed file. Hashed `/assets/*` files get `Cache-Control: public, max-age=31536000, immutable`; `/` and `/index.html` stay `no-cache`. The main JS chunk drops 3.6 MB → 0.8 MB on cold load, and reloads pay zero bandwidth.
- **Strip duplicated payload from streaming WS frames.** Each `thinking_delta` / `text_delta` previously carried a full accumulated message snapshot in both `assistantMessageEvent.partial` and `event.message` — O(n²) bandwidth in token count. `partial` is now dropped unconditionally; for text/thinking deltas `event.message` is dropped too and the client rebuilds the streaming message from deltas. Frame size on a reasoning stream drops from ~1.2 KB/token to ~140 B/token. Tool-call deltas are unaffected (the live `partialArgs` accumulator on the content block is non-trivial to mirror client-side).

## 0.3.1

- Auto-reconnect the browser WebSocket when running behind HA's ingress proxy. The proxy silently drops idle sockets without sending a close frame, so the browser sat in `OPEN` state forever — `onclose` never fired, the existing reconnect never kicked in, and prompts queued into the void. Adds an app-level ping/pong heartbeat that force-closes the socket after 60 s of silence, and raises the reconnect backoff cap from 10 s to 60 s.

## 0.3.0

- **Remove scheduled / triggered tasks subsystem.** `schedule_task`, `list_tasks`, `cancel_task`, the camera-frame watcher loop, the tasks dialog and tasks chip in the topbar, and the `<DATA_DIR>/tasks/` persistence layer are all gone. The implementation never worked reliably in practice, and the surface area was costing more than it was paying for.

## 0.2.1

- Add `ha_manage` tool with three actions: `check_config` (validate YAML via the Supervisor `/core/check` endpoint), `reload` (`homeassistant.reload_all` — picks up YAML edits without restarting), `restart` (`homeassistant.restart`, ~30s downtime). Default-disabled; user opts in via Castle Settings.

## 0.2.0

- Add `ha_create_automation` tool for creating new automations from scratch (alias + triggers + actions); records as v1 in resource-history.
- Add `ha_list_addons` and `ha_update_addon` tools that hit Supervisor's `/addons` and `/addons/<slug>/update` endpoints. Requires the new `hassio_api: true` + `hassio_role: manager` capabilities in `config.yaml`.
- Lock down high-impact write tools by default: `ha_update_addon`, `ha_update_automation`, and `ha_edit_dashboard` are now disabled in a fresh install — the user has to explicitly enable them in Castle's Settings. Existing installs keep whatever they had previously enabled.

## 0.1.5

- Wrap the container CMD with `/usr/bin/with-contenv` so the HA s6-overlay init materialises `SUPERVISOR_TOKEN` / `HASSIO_TOKEN` into the process environment. Supervisor writes those tokens to files under `/var/run/s6/container_environment/`, not as plain env vars — without the wrapper a bare `CMD ["deno", …]` sees them unset and Castle falls through to `homeassistant.local:8123` as if running outside Supervisor.

## 0.1.3

- Fall back to the legacy `HASSIO_TOKEN` env var when `SUPERVISOR_TOKEN` isn't set. Older Supervisor versions only emit the legacy name, which is why 0.1.2 still fell through to the dev fallback and tried `homeassistant.local:8123` from inside the add-on container.
- Log the resolved HA connection mode at boot (`supervisor` / `explicit` / `fallback`), the URLs in use, and which token env vars were seen (without their values). Lets users diagnose URL/token confusion from the add-on Log tab without rebuilding with extra debug output.

## 0.1.2

- Use the Supervisor WebSocket proxy when running as an add-on. The proxy mounts HA's WebSocket API at `ws://supervisor/core/websocket` (no `/api/` segment), not at `/core/api/websocket` — Castle was hitting the latter and failing to authenticate. Setting `ha_url` and `ha_token` in add-on options still overrides, for users pointing Castle at a different HA instance.

## 0.1.1

- Switch runtime base from HA Alpine to HA Debian (`<arch>-base-debian:bookworm`). Alpine's `gcompat` shim is missing `__res_init`, so the glibc-linked Deno binary failed to load inside Supervisor with `Error relocating /usr/local/bin/deno: __res_init: symbol not found`. Debian is glibc-native; no shim needed.

## 0.1.0

- Initial Home Assistant add-on release.
- Ingress-based chat panel in the HA sidebar.
- Supervisor-issued HA token (no long-lived access token needed).
- LLM endpoint, type, model, and optional API key configurable via add-on options.
- Persistent state under `/data`.
- Builds from source on amd64 and aarch64.
