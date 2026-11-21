#!/usr/bin/env bash
# A browser check that needs no credentials and reaches nothing outside this machine.
#
#   scripts/smoke.sh                      the smoke case: test/e2e/chat.spec.ts
#   scripts/smoke.sh SPEC... [OPTIONS]    other specs, or any `playwright test` arguments
#   scripts/smoke.sh --keep ...           keep the run's folder (always kept when the run fails)
#   scripts/smoke.sh --bin dist/keel ...  run a built binary instead of the sources
#   scripts/smoke.sh --allow-network ...  where the kernel has no user namespaces (see below)
#
# One command starts a daemon of its own on the scripted provider
# (src/providers/scripted.ts), runs the specs against it and stops it. The
# daemon and the browser run:
# - in a throwaway folder that holds their home, state, config, workspace,
#   screenshots and traces (under $TMPDIR), removed after a green run;
# - with a clean environment: no variable of the caller reaches them, so no
#   key, no KEEL_URL and no state folder of another daemon does either;
# - in a network namespace of their own with only a loopback interface: no
#   request leaves the machine, and no other daemon is listening there.
#   --allow-network runs without the namespace (macOS, a kernel without user
#   namespaces): the credentials stay out of reach, the traffic is not blocked.
#
# Dependencies are installed before the network is cut. Exit code: Playwright's.
set -euo pipefail
TOP=$(cd "$(dirname "$0")/.." && pwd)

if [ -z "${KEEL_SMOKE_ROOT:-}" ]; then
  # Stage one, in the caller's world: the folder, the clean environment, the namespace.
  net=1; keep=0; bin=""; args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --allow-network) net=0 ;;
      --keep) keep=1 ;;
      --bin) bin=$(realpath "${2:?--bin takes the path of a built keel}"); shift ;;
      -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  for tool in bun curl; do command -v "$tool" > /dev/null || { echo "smoke: $tool is not on PATH" >&2; exit 2; }; done
  if [ "$net" = 1 ] && ! unshare --user --map-root-user --net true 2> /dev/null; then
    echo "smoke: this kernel gives no network namespace to a user (unshare --user --net failed)." >&2
    echo "       --allow-network runs without one: no credentials, but traffic is not blocked." >&2
    exit 2
  fi
  (cd "$TOP" && bun install --silent)
  # Named as the specs know a scratch folder (several run only against paths that hold keel-work).
  root=$(mktemp -d "${TMPDIR:-/tmp}/keel-work-smoke.XXXXXX")
  mkdir -p "$root/home" "$root/tmp"
  clean=(env -i
    PATH="$PATH" HOME="$root/home" TMPDIR="$root/tmp" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}"
    KEEL_SMOKE_ROOT="$root" KEEL_BIN="$bin"
    # Read-only stores of the caller: the browsers Playwright installed and Bun's package cache.
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
    BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"
    # The throwaway home has no git identity; specs commit in scratch repositories.
    GIT_AUTHOR_NAME="Keel smoke" GIT_AUTHOR_EMAIL="smoke@example.invalid"
    GIT_COMMITTER_NAME="Keel smoke" GIT_COMMITTER_EMAIL="smoke@example.invalid")
  rc=0
  if [ "$net" = 1 ]; then
    # The namespace is made as its root to bring the loopback up, then left for the caller's own user.
    "${clean[@]}" unshare --user --map-root-user --net -- bash -c \
      'ip link set lo up && exec unshare --user --map-user="$1" --map-group="$2" -- bash "${@:3}"' \
      _ "$(id -u)" "$(id -g)" "$TOP/scripts/smoke.sh" "${args[@]}" || rc=$?
  else
    "${clean[@]}" bash "$TOP/scripts/smoke.sh" "${args[@]}" || rc=$?
  fi
  if [ "$rc" = 0 ] && [ "$keep" = 0 ]; then rm -rf -- "$root"; else echo "smoke: the run's folder is kept at $root (daemon.log, shots, home/.cache/keel-work/bun/e2e-out)"; fi
  exit "$rc"
fi

# Stage two, inside: the daemon, the specs, the stop.
root=$KEEL_SMOKE_ROOT
cd "$TOP"
free() { ! (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }
port=0
for _ in 1 2 3 4 5 6 7 8; do port=$((20000 + RANDOM % 40000)); free "$port" && break; done
export KEEL_DEV_DIR="$root/dev" KEEL_SCRIPTED_PROVIDER=1 KEEL_DEFAULT_MODEL=scripted:stand-in
bash scripts/dev.sh "$port" > "$root/daemon.log" 2>&1 &
launcher=$!
stop() { kill "$launcher" 2> /dev/null || true; wait "$launcher" 2> /dev/null || true; }
trap stop EXIT
# Up when the daemon on the port says it is the one of this run's folder.
up=0
for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/daemon" 2> /dev/null | grep -q "\"$root/dev/state\""; then up=1; break; fi
  kill -0 "$launcher" 2> /dev/null || break
  sleep 0.5
done
if [ "$up" != 1 ]; then
  echo "smoke: the daemon did not come up on 127.0.0.1:$port" >&2
  tail -n 20 "$root/daemon.log" >&2
  exit 1
fi
export KEEL_URL="http://127.0.0.1:$port" KEEL_SHOTS="$root/shots" KEEL_TEST_MODEL=scripted:stand-in
[ "$#" -gt 0 ] || set -- test/e2e/chat.spec.ts
rc=0
bunx playwright test "$@" || rc=$?
exit "$rc"
