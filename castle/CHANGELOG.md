# Changelog

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
