#!/usr/bin/env bash
# Dev daemon on Bedrock with a scratch state dir. Usage: scripts/dev.sh <port>
# (KEEL_BIN=dist/keel runs the built binary instead of the hot-reloading source).
# The port is always given and the state is the port's own unless KEEL_DEV_DIR
# names one: two daemons never share a state folder by default.
# Pick a port below 32768. The kernel hands the ports above it to outgoing
# connections, so one that was free can be taken before the daemon binds it
# (the daemon then exits and says so).
set -euo pipefail
PORT="${1:?usage: scripts/dev.sh <port>}"
DEV="${KEEL_DEV_DIR:-$HOME/.cache/keel-work/bun/dev-$PORT}"
mkdir -p "$DEV/ws"
if [ -f "$HOME/.config/claude-code/bedrock.env" ]; then
  set -a; . "$HOME/.config/claude-code/bedrock.env"; set +a
fi
# A scratch daemon runs test turns: no desktop notifications, its own config
# folder (specs never write the owner's mcp.json or drive.json), and a stand-in
# or a scratch folder for everything else it would reach on the machine (gh, the
# other harnesses' stores, the MCP registry, tacit, mail, voice, the phone, ssh).
# The list is scripts/scratch-env.ts, the same one a spec's own daemon gets;
# each name is kept when already set.
standins=$(bun "$(dirname "$0")/../scripts/scratch-env.ts" "$DEV")
eval "$standins"
cd "$(dirname "$0")/.."
# KEEL_BIN runs a built binary (bun scripts/build.ts) with the same scratch setup.
if [ -n "${KEEL_BIN:-}" ]; then
  exec "$KEEL_BIN" serve --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
fi
# Lanes add dependencies; a stale node_modules breaks the bundle at load.
bun install --silent
# The launcher starts the daemon and stays with whichever daemon holds the state
# (one that restarted itself is a new process): imported stylesheets reload too,
# and a source file that went missing and came back (see scripts/dev-watch.ts).
# Stopping it stops the daemon.
exec bun scripts/dev-watch.ts "$DEV/state" -- bun --hot src/main.ts serve --dev --bind "127.0.0.1:$PORT" --state-dir "$DEV/state" --workspace "$DEV/ws"
