# Changelog

## 0.1.4

- Set `hassio_api: true` in `config.yaml` so Supervisor actually mints and injects a token. `homeassistant_api: true` alone wasn't sufficient on the user's Supervisor — the add-on installed but neither `SUPERVISOR_TOKEN` nor `HASSIO_TOKEN` appeared in the container env, so Castle fell back to `homeassistant.local:8123` and looped on DNS errors. Combined with the existing `hassio_role: default`, this grants the token Supervisor's minimal role.

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
