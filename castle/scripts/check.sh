#!/usr/bin/env bash
# Run all checks: deno typecheck + lint, web tsc.
# Used by the pre-commit hook and runnable manually.
#
# Speed: prefers `docker compose exec` (warm castle container). Falls back to
# `docker compose run --rm` (cold start) if castle isn't running.

set -euo pipefail

cd "$(dirname "$0")/.."

deno_run() {
  if docker compose ps --status running --services 2>/dev/null | grep -q '^castle$'; then
    docker compose exec -T castle "$@"
  else
    docker compose run --rm castle "$@"
  fi
}

# Delegates to the `check` task so the checked-file set lives in deno.json only.
# This script used to carry its own five-file list, which silently drifted from
# deno.json's (itself stale) list — between them, most of the tree went
# unchecked for several releases.
echo "[check] deno check + lint..."
deno_run deno task check

echo "[check] deno test (unit)..."
deno_run deno task test:unit

echo "[check] web tsc..."
if [ -d web/node_modules ]; then
  (cd web && npx --no-install tsc --noEmit)
else
  echo "[check] web/node_modules missing — skipping. Run 'docker compose run --rm web-build' once."
fi

echo "[check] OK"
