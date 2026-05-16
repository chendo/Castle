# Vendored Skills

`home-assistant-best-practices/` is a verbatim copy of the upstream
[homeassistant-ai/skills](https://github.com/homeassistant-ai/skills)
agent skill bundle, pinned to commit
[`237ff71`](https://github.com/homeassistant-ai/skills/commit/237ff71091b5b791e869334a65cc5d98641a8376)
(May 2026).

The bundle teaches LLM agents the correct way to write Home Assistant
automations and dashboards — native conditions vs templates, helper
selection, mode choice, entity-vs-device id, safe refactoring, and
~20 critical anti-patterns. Castle exposes it via the `ha_skill` tool
and gates write-class automation/dashboard tools on it being loaded
once per session. See `tools.ts` and `templates/AGENTS.md.jinja2` for
the wiring.

## Updating

Run `scripts/sync-skills.sh <commit-sha>` to re-pull at a new pinned
commit. The script overwrites the bundle; review the diff before
committing. `UPSTREAM_LICENSE` is the project's MIT license at the
pinned commit.
