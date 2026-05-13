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
# Stage 2 — runtime. HA's official Alpine base + Deno's official static
# binary. We don't use bashio — /data/options.json is parsed by Castle itself
# (see options.ts) so the entrypoint stays a single deno invocation.
# ---------------------------------------------------------------------------
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG DENO_VERSION=2.7.12

RUN set -eux; \
    apk add --no-cache curl unzip gcompat libstdc++ libgcc; \
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

CMD ["deno", "run", "--allow-all", "--unstable-node-globals", "main.ts"]
