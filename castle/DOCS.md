# Castle

Chat with your house. Castle bridges Home Assistant to an OpenAI-compatible
LLM you host yourself (LM Studio, llama.cpp, vLLM, Ollama, …) and exposes a
chat panel in the HA sidebar.

The full feature list, configuration reference, and troubleshooting guide
live in this add-on's [`README.md`](README.md). The most common boot issues
are reproduced below for the Supervisor documentation tab.

## Quick start

1. Stand up an OpenAI-compatible LLM endpoint somewhere on your network. LM
   Studio is the default target — set its server to listen on the LAN.
2. In **Configuration**, point `llm_url` at your endpoint, e.g.
   `http://192.168.1.50:1234/v1`. Set `model_name` to the model id you want.
3. Start the add-on. A **Castle** entry appears in the HA sidebar; the panel
   opens straight into the chat view.

The first message kicks off a real model call; if the status dot next to
**LLM** in the drawer footer stays red, double-check that `llm_url` is
reachable *from the HA host* (the add-on connects from inside Supervisor's
network — `localhost` will not resolve to your laptop).

## Use Castle as a voice assistant (Assist conversation agent)

Castle can register itself as a conversation agent so Home Assistant's **Assist**
pipeline — voice satellites, the companion-app chat, the Assist dialog — routes
through Castle (and therefore your own LLM). (Streaming replies use the chat-log
API, so a reasonably recent Home Assistant — 2025.x or newer — is required.)

When the add-on starts, it copies a small companion integration
(`castle_conversation`) into Home Assistant's `custom_components/` folder and
advertises itself via Supervisor discovery. To finish setup:

1. **Restart Home Assistant** (Core) once after first starting the add-on —
   Home Assistant only loads new integrations at startup. (The add-on log prints
   `[bridge] castle_conversation installed …` when the files land.)
2. A **"Castle — Configure?"** card should appear under **Settings → Devices &
   Services**; click it and confirm. The URL is filled in for you. If the card
   doesn't show, add it manually with **Add Integration → Castle** and use the
   add-on's internal hostname, e.g. `http://local-castle:7090` (a store install
   uses a hashed prefix — check the add-on page). Leave the token blank when
   running as the add-on.
3. Go to **Settings → Voice assistants**, edit (or add) an assistant, and pick
   **Castle** as the *Conversation agent*.

Replies stream into the Assist dialog as Castle generates them. Voice/Assist
turns share Castle's conversation and show up in the chat panel alongside what
you type there.

## Troubleshooting

**LLM status dot stays red.** Open the add-on Log and find
`[castle] llm probe failed` lines with the URL it tried. Almost always the
URL points at `localhost` while the LLM is on the host — use the host's LAN
IP instead.

**No entities visible in the catalog.** Castle filters by Home Assistant's
"exposed to assistants" list. Visit **Settings → Voice assistants → Expose**
and tick the entities you want Castle to see. The catalog refreshes within
a few seconds.

**Chat starts then 401s.** Clear the `ha_token` option if you've overridden
it with a stale long-lived token — Supervisor's auto-injected token is
sufficient for normal operation.
