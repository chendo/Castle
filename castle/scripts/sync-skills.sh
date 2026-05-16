#!/usr/bin/env bash
# Re-pull the homeassistant-ai/skills bundle at a pinned commit.
# Usage: scripts/sync-skills.sh <commit-sha>
set -euo pipefail

SHA="${1:-}"
if [[ -z "$SHA" ]]; then
  echo "usage: $0 <commit-sha>" >&2
  echo "  see https://github.com/homeassistant-ai/skills for available refs" >&2
  exit 2
fi

# Run from castle/ regardless of where the script is invoked.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CASTLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DIR="$CASTLE_DIR/skills/home-assistant-best-practices"
LICENSE_OUT="$CASTLE_DIR/skills/UPSTREAM_LICENSE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching homeassistant-ai/skills@$SHA …"
curl -sSL -o "$TMP/skills.tar.gz" \
  "https://github.com/homeassistant-ai/skills/archive/$SHA.tar.gz"

cd "$TMP"
tar xzf skills.tar.gz
SRC="$TMP/skills-$SHA"
if [[ ! -d "$SRC/skills/home-assistant-best-practices" ]]; then
  echo "Tarball didn't contain the expected layout — bad SHA?" >&2
  exit 1
fi

rm -rf "$SKILLS_DIR"
cp -r "$SRC/skills/home-assistant-best-practices" "$SKILLS_DIR"
# evals/ contains test fixtures (~MB of YAML) not needed at runtime.
rm -rf "$SKILLS_DIR/evals"
cp "$SRC/LICENSE" "$LICENSE_OUT"

echo "Synced to $SHA. Review changes:"
echo "  git diff --stat castle/skills/"
echo ""
echo "Don't forget to update the commit reference in castle/skills/README.md."
