# Castle — Home Assistant add-on repository

This repository hosts the **Castle** Home Assistant add-on: a local-first,
low-latency agent that bridges HA to an OpenAI-compatible LLM (LM Studio,
vLLM, llama.cpp, Ollama, …) and exposes a chat panel in the HA sidebar.

## Install in Home Assistant

1. Open Home Assistant → **Settings → Add-ons → Add-on Store**.
2. From the ⋮ menu (top-right) pick **Repositories**.
3. Paste this repository's URL:

   ```
   https://github.com/chendo/castle
   ```

4. Click **Add**, refresh the store, and you'll see **Castle** under the new
   repository row. Install it from there.

See [`castle/README.md`](castle/README.md) for the feature list, configuration
options, and troubleshooting; [`castle/DOCS.md`](castle/DOCS.md) for the
in-Supervisor documentation tab.

## Repository layout

```
.
├── repository.yaml         # HA add-on repository metadata
├── README.md               # you are here
└── castle/                 # the Castle add-on
    ├── config.yaml         # add-on manifest (slug, version, options, …)
    ├── build.yaml          # per-arch base images
    ├── Dockerfile          # add-on build recipe
    ├── CHANGELOG.md
    ├── DOCS.md
    ├── README.md
    └── …                   # Deno + Vite source for the add-on itself
```

## Development

Castle is a Deno + Vite project. Contributor docs (env vars, docker-compose
workflow, tests, conventions) live in [`castle/AGENTS.md`](castle/AGENTS.md)
and [`castle/CLAUDE.md`](castle/CLAUDE.md). Start there if you're hacking
on the add-on rather than just installing it.
