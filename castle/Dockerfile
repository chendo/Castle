ARG BUILD_FROM

# ---------------------------------------------------------------------------
# Stage 1 — build the browser bundle with Vite. Node is only needed here;
# the runtime image stays Deno-only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime. HA's official Debian base + Deno's official static
# binary. We don't use bashio — /data/options.json is parsed by Castle itself
# (see options.ts) so the entrypoint stays a single deno invocation.
#
# Why Debian and not Alpine: Deno only ships glibc-linked Linux builds
# (`*-unknown-linux-gnu`). On the Alpine HA base, those run through
# `gcompat`, which is incomplete — symbols like `__res_init` aren't
# polyfilled, and the binary errors with:
#   Error relocating /usr/local/bin/deno: __res_init: symbol not found
# at first invocation inside Supervisor. Debian is glibc-native, no shim
# needed, slightly larger image, but actually works.
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG DENO_VERSION=2.7.12

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates unzip; \
    rm -rf /var/lib/apt/lists/*; \
    case "${BUILD_ARCH}" in \
        amd64) DENO_ARCH=x86_64-unknown-linux-gnu ;; \
        aarch64) DENO_ARCH=aarch64-unknown-linux-gnu ;; \
        *) echo "unsupported BUILD_ARCH=${BUILD_ARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${DENO_ARCH}.zip" -o /tmp/deno.zip; \
    unzip /tmp/deno.zip -d /usr/local/bin/; \
    rm /tmp/deno.zip; \
    chmod +x /usr/local/bin/deno

WORKDIR /app

# Source files (only the ones main.ts actually imports + templates).
COPY deno.json deno.lock /app/
COPY *.ts /app/
COPY templates/ /app/templates/
COPY --from=web-build /web/dist /app/web/dist

# Persistent state lives at /data — Supervisor maps it to a managed volume
# that survives upgrades. paths.ts honours this via CASTLE_DATA_DIR.
ENV CASTLE_DATA_DIR=/data

# Pre-cache deno modules so first-boot doesn't pause on network fetch.
RUN deno cache main.ts || true

# Wrap the entrypoint in /usr/bin/with-contenv so the HA s6-overlay init
# materialises Supervisor's environment (notably SUPERVISOR_TOKEN /
# HASSIO_TOKEN) into the process. The token lives in
# /var/run/s6/container_environment/ and is NOT inherited by a plain CMD —
# without this wrapper the add-on starts but main.ts can't see the token
# and falls through to homeassistant.local as if running outside Supervisor.
CMD ["/usr/bin/with-contenv", "deno", "run", "--allow-all", "--unstable-node-globals", "main.ts"]
