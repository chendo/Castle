#!/usr/bin/env bash
# Run all checks: deno typecheck + lint, web tsc.
# Used by the pre-commit hook and runnable manually.
#
# Speed: prefers `docker compose exec` (warm hai container). Falls back to
# `docker compose run --rm` (cold start) if hai isn't running.

set -euo pipefail

cd "$(dirname "$0")/.."

deno_run() {
  if docker compose ps --status running --services 2>/dev/null | grep -q '^hai$'; then
    docker compose exec -T hai "$@"
  else
    docker compose run --rm hai "$@"
  fi
}

echo "[check] deno check..."
deno_run deno check main.ts agent.ts catalog.ts ha-client.ts tools.ts

echo "[check] deno lint..."
deno_run deno lint

echo "[check] deno test (unit)..."
deno_run deno task test:unit

echo "[check] web tsc..."
if [ -d web/node_modules ]; then
  (cd web && npx --no-install tsc --noEmit)
else
  echo "[check] web/node_modules missing — skipping. Run 'docker compose run --rm web-build' once."
fi

echo "[check] OK"
