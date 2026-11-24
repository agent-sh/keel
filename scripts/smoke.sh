#!/usr/bin/env bash
# A browser check that needs no credentials and reaches nothing outside this machine.
#
#   scripts/smoke.sh                      the smoke case: test/e2e/chat.spec.ts
#   scripts/smoke.sh SPEC... [OPTIONS]    other specs, or any `playwright test` arguments
#   scripts/smoke.sh --keep ...           keep the run's folder (always kept when the run fails)
#   scripts/smoke.sh --bin dist/keel ...  run a built binary instead of the sources
#   scripts/smoke.sh --allow-network ...  where the kernel has no user namespaces (see below)
#   scripts/smoke.sh --shots DIR ...      copy the run's screenshots to DIR at its end, green or not
#   scripts/smoke.sh --installed ...      the dependencies are there already: no install
#
# One command starts a daemon of its own on the scripted provider
# (src/providers/scripted.ts), runs the specs against it and stops it. The
# daemon and the browser run:
# - in a throwaway folder that holds their home, state, config, workspace,
#   screenshots and traces (under $TMPDIR), removed after a green run;
# - with a clean environment and a PATH of Bun, Node and the system's tools:
#   no variable of the caller reaches them (no key, no KEEL_URL, no state
#   folder of another daemon), and no command of the caller's own does;
# - with no keyring: no session bus address and a runtime folder of their own
#   (a keyring is reached through the session bus, whatever the home is), and
#   a keyring service name nothing is saved under;
# - in namespaces of their own: a network with only a loopback interface, so
#   no request leaves the machine and no other daemon listens there, and a
#   process tree that ends as a whole when the run does, however it ends.
#   --allow-network runs without them (macOS, a kernel without user
#   namespaces): the credentials stay out of reach, the traffic is not blocked.
#
# Before a spec runs, the daemon is asked which providers it has. A run whose
# daemon has any besides the scripted one (and the two that list with no key:
# local ACP agents, the catalog-only preset) is refused, in either mode.
#
# Dependencies are installed before the network is cut. Exit code: Playwright's.
set -euo pipefail
TOP=$(cd "$(dirname "$0")/.." && pwd)

if [ "${1:-}" != "__inside" ]; then
  # Stage one, in the caller's world: the folder, the clean environment, the namespaces.
  net=1; keep=0; bin=""; shots=""; install=1; args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --allow-network) net=0 ;;
      --keep) keep=1 ;;
      --bin) bin=$(realpath "${2:?--bin takes the path of a built keel}"); shift ;;
      --shots) shots=$(realpath -m "${2:?--shots takes a folder}"); shift ;;
      --installed) install=0 ;;
      -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  for tool in bun curl setsid; do command -v "$tool" > /dev/null || { echo "smoke: $tool is not on PATH" >&2; exit 2; }; done
  spaces=(--user --map-root-user --net --pid --fork --kill-child --mount-proc)
  if [ "$net" = 1 ] && ! unshare "${spaces[@]}" true 2> /dev/null; then
    echo "smoke: this kernel gives no namespaces to a user (unshare --user --net --pid failed)." >&2
    echo "       --allow-network runs without them: no credentials, but traffic is not blocked." >&2
    exit 2
  fi
  [ "$install" = 0 ] || (cd "$TOP" && bun install --silent)
  # Named as the specs know a scratch folder (several run only against paths that hold keel-work).
  # A pictures run (KEEL_PICTURES_FIXED, src/pictures/run.ts) gives each side a folder of its own as TMPDIR, the same
  # path on every side: the run's folder is then named the same each time, and so is every path the page shows.
  if [ -n "${KEEL_PICTURES_FIXED:-}" ] && [ -n "${TMPDIR:-}" ] && [ ! -e "$TMPDIR/keel-work-smoke.pictures" ]; then root="$TMPDIR/keel-work-smoke.pictures"; mkdir -m 700 "$root"
  else root=$(mktemp -d "${TMPDIR:-/tmp}/keel-work-smoke.XXXXXX"); fi
  mkdir -p "$root/home/run" "$root/tmp"
  chmod 700 "$root/home/run"
  # Bun, Node and the system's tools only: no agent CLI or helper of the caller is on it.
  path="$(dirname "$(command -v bun)")"
  command -v node > /dev/null && path="$path:$(dirname "$(command -v node)")"
  path="$path:/usr/local/bin:/usr/bin:/bin"
  dated=()
  if [ -n "${KEEL_PICTURES_FIXED:-}" ]; then at="@$((KEEL_PICTURES_FIXED / 1000)) +0000"; dated=(GIT_AUTHOR_DATE="$at" GIT_COMMITTER_DATE="$at"); fi
  clean=(env -i
    PATH="$path" HOME="$root/home" TMPDIR="$root/tmp" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}"
    KEEL_SMOKE_ROOT="$root" KEEL_BIN="$bin"
    # No keyring and no credential helper, whatever this machine has.
    KEEL_KEYRING_SERVICE=keel-scratch-empty KEEL_CRED_GET=/bin/false
    DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus XDG_RUNTIME_DIR="$root/home/run"
    KEEL_DESKTOP_NOTIFY=off
    # The sizes and themes each screenshot is taken at (test/e2e/shots.ts), when the caller names them.
    KEEL_SHOT_SIZES="${KEEL_SHOT_SIZES:-}" KEEL_SHOT_THEMES="${KEEL_SHOT_THEMES:-}"
    # A pictures run's instant: the scripted daemon's ids and clock are fixed from it (src/core/fixed-world.ts).
    KEEL_PICTURES_FIXED="${KEEL_PICTURES_FIXED:-}"
    # and every commit a spec makes is dated by it, so the same commit has the same id each time.
    "${dated[@]}"
    # Read-only stores of the caller: the browsers Playwright installed and Bun's package cache.
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
    BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}"
    # The throwaway home has no git identity; specs commit in scratch repositories.
    GIT_AUTHOR_NAME="Keel smoke" GIT_AUTHOR_EMAIL="smoke@example.invalid"
    GIT_COMMITTER_NAME="Keel smoke" GIT_COMMITTER_EMAIL="smoke@example.invalid")
  # Stage two leads a session of its own: what it started is found by its group when it is over.
  if [ "$net" = 1 ]; then
    # The namespaces are made as their root to bring the loopback up, then left for the caller's
    # own user. Stage two is the first process of the process namespace: when it ends, however
    # it ends, the kernel ends every process in it.
    setsid "${clean[@]}" unshare "${spaces[@]}" -- bash -c \
      'ip link set lo up && exec unshare --user --map-user="$1" --map-group="$2" -- bash "${@:3}"' \
      _ "$(id -u)" "$(id -g)" "$TOP/scripts/smoke.sh" __inside "${args[@]}" &
  else
    setsid "${clean[@]}" bash "$TOP/scripts/smoke.sh" __inside "${args[@]}" &
  fi
  lead=$!
  # Whatever of the run still lives: its process group, and what left the group
  # but still names the run's folder (the daemon leads a session of its own).
  left() { { pgrep -g "$lead" || true; pgrep -f -- "$root/" || true; } | sort -u; }
  sweep() {
    kill -TERM -- "-$lead" 2> /dev/null || true
    for pid in $(pgrep -f -- "$root/" || true); do kill -TERM "$pid" 2> /dev/null || true; done
    for _ in $(seq 1 60); do [ -z "$(left)" ] && return 0; sleep 0.25; done
    kill -KILL -- "-$lead" 2> /dev/null || true
    for pid in $(left); do kill -KILL "$pid" 2> /dev/null || true; done
  }
  trap 'sweep; exit 130' INT TERM HUP
  rc=0
  wait "$lead" || rc=$?
  [ -z "$(left)" ] || sweep
  if [ -n "$shots" ]; then mkdir -p "$shots"; find "$root/shots" -maxdepth 1 \( -name '*.png' -o -name 'shots.tsv' \) -exec cp -t "$shots" {} + 2> /dev/null || true; fi
  if [ "$rc" = 0 ] && [ "$keep" = 0 ]; then rm -rf -- "$root"; else echo "smoke: the run's folder is kept at $root (daemon.log, shots, home/.cache/keel-work/bun/e2e-out)"; fi
  exit "$rc"
fi

# Stage two, inside: the daemon, the provider check, the specs, the stop.
shift
root=${KEEL_SMOKE_ROOT:-}
# Only as stage one starts it: in the run's own folder and home.
case "$root" in */keel-work-smoke.*) ;; *) echo "smoke: stage two runs only from scripts/smoke.sh itself" >&2; exit 2 ;; esac
[ "$HOME" = "$root/home" ] && [ -d "$root/home" ] || { echo "smoke: stage two runs only with the run's own home ($root/home), and HOME is $HOME" >&2; exit 2; }
cd "$TOP"
free() { ! (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }
# Below the range the kernel gives to outgoing connections (32768 and up), where a
# port that was free can be taken before the daemon binds it.
port=0
for _ in 1 2 3 4 5 6 7 8; do port=$((20000 + RANDOM % 12000)); free "$port" && break; done
# A pictures run takes the same port each time when it is free (the page can show its address): in a network
# of its own every port is.
if [ -n "${KEEL_PICTURES_FIXED:-}" ] && free 24680; then port=24680; fi
export KEEL_DEV_DIR="$root/dev" KEEL_SCRIPTED_PROVIDER=1 KEEL_DEFAULT_MODEL=scripted:stand-in
bash scripts/dev.sh "$port" > "$root/daemon.log" 2>&1 &
launcher=$!
stop() { kill "$launcher" 2> /dev/null || true; wait "$launcher" 2> /dev/null || true; }
trap stop EXIT
# Up when the daemon on the port says it is the one of this run's folder.
url=http://127.0.0.1:$port
up=0
for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "$url/api/daemon" 2> /dev/null | grep -q "\"$root/dev/state\""; then up=1; break; fi
  kill -0 "$launcher" 2> /dev/null || break
  sleep 0.5
done
if [ "$up" != 1 ]; then
  echo "smoke: the daemon did not come up on 127.0.0.1:$port" >&2
  tail -n 20 "$root/daemon.log" >&2
  exit 1
fi
# No spec runs against a daemon that found a key or a sign-in. A source never read yet
# counts as there until its first read, so the listings are read first, and the answer
# is given a moment to settle.
others() {
  curl -fsS --max-time 10 "$url/api/providers" | bun -e '
    const d = JSON.parse(await Bun.stdin.text());
    const allowed = new Set(["scripted", "acp", "alibaba"]);
    console.log((d.providers ?? d).filter((p) => p.available && !allowed.has(p.id)).map((p) => p.id).sort().join(" "));'
}
curl -fsS --max-time 60 "$url/api/models?refresh=1" > /dev/null || true
real=unread
for _ in $(seq 1 30); do real=$(others) && [ -z "$real" ] && break; sleep 0.5; done
if [ -n "$real" ]; then
  echo "smoke: the daemon has providers besides the scripted one available ($real): a key or a sign-in was found. No spec was run." >&2
  exit 1
fi
export KEEL_URL="$url" KEEL_SHOTS="$root/shots" KEEL_TEST_MODEL=scripted:stand-in
[ "$#" -gt 0 ] || set -- test/e2e/chat.spec.ts
rc=0
bunx playwright test "$@" || rc=$?
exit "$rc"
