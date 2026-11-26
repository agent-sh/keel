#!/usr/bin/env bash
# The landing queue's after step for this repository (land.after in .keel/checks.json): the landed
# commit is built into a binary and installed over the daemon whose queue landed it, gracefully.
#
#   bash .keel/land-install.sh                  the after step: in the checkout at KEEL_LANDED
#   bash DIR/install.sh --install SHA DIR       the install itself, started by the after step
#
# The after step checks that the landing reached origin (this repository's own address) and that
# origin's base is the landed commit, and that the daemon is a compiled Keel; it builds the commit
# from a checkout of its own into its own folder (KEEL_LAND_DIR, else ~/.cache/keel-land/<commit>),
# refuses a binary that does not name exactly that commit, and decides which install the commit needs over the daemon
# that runs (scripts/install-kind.ts): none, when nothing the binary or the page uses changed (docs, tests, files the
# binary never imports); the page alone, when only the page did, through `keel ui install`, with no restart (the
# daemon's pid and its turns go on); else the engine, as below. Each says which in its output, its status and its
# receipt. A change that cannot be compared is the engine's.
# The engine's install starts apart from the daemon (a user unit of the
# service manager, else a process of its own session): the install stops the daemon, and with it
# everything the daemon started. The install waits its turn (one at a time), puts the binary in
# the place of the one the daemon runs from, and asks the daemon to restart. The daemon decides
# when: it may hold the restart until the owner steps away from his pages, so the install waits
# for the new daemon (40 minutes at most, KEEL_LAND_WAIT_MIN), then checks that it runs the new
# binary and serves its page. Its state is the file <folder>/status: checking, installing,
# waiting, verified (receipt.json says which of the three installs was made), or failed (install.log says why, and the daemon's Errors panel); a failure after
# the binary was replaced puts the previous one back unless a new daemon already runs: a wait in which the old daemon
# is gone and nothing answers for a minute is such a failure (the service manager then starts the previous binary).
# Nothing runs as root.
set -euo pipefail
umask 077
ORIGIN_URL=https://github.com/agent-sh/keel.git

fail() { echo "land-install: $*" >&2; exit 1; }
status() { printf '%s\n' "$1" > "$d/status.new"; mv -fT "$d/status.new" "$d/status"; }
pidof_daemon() { curl -fsS --max-time 5 "$1/api/daemon" | bun -e 'const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.draining ? "" : d.pid ?? ""))'; }
# The install a commit needs that is not the engine's, done here: none, or the page alone. Returns 0 when it is done,
# 1 when the engine must be replaced (the reason said), and fails when a page it installed is not the one served.
# Its caller holds the install lock. Args: commit, folder, daemon address.
light() {
  local c=$1 d=$2 url=$3 j kind why pid after page
  j=$(bun "$d/install-kind.ts" "$d" "$(cat "$d/repo")" "$url") || { echo "land-install: which install ${c:0:12} needs could not be decided: the engine is replaced"; return 1; }
  kind=$(printf '%s' "$j" | bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).kind)')
  why=$(printf '%s' "$j" | bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).why)')
  printf '%s\n' "$kind" > "$d/kind"
  case $kind in
    none)
      printf '{"commit":"%s","kind":"none"}\n' "$c" > "$d/receipt.json"
      status verified
      echo "land-install: ${c:0:12}: $why" ;;
    page)
      pid=$(pidof_daemon "$url") || pid=""
      [[ $pid =~ ^[0-9]+$ ]] || { echo "land-install: no daemon that is not draining answers at $url: the engine is replaced"; return 1; }
      if ! "$d/keel" ui install "$d/keel-ui.tar.gz" --url "$url" > "$d/ui-install.log" 2>&1; then
        echo "land-install: the page install was refused ($(tail -n 1 "$d/ui-install.log" | cut -c1-300)): the engine is replaced"
        return 1
      fi
      page=$(bun -e 'process.stdout.write(JSON.parse(await Bun.file(process.argv[1]).text()).page)' "$d/keel.inputs.json")
      curl -fsS --max-time 5 "$url/api/ui" | bun -e "const u = JSON.parse(await Bun.stdin.text()); if (u.active?.page !== '$page') process.exit(1)" || fail "the page of ${c:0:12} was installed but is not the one served"
      after=$(pidof_daemon "$url") || after=""
      [ "$after" = "$pid" ] || fail "the daemon's pid moved from $pid to ${after:-none} during a page install"
      printf '{"commit":"%s","kind":"page","engine":"%s","page":"%s","pid":%s}\n' "$c" "$(curl -fsS --max-time 5 "$url/api/daemon" | bun -e 'process.stdout.write(String(JSON.parse(await Bun.stdin.text()).build?.revision ?? ""))')" "$page" "$pid" > "$d/receipt.json"
      status verified
      echo "land-install: ${c:0:12}: $why (pid $pid goes on)" ;;
    *)
      echo "land-install: ${c:0:12}: $why: the binary is replaced and the daemon restarted"
      return 1 ;;
  esac
}
here() { local d; d=$(cd "$(dirname "$0")" && pwd); printf '%s/%s\n' "$d" "$(basename "$0")"; }

if [ "${1:-}" != "--install" ]; then
  # ---- the after step, in the checkout at the landed commit ----
  c=${KEEL_LANDED:-}
  [[ $c =~ ^[0-9a-f]{40}$ ]] || fail "KEEL_LANDED is not a commit: this runs as the landing queue's after step"
  [ "$(git rev-parse HEAD)" = "$c" ] || fail "the checkout is not at the landed commit"
  [ -n "${KEEL_LANDED_PUSHED:-}" ] || fail "the landing was not pushed: nothing is installed that the remote does not hold"
  # Only this repository's own remote, by its fixed address: a land block that pushes elsewhere installs nothing.
  [ "$KEEL_LANDED_PUSHED" = origin ] || fail "the landing was pushed to $KEEL_LANDED_PUSHED, not origin"
  [ "$(git remote get-url origin)" = "$ORIGIN_URL" ] || fail "origin is not $ORIGIN_URL"
  base=${KEEL_LANDED_BASE:?}
  remote_at=$(git ls-remote origin "refs/heads/$base" | cut -f1)
  [ "$remote_at" = "$c" ] || fail "origin's $base is ${remote_at:-missing}, not the landed commit"
  [ -n "${KEEL_LAND_DAEMON:-}" ] || fail "the daemon that landed it gave no address"
  # Only over a compiled Keel: a daemon run from source (bun, a dev build) is no binary of a commit to replace.
  running=$(curl -fsS --max-time 5 "$KEEL_LAND_DAEMON/api/daemon" | bun -e 'const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.build?.revision ?? ""))') || running=""
  [[ $running =~ ^[0-9a-f]{40}$ ]] || fail "the daemon at $KEEL_LAND_DAEMON is not a compiled Keel of a commit (its revision: ${running:-none})"
  root=${KEEL_LAND_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/keel-land}
  d=$root/$c
  [ ! -e "$d/status" ] || fail "$d was installed before (its status: $(cat "$d/status"))"
  mkdir -p "$d"
  printf '%s\n' "$c" > "$d/commit"
  printf '%s\n' "$KEEL_LAND_DAEMON" > "$d/daemon"
  # The build checkouts an earlier step left when it was killed (its process gone): removed, and git's record of them.
  for w in "$root"/*/src; do
    [ -d "$w" ] && [ "$w" != "$d/src" ] || continue
    p=$(cat "$(dirname "$w")/build.pid" 2> /dev/null) || p=""
    if [ -z "$p" ] || ! kill -0 "$p" 2> /dev/null; then git worktree remove --force "$w" > /dev/null 2>&1 || rm -rf -- "$w"; fi
  done
  git worktree prune
  printf '%s\n' "$$" > "$d/build.pid"
  # A build that changes what must not wait (src/core/build.ts: the urgent marks) restarts at once. When what the
  # daemon runs cannot be compared (its commit is not here), the restart waits for the owner, as any other.
  rc=0; git diff --quiet "$running" "$c" -- src/core/build.ts 2> /dev/null || rc=$?
  case $rc in 0) ;; 1) : > "$d/now" ;; *) echo "land-install: the daemon's commit ${running:0:12} is not here to compare; the restart waits for the owner" ;; esac
  # Built from the commit alone: a checkout of it of its own, with nothing but the installed packages beside it.
  src="$d/src"
  modules=${KEEL_LAND_REPO:-$PWD}/node_modules
  [ -d "$modules" ] || fail "no installed packages at $modules"
  git worktree add -q --detach "$src" "$c"
  trap 'git worktree remove --force "$src" > /dev/null 2>&1 || true' EXIT
  ln -s "$modules" "$src/node_modules"
  clean() { [ -z "$(git -C "$src" status --porcelain --untracked-files=no)" ] && [ "$(git -C "$src" rev-parse HEAD)" = "$c" ]; }
  clean || fail "the build's checkout is not the landed commit as it is"
  echo "land-install: building ${c:0:12} into $d"
  (cd "$src" && nice -n 10 bun scripts/build.ts "$d/keel") > "$d/build.log" 2>&1 || { tail -n 20 "$d/build.log" >&2; fail "the build failed (its log: $d/build.log)"; }
  clean || fail "the build changed its checkout"
  # The binary names exactly the landed commit (and runs, once, before it replaces anything).
  version=$("$d/keel" --version) || fail "the built binary does not run"
  [[ $version == "keel $c "* ]] || fail "the built binary says \"$version\", not the landed commit"
  sha256sum "$d/keel" | cut -d' ' -f1 > "$d/keel.sha256"
  tar -xOzf "$d/keel-ui.tar.gz" manifest.json | bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).api + "\n")' > "$d/ui-api"
  # The install runs this script as it is now, from its own folder: the checkout may move on meanwhile.
  cp "$(here)" "$d/install.sh"
  cp "$src/scripts/install-kind.ts" "$d/install-kind.ts"
  git rev-parse --path-format=absolute --git-common-dir > "$d/repo"
  # Not the engine: done here, while no other install runs (one that runs decides this one's when it is done).
  exec 9> "$root/install.lock"
  if flock -n 9; then
    if light "$c" "$d" "$KEEL_LAND_DAEMON"; then exit 0; fi
    exec 9>&-
  else
    echo "land-install: another install runs: which install ${c:0:12} needs is decided when its turn comes"
  fi
  if command -v systemd-run > /dev/null && systemctl --user show-environment > /dev/null 2>&1; then
    systemd-run --user --quiet --collect --unit="keel-land-install-${c:0:12}" --description="Install the landed Keel ${c:0:12}" \
      -p RuntimeMaxSec=6000 -E PATH="$PATH" -E HOME="$HOME" ${KEEL_LAND_WAIT_MIN:+-E KEEL_LAND_WAIT_MIN="$KEEL_LAND_WAIT_MIN"} \
      /usr/bin/env bash "$d/install.sh" --install "$c" "$d"
    echo "land-install: install started as keel-land-install-${c:0:12}; its state: $d/status"
  else
    setsid nohup bash "$d/install.sh" --install "$c" "$d" > /dev/null 2>&1 < /dev/null &
    echo "land-install: install started (pid $!); its state: $d/status"
  fi
  exit 0
fi

# ---- the install, apart from the daemon ----
c=$2; d=$3
[[ $c =~ ^[0-9a-f]{40}$ ]] && [ "$(cat "$d/commit")" = "$c" ] || exit 2
exec >> "$d/install.log" 2>&1
url=$(cat "$d/daemon")
daemon() { curl -fsS --max-time 5 "$url/api/daemon"; }
field() { bun -e "const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.draining ? '' : d.pid ?? ''))"; }
# The pid that answers, draining or not.
anypid() { bun -e "const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.pid ?? ''))"; }
bin="" old="" placed=""
# A failure is the daemon's Errors row too; once the binary was replaced, the previous one goes back when the
# daemon did not move to the new one (the old process still answers, or nothing does).
failed() {
  local why
  why=$(tail -n 1 "$d/install.log" 2> /dev/null | cut -c1-400)
  if [ -n "$placed" ] && [ -f "$d/previous-keel" ]; then
    local now; now=$(daemon 2> /dev/null | anypid 2> /dev/null) || now=""
    if [ -z "$now" ] || [ "$now" = "$old" ]; then
      local tmp; tmp=$(mktemp "$(dirname "$bin")/.keel-restore.XXXXXX")
      install -m 755 "$d/previous-keel" "$tmp" && mv -fT "$tmp" "$bin" && echo "$(date -Is) put the previous binary back at $bin" && why="$why (the previous binary was put back)"
    fi
  fi
  status failed
  body=$(WHY="$why" C="$c" D="$d" bun -e 'process.stdout.write(JSON.stringify({ message: `The landed Keel ${process.env.C.slice(0, 12)} was not installed: ${process.env.WHY}`, context: { at: "land-install", commit: process.env.C, log: `${process.env.D}/install.log` } }))' 2> /dev/null) || body=""
  [ -n "$body" ] || return 0
  # The daemon may be coming back (on the binary put back): the row is tried for a minute.
  local until=$(( $(date +%s) + 60 ))
  until curl -fsS --max-time 5 -H 'content-type: application/json' -d "$body" "$url/api/errors" > /dev/null 2>&1; do
    [ "$(date +%s)" -lt "$until" ] || { echo "$(date -Is) the daemon's Errors panel did not answer: this log is the only record"; return 0; }
    sleep 5
  done
}
trap 'rc=$?; if [ "$rc" != 0 ]; then failed; fi' EXIT
echo "$(date -Is) install of $c"
# One install at a time on this machine.
exec 9> "$(dirname "$d")/install.lock"
flock -w 3000 9 || fail "another install held the lock for 50 minutes"
status checking
# What the install needs is decided again now: an install before it may have moved the daemon.
if light "$c" "$d" "$url"; then exit 0; fi
new_hash=$(cat "$d/keel.sha256")
[ "$(sha256sum "$d/keel" | cut -d' ' -f1)" = "$new_hash" ] || fail "the built binary changed since it was built"
old=$(daemon | field) || true
[[ $old =~ ^[0-9]+$ ]] || fail "no daemon that is not draining answers at $url"
rev=$(daemon | bun -e 'const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.build?.revision ?? ""))') || rev=""
[[ $rev =~ ^[0-9a-f]{40}$ ]] || fail "the daemon at $url is not a compiled Keel of a commit (its revision: ${rev:-none})"
bin=$(readlink "/proc/$old/exe") || fail "cannot read what the daemon at $url runs"
# A binary replaced under the running daemon (an install put back, an update) reads " (deleted)": the path is still
# where it runs from, and the cmp below says whether what is there is what it runs.
bin=${bin% (deleted)}
[ -f "$bin" ] && [ ! -L "$bin" ] && [ -w "$bin" ] || fail "the daemon runs $bin, which is not a binary this account may replace"
cmp -s "/proc/$old/exe" "$bin" || fail "$bin is not what the daemon at $url runs"
# What it runs says it is Keel of the commit the daemon names: never another program the pid happens to run.
[[ $("$bin" --version 2> /dev/null) == "keel $rev "* ]] || fail "$bin does not say it is the Keel the daemon at $url names ($rev)"
old_hash=$(sha256sum "$bin" | cut -d' ' -f1)
[ "$old_hash" != "$new_hash" ] || { echo "the daemon already runs this binary"; status verified; exit 0; }
status installing
cp -p "$bin" "$d/previous-keel"
tmp=$(mktemp "$(dirname "$bin")/.keel-install.XXXXXX")
install -m 755 "$d/keel" "$tmp"
cmp -s "$tmp" "$d/keel" || { rm -f "$tmp"; fail "the copy differs from the build"; }
mv -fT "$tmp" "$bin"
placed=1
printf '%s\n' "$old" > "$d/previous-pid"
# The daemon restarts when it decides (it may wait for the owner to step away); the install waits for that. A build
# that changes what must not wait restarts at once.
now=()
[ ! -e "$d/now" ] || now=(--now)
"$bin" restart --no-wait --timeout 120 "${now[@]}" --url "$url"
status waiting
limit=$(( $(date +%s) + 60 * ${KEEL_LAND_WAIT_MIN:-40} ))
new=""
heard=$(date +%s)
# Only a new process that runs the installed binary is the new daemon. A daemon that answers, draining included, is
# heard; once the old process is gone and nothing has answered for a minute, the new binary does not serve, and the
# install stops (the previous binary goes back: failed).
while [ "$(date +%s)" -lt "$limit" ]; do
  if j=$(daemon 2> /dev/null); then
    heard=$(date +%s)
    new=$(printf '%s' "$j" | field 2> /dev/null) || new=""
    if [[ $new =~ ^[0-9]+$ ]] && [ "$new" != "$old" ] && [ "$(sha256sum "/proc/$new/exe" 2> /dev/null | cut -d' ' -f1)" = "$new_hash" ]; then break; fi
  elif ! kill -0 "$old" 2> /dev/null && [ $(( $(date +%s) - heard )) -ge ${KEEL_LAND_SILENT_S:-60} ]; then
    fail "the daemon stopped and nothing answered at $url for a minute: the new binary does not serve"
  fi
  new=""
  sleep 5
done
[ -n "$new" ] || fail "no daemon came back on the new binary within ${KEEL_LAND_WAIT_MIN:-40} minutes"
api=$(cat "$d/ui-api")
curl -fsS --max-time 5 "$url/api/ui" | bun -e "const u = JSON.parse(await Bun.stdin.text()); if (u.api !== '$api') process.exit(1)" || fail "the new daemon does not serve the page that was built with it"
printf '{"commit":"%s","kind":"engine","previous_pid":%s,"pid":%s,"previous_sha256":"%s","sha256":"%s"}\n' "$c" "$old" "$new" "$old_hash" "$new_hash" > "$d/receipt.json"
status verified
echo "$(date -Is) verified: pid $new runs $c"
