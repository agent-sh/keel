#!/usr/bin/env bash
# Dev daemon on Bedrock with a scratch state dir. Usage: scripts/dev.sh <port>
# (KEEL_BIN=dist/keel runs the built binary instead of the hot-reloading source).
# The port is always given and the state is the port's own unless KEEL_DEV_DIR
# names one: two daemons never share a state folder by default.
set -euo pipefail
PORT="${1:?usage: scripts/dev.sh <port>}"
DEV="${KEEL_DEV_DIR:-$HOME/.cache/keel-work/bun/dev-$PORT}"
mkdir -p "$DEV/ws"
if [ -f "$HOME/.config/claude-code/bedrock.env" ]; then
  set -a; . "$HOME/.config/claude-code/bedrock.env"; set +a
fi
# A scratch daemon runs test turns: no desktop notifications unless asked for,
# and its own config folder, so specs never write the owner's (mcp.json, drive.json).
export KEEL_CONFIG_DIR="${KEEL_CONFIG_DIR:-$DEV/config}"
mkdir -p "$KEEL_CONFIG_DIR"
export KEEL_DESKTOP_NOTIFY="${KEEL_DESKTOP_NOTIFY:-off}"
# Stand-ins and scratch stores for what a scratch daemon would otherwise reach
# on the machine: gh, and the other harnesses' session stores for import.
# Each is kept when already set.
export KEEL_GH_BIN="${KEEL_GH_BIN:-$(cd "$(dirname "$0")/.." && pwd)/test/e2e/fixtures/gh-standin.sh}"
export KEEL_IMPORT_CLAUDE_DIR="${KEEL_IMPORT_CLAUDE_DIR:-$DEV/import/claude}"
export KEEL_IMPORT_CODEX_DIR="${KEEL_IMPORT_CODEX_DIR:-$DEV/import/codex}"
export KEEL_IMPORT_AGY_DIR="${KEEL_IMPORT_AGY_DIR:-$DEV/import/agy}"
export KEEL_IMPORT_KEEL_DB="${KEEL_IMPORT_KEEL_DB:-$DEV/import/keel.db}"
mkdir -p "$DEV/import"
# The tacit stand-in (never the owner's memory store) and the scripted
# provider for the paths a real model cannot be made to take. The owner hooks
# file lives in the scratch config folder.
export TACIT_BIN="${TACIT_BIN:-$(cd "$(dirname "$0")/.." && pwd)/test/e2e/fixtures/tacit-standin.sh}"
export KEEL_SCRIPTED_PROVIDER="${KEEL_SCRIPTED_PROVIDER:-1}"
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
# KEEL_BIN runs a built binary (bun scripts/build.ts) with the same scratch setup.
if [ -n "${KEEL_BIN:-}" ]; then
  exec "$KEEL_BIN" serve --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
fi
# Lanes add dependencies; a stale node_modules breaks the bundle at load.
bun install --silent
# Imported stylesheets reload too (the bundler watches only the entry stylesheet).
bun scripts/css-watch.ts "$$" &
exec bun --hot src/main.ts serve --dev --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
