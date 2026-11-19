#!/usr/bin/env bash
# Dev daemon on Bedrock with a scratch state dir. Usage: scripts/dev.sh [port]
set -euo pipefail
PORT="${1:-47961}"
DEV="${KEEL_DEV_DIR:-$HOME/.cache/keel-work/bun/dev}"
mkdir -p "$DEV/ws"
if [ -f "$HOME/.config/claude-code/bedrock.env" ]; then
  set -a; . "$HOME/.config/claude-code/bedrock.env"; set +a
fi
cd "$(dirname "$0")/.."
# Lanes add dependencies; a stale node_modules breaks the bundle at load.
bun install --silent
exec bun --hot src/main.ts serve --dev --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
