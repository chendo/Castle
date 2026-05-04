#!/usr/bin/env bash
# Run integration tests against a test-specific Home Assistant demo instance.
#
# Usage:  ./scripts/run-integration-tests.sh [--down]
#
# Prerequisites:
#   - .env.test (copied from .env.test.example) with MODEL_NAME, OPENAI_API_KEY, etc.
#   - An external OpenAI-compatible server (LM Studio, vLLM, etc.) reachable from the
#     castle container — typically http://host.docker.internal:1234/v1 on macOS/Docker
#     Desktop; on Linux you may need --network host or a custom extra_hosts entry.
#   - Docker Compose available.
#
# The script:
#   1. Starts ha-demo + castle in the same compose project (ports overridden).
#   2. Waits for HA to be healthy and Castle WS to accept connections.
#   3. Runs deno task test:integration inside the castle container.
#   4. Tears everything down on exit (success, failure, or SIGINT/SIGTERM).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Load env ────────────────────────────────────────────────────────────────
if [[ -f "$PROJECT_DIR/.env.test" ]]; then
  set -a
  source "$PROJECT_DIR/.env.test"
  set +a
else
  echo "Error: .env.test not found. Copy .env.test.example and fill in values." >&2
  exit 1
fi

HA_PORT="${CASTLE_TEST_HA_PORT:-9123}"
CASTLE_PORT="${CASTLE_TEST_CASTLE_PORT:-7092}"
WS_URL="${CASTLE_WS_URL:-ws://localhost:${CASTLE_PORT}/ws}"
DOWN_LATER=false

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { echo "[integration] $(date '+%H:%M:%S') $*"; }
die()  { log "ERROR: $*" >&2; exit 1; }

wait_for_ha() {
  local retries=0
  local max_retries=60  # 5min at 5s intervals (HA demo can take a while to boot)
  while ! curl -sf "http://localhost:${HA_PORT}/api/" >/dev/null 2>&1; do
    ((retries++)) || true
    if (( retries >= max_retries )); then
      die "HA demo did not become healthy after ${max_retries} attempts"
    fi
    log "Waiting for HA demo on port ${HA_PORT}... (${retries}/${max_retries})"
    sleep 5
  done
  log "HA demo is ready."
}

wait_for_ws() {
  local retries=0
  local max_retries=40  # ~3min
  while ! curl -sfI --header "Connection: Upgrade" \
        --header "Upgrade: websocket" \
        --header "Sec-WebSocket-Version: 13" \
        --header "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "http://localhost:${CASTLE_PORT}/ws/" >/dev/null 2>&1; do
    ((retries++)) || true
    if (( retries >= max_retries )); then
      die "Castle WS did not become ready on port ${CASTLE_PORT} after ${max_retries} attempts"
    fi
    log "Waiting for Castle WS on port ${CASTLE_PORT}... (${retries}/${max_retries})"
    sleep 5
  done
  log "Castle WS is ready."
}

teardown() {
  if [[ "$DOWN_LATER" == true ]]; then
    log "Tearing down services..."
    docker compose -f "$PROJECT_DIR/docker-compose.yml" --profile default stop ha-demo castle 2>/dev/null || true
    docker compose -f "$PROJECT_DIR/docker-compose.yml" --profile default rm -f ha-demo castle 2>/dev/null || true
    log "Done."
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

trap teardown EXIT INT TERM

# Parse args — if caller passes --down, skip starting services (they're already up)
for arg in "$@"; do
  case "$arg" in
    --down) DOWN_LATER=false ;;  # don't tear down if externally managed
  esac
done

DOWN_LATER=true

log "Starting test environment..."

# Write a temporary .env for docker compose that overrides HA_URL and ports.
# We use DOCKER_COMPOSE_PROJECT_NAME to avoid conflicts with the default project name.
export COMPOSE_PROJECT_NAME="castle-test"
export COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# Override env vars for this compose run so castle points at ha-demo
cat > "$PROJECT_DIR/.env.test.compose" <<EOF
HA_URL=http://ha-demo:8123
OPENAI_URL=${OPENAI_URL:-http://host.docker.internal:1234/v1}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
MODEL_NAME=${MODEL_NAME:-}
CASTLE_PORT=${CASTLE_PORT}
CASTLE_TEST_HA_PORT=${HA_PORT}
EOF

export COMPOSE_ENV_FILE="$PROJECT_DIR/.env.test.compose"

# Start services (ha-demo must start first; depends_on handles ordering)
docker compose -f "$COMPOSE_FILE" --profile default up -d ha-demo castle 2>&1 | while read -r line; do log "$line"; done

wait_for_ha
wait_for_ws

log "Running integration tests..."
EXIT_CODE=0
docker compose exec -e HA_URL=http://ha-demo:8123 \
                 -e OPENAI_URL="${OPENAI_URL:-http://host.docker.internal:1234/v1}" \
                 -e MODEL_NAME="${MODEL_NAME}" \
                 -e CASTLE_WS_URL="ws://localhost:${CASTLE_PORT}/ws" \
                 -e CASTLE_STATES_URL="http://localhost:${CASTLE_PORT}/states" \
                 -e CASTLE_TEST_HA_PORT="${HA_PORT}" \
                 castle deno task test:integration 2>&1 || EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  log "Integration tests FAILED (exit code ${EXIT_CODE})."
else
  log "All integration tests passed."
fi

# Keep services running for manual inspection if tests fail
if [[ $EXIT_CODE -eq 0 ]]; then
  teardown
fi

exit $EXIT_CODE
