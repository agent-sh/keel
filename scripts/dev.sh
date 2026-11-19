#!/usr/bin/env bash
# Dev daemon on Bedrock with a scratch state dir. Usage: scripts/dev.sh [port]
set -euo pipefail
PORT="${1:-47961}"
DEV="${KEEL_DEV_DIR:-$HOME/.cache/keel-work/bun/dev}"
mkdir -p "$DEV/ws"
if [ -f "$HOME/.config/claude-code/bedrock.env" ]; then
  set -a; . "$HOME/.config/claude-code/bedrock.env"; set +a
fi
# A scratch daemon runs test turns: no desktop notifications unless asked for,
# and its own config folder, so specs never write the owner's (mcp.json, drive.json).
export KEEL_CONFIG_DIR="${KEEL_CONFIG_DIR:-$DEV/config}"
mkdir -p "$KEEL_CONFIG_DIR"
export KEEL_DESKTOP_NOTIFY="${KEEL_DESKTOP_NOTIFY:-off}"
# Voice goes to the parlar stand-in beside the state, never the owner's own
# parlar (its mic and speaker); KEEL_PARLAR picks another.
if [ -z "${KEEL_PARLAR:-}" ]; then
  mkdir -p "$DEV/parlar"
  install -m 755 "$(dirname "$0")/../test/e2e/fixtures/parlar-standin.py" "$DEV/parlar/parlar"
  export KEEL_PARLAR="$DEV/parlar/parlar"
fi
# Phone control goes to a socket beside the state (the phone e2e starts its
# stand-in gateway there), never the owner's Hermes gateway and phone.
export KEEL_PHONE_SOCKET="${KEEL_PHONE_SOCKET:-$DEV/phone/phone.sock}"
mkdir -p "$(dirname "$KEEL_PHONE_SOCKET")"
cd "$(dirname "$0")/.."
# Lanes add dependencies; a stale node_modules breaks the bundle at load.
bun install --silent
# Imported stylesheets reload too (the bundler watches only the entry stylesheet).
bun scripts/css-watch.ts "$$" &
exec bun --hot src/main.ts serve --dev --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
