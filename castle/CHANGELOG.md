# Changelog

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
