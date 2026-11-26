#!/usr/bin/env bash
# The landing queue's after step for this repository (land.after in .keel/checks.json): the landed
# commit is built into a binary and installed over the daemon whose queue landed it, gracefully.
#
#   bash .keel/land-install.sh                  the after step: in the checkout at KEEL_LANDED
#   bash DIR/install.sh --install SHA DIR       the install itself, started by the after step
#
# The after step checks that the landing reached the remote (KEEL_LANDED_PUSHED) and that the
# remote's base is the landed commit, builds it into its own folder (KEEL_LAND_DIR, else
# ~/.cache/keel-land/<commit>), and starts the install apart from the daemon (a user unit of the
# service manager, else a process of its own session): the install stops the daemon, and with it
# everything the daemon started. The install waits its turn (one at a time), puts the binary in
# the place of the one the daemon runs from, and asks the daemon to restart. The daemon decides
# when: it may hold the restart until the owner steps away from his pages, so the install waits
# for the new daemon (40 minutes at most, KEEL_LAND_WAIT_MIN), then checks that it runs the new
# binary and serves its page. Its state is the file <folder>/status: checking, installing,
# waiting, verified, or failed (install.log says why). Nothing runs as root.
set -euo pipefail
umask 077

fail() { echo "land-install: $*" >&2; exit 1; }
here() { local d; d=$(cd "$(dirname "$0")" && pwd); printf '%s/%s\n' "$d" "$(basename "$0")"; }

if [ "${1:-}" != "--install" ]; then
  # ---- the after step, in the checkout at the landed commit ----
  c=${KEEL_LANDED:-}
  [[ $c =~ ^[0-9a-f]{40}$ ]] || fail "KEEL_LANDED is not a commit: this runs as the landing queue's after step"
  [ "$(git rev-parse HEAD)" = "$c" ] || fail "the checkout is not at the landed commit"
  [ -n "${KEEL_LANDED_PUSHED:-}" ] || fail "the landing was not pushed: nothing is installed that the remote does not hold"
  base=${KEEL_LANDED_BASE:?}
  remote_at=$(git ls-remote "$KEEL_LANDED_PUSHED" "refs/heads/$base" | cut -f1)
  [ "$remote_at" = "$c" ] || fail "$KEEL_LANDED_PUSHED's $base is ${remote_at:-missing}, not the landed commit"
  [ -n "${KEEL_LAND_DAEMON:-}" ] || fail "the daemon that landed it gave no address"
  d=${KEEL_LAND_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/keel-land}/$c
  [ ! -e "$d/status" ] || fail "$d was installed before (its status: $(cat "$d/status"))"
  mkdir -p "$d"
  printf '%s\n' "$c" > "$d/commit"
  printf '%s\n' "$KEEL_LAND_DAEMON" > "$d/daemon"
  echo "land-install: building ${c:0:12} into $d"
  nice -n 10 bun scripts/build.ts "$d/keel" > "$d/build.log" 2>&1 || { tail -n 20 "$d/build.log" >&2; fail "the build failed (its log: $d/build.log)"; }
  sha256sum "$d/keel" | cut -d' ' -f1 > "$d/keel.sha256"
  tar -xOzf "$d/keel-ui.tar.gz" manifest.json | bun -e 'process.stdout.write(JSON.parse(await Bun.stdin.text()).api + "\n")' > "$d/ui-api"
  # The install runs this script as it is now, from its own folder: the checkout may move on meanwhile.
  cp "$(here)" "$d/install.sh"
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
status() { printf '%s\n' "$1" > "$d/status.new"; mv -fT "$d/status.new" "$d/status"; }
trap 'rc=$?; if [ "$rc" != 0 ]; then status failed; fi' EXIT
echo "$(date -Is) install of $c"
# One install at a time on this machine.
exec 9> "$(dirname "$d")/install.lock"
flock -w 3000 9 || fail "another install held the lock for 50 minutes"
status checking
url=$(cat "$d/daemon")
new_hash=$(cat "$d/keel.sha256")
[ "$(sha256sum "$d/keel" | cut -d' ' -f1)" = "$new_hash" ] || fail "the built binary changed since it was built"
daemon() { curl -fsS --max-time 5 "$url/api/daemon"; }
field() { bun -e "const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.draining ? '' : d.pid ?? ''))"; }
old=$(daemon | field) || true
[[ $old =~ ^[0-9]+$ ]] || fail "no daemon that is not draining answers at $url"
bin=$(readlink "/proc/$old/exe") || fail "cannot read what the daemon at $url runs"
case "$bin" in *" (deleted)") fail "the daemon's binary was replaced under it: restart it by hand first" ;; esac
[ -f "$bin" ] && [ ! -L "$bin" ] && [ -w "$bin" ] || fail "the daemon runs $bin, which is not a binary this account may replace"
cmp -s "/proc/$old/exe" "$bin" || fail "$bin is not what the daemon at $url runs"
old_hash=$(sha256sum "$bin" | cut -d' ' -f1)
[ "$old_hash" != "$new_hash" ] || { echo "the daemon already runs this binary"; status verified; exit 0; }
status installing
cp -p "$bin" "$d/previous-keel"
tmp=$(mktemp "$(dirname "$bin")/.keel-install.XXXXXX")
install -m 755 "$d/keel" "$tmp"
cmp -s "$tmp" "$d/keel" || { rm -f "$tmp"; fail "the copy differs from the build"; }
mv -fT "$tmp" "$bin"
printf '%s\n' "$old" > "$d/previous-pid"
# The daemon restarts when it decides (it may wait for the owner to step away); the install waits for that.
"$bin" restart --no-wait --timeout 120 --url "$url"
status waiting
limit=$(( $(date +%s) + 60 * ${KEEL_LAND_WAIT_MIN:-40} ))
new=""
while [ "$(date +%s)" -lt "$limit" ]; do
  new=$(daemon 2> /dev/null | field 2> /dev/null) || new=""
  if [[ $new =~ ^[0-9]+$ ]] && [ "$new" != "$old" ]; then break; fi
  new=""
  sleep 5
done
[ -n "$new" ] || fail "the daemon did not come back on the new binary within ${KEEL_LAND_WAIT_MIN:-40} minutes"
[ "$(sha256sum "/proc/$new/exe" | cut -d' ' -f1)" = "$new_hash" ] || fail "the new daemon (pid $new) does not run the installed binary"
api=$(cat "$d/ui-api")
curl -fsS --max-time 5 "$url/api/ui" | bun -e "const u = JSON.parse(await Bun.stdin.text()); if (u.api !== '$api') process.exit(1)" || fail "the new daemon does not serve the page that was built with it"
printf '{"commit":"%s","previous_pid":%s,"pid":%s,"previous_sha256":"%s","sha256":"%s"}\n' "$c" "$old" "$new" "$old_hash" "$new_hash" > "$d/receipt.json"
status verified
echo "$(date -Is) verified: pid $new runs $c"
