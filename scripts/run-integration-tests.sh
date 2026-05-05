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
  # Probe an unauthenticated endpoint — /api/ returns 401 once HA is up which
  # curl -f reports as failure, so we'd never see the container as ready.
  while ! curl -sfS "http://localhost:${HA_PORT}/manifest.json" >/dev/null 2>&1; do
    ((retries++)) || true
    if (( retries >= max_retries )); then
      die "HA demo did not become healthy after ${max_retries} attempts"
    fi
    log "Waiting for HA demo on port ${HA_PORT}... (${retries}/${max_retries})"
    sleep 5
  done
  log "HA demo is ready."
}

# Bootstrap an access token against ha-demo: onboard the initial owner user
# and exchange the auth code for a token. Each run wipes .storage/ first so
# onboarding always works on a clean slate — the access token from a previous
# run would have expired by now, and the user from a previous run would block
# fresh onboarding. Determinism wins over the few seconds we'd save by caching.
bootstrap_ha_token() {
  local storage_dir="$PROJECT_DIR/tests/integration/ha-demo-config/.storage"
  local base="http://localhost:${HA_PORT}"
  local onboard_payload='{"client_id":"http://localhost:8123/","name":"Castle Test","username":"test","password":"test","language":"en"}'
  local onboard_code onboard

  log "Onboarding ha-demo owner user..."
  onboard_code=$(curl -sS -o /tmp/castle_onboard.json -w '%{http_code}' \
    -X POST "$base/api/onboarding/users" \
    -H "Content-Type: application/json" \
    -d "$onboard_payload")
  onboard=$(cat /tmp/castle_onboard.json)

  if [[ "$onboard_code" == "403" ]]; then
    log "Onboarding already done in this .storage/ — wiping for clean run."
    docker compose "${COMPOSE_ARGS[@]}" stop ha-demo >/dev/null 2>&1 || true
    rm -rf "$storage_dir"
    docker compose "${COMPOSE_ARGS[@]}" up -d ha-demo >/dev/null 2>&1
    wait_for_ha
    onboard_code=$(curl -sS -o /tmp/castle_onboard.json -w '%{http_code}' \
      -X POST "$base/api/onboarding/users" \
      -H "Content-Type: application/json" \
      -d "$onboard_payload")
    onboard=$(cat /tmp/castle_onboard.json)
  fi
  [[ "$onboard_code" == "200" ]] || die "Onboarding failed (HTTP $onboard_code): $onboard"

  local auth_code
  auth_code=$(echo "$onboard" | jq -r '.auth_code // empty')
  [[ -n "$auth_code" ]] || die "Onboarding response missing auth_code: $onboard"

  log "Exchanging auth code for access token..."
  local token_resp access_token expires_in
  token_resp=$(curl -sfS -X POST "$base/auth/token" \
    --data-urlencode "client_id=http://localhost:8123/" \
    --data-urlencode "grant_type=authorization_code" \
    --data-urlencode "code=$auth_code") \
    || die "Token exchange failed."
  access_token=$(echo "$token_resp" | jq -r '.access_token // empty')
  expires_in=$(echo "$token_resp" | jq -r '.expires_in // 0')
  [[ -n "$access_token" ]] || die "Token exchange response missing access_token: $token_resp"

  # The access token expires (~30 min by default in HA). The LLAT endpoint
  # would survive longer but isn't reliably available across HA versions; the
  # access token's lifetime comfortably covers a single test run.
  HA_TOKEN="$access_token"
  export HA_TOKEN
  log "HA_TOKEN obtained (expires in ${expires_in}s)."
}

wait_for_ws() {
  local retries=0
  local max_retries=40  # ~3min
  # /health responds as soon as Deno.serve is listening — simpler than faking
  # a WebSocket upgrade handshake, and the WS endpoint sits behind the same
  # listener so its readiness implies /ws is up too.
  while ! curl -sfS "http://localhost:${CASTLE_PORT}/health" >/dev/null 2>&1; do
    ((retries++)) || true
    if (( retries >= max_retries )); then
      die "Castle did not become ready on port ${CASTLE_PORT} after ${max_retries} attempts"
    fi
    log "Waiting for Castle on port ${CASTLE_PORT}... (${retries}/${max_retries})"
    sleep 5
  done
  log "Castle is ready."
}

teardown() {
  if [[ "$DOWN_LATER" == true ]]; then
    log "Tearing down services..."
    docker compose --env-file "$PROJECT_DIR/.env.test.compose" -f "$PROJECT_DIR/docker-compose.yml" stop ha-demo castle 2>/dev/null || true
    docker compose --env-file "$PROJECT_DIR/.env.test.compose" -f "$PROJECT_DIR/docker-compose.yml" rm -f ha-demo castle 2>/dev/null || true
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

# Isolate from the dev stack: separate compose project + unique container names
# so a `docker compose up castle` running on the host isn't disturbed.
export COMPOSE_PROJECT_NAME="castle-test"
export COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
export CASTLE_CONTAINER_NAME="castle-test"
export HA_DEMO_CONTAINER_NAME="ha-demo-test"

# Override env vars for this compose run so castle (the test instance) points
# at the in-network ha-demo by its compose *service* name, which resolves
# regardless of container_name.
cat > "$PROJECT_DIR/.env.test.compose" <<EOF
HA_URL=http://ha-demo:8123
OPENAI_URL=${OPENAI_URL:-http://host.docker.internal:1234/v1}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
MODEL_NAME=${MODEL_NAME:-}
CASTLE_PORT=${CASTLE_PORT}
CASTLE_TEST_HA_PORT=${HA_PORT}
CASTLE_CONTAINER_NAME=${CASTLE_CONTAINER_NAME}
HA_DEMO_CONTAINER_NAME=${HA_DEMO_CONTAINER_NAME}
EOF

# --env-file feeds Docker Compose's variable substitution (the ${VAR} expressions
# in docker-compose.yml). It is independent from the per-service `env_file:`
# directive, which still reads .env into the container at runtime.
COMPOSE_ARGS=(--env-file "$PROJECT_DIR/.env.test.compose" -f "$COMPOSE_FILE")

# Start ha-demo first; we need it healthy before we can mint an HA_TOKEN, and
# castle must boot with that token already in its environment so the initial
# HA-connect succeeds. Two-phase startup beats restarting castle.
docker compose "${COMPOSE_ARGS[@]}" up -d ha-demo 2>&1 | while read -r line; do log "$line"; done
wait_for_ha
bootstrap_ha_token

# HA_TOKEN now in shell env; append to .env.test.compose so docker compose
# substitutes it into castle's environment when we bring it up.
echo "HA_TOKEN=$HA_TOKEN" >> "$PROJECT_DIR/.env.test.compose"

docker compose "${COMPOSE_ARGS[@]}" up -d castle 2>&1 | while read -r line; do log "$line"; done
wait_for_ws

log "Running integration tests..."
EXIT_CODE=0
docker compose "${COMPOSE_ARGS[@]}" exec \
                 -e HA_URL=http://ha-demo:8123 \
                 -e HA_TOKEN="${HA_TOKEN}" \
                 -e OPENAI_URL="${OPENAI_URL:-http://host.docker.internal:1234/v1}" \
                 -e MODEL_NAME="${MODEL_NAME}" \
                 -e CASTLE_WS_URL="ws://localhost:7090/ws" \
                 castle deno task test:integration 2>&1 || EXIT_CODE=$?
# CASTLE_WS_URL points at the in-container listen port, not the host-mapped
# CASTLE_PORT — `docker compose exec` runs the test process inside castle.

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
