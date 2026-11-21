#!/usr/bin/env bash
# Checks a packaged release (bun scripts/release.ts) the way a machine that
# installs it would see it:
#
#   scripts/release-check.sh [DIR]        DIR holds keel-<target>.tar.gz, SHA256SUMS and release.json
#                                         (default: dist/release)
#
# - the archive matches SHA256SUMS, and each file in it matches the list inside;
# - it is unpacked into a throwaway folder outside the source tree and run with
#   a clean environment, a throwaway home and a PATH that holds no Bun;
# - `keel --help` works and `keel --version` names the release's revision;
# - the daemon answers on the loopback, serves its embedded page and every
#   file the page refers to, and says the release's API fingerprint;
# - the release's UI bundle installs over the running daemon and rolls back;
# - no model was called.
# The daemon runs in a network namespace with only a loopback interface where
# the kernel gives one to a user; else on the machine's loopback, which the
# output says. A release for another platform is checked on that platform.
set -euo pipefail
TOP=$(cd "$(dirname "$0")/.." && pwd)
say() { printf '%s\n' "$*"; }
die() { printf 'release-check: %s\n' "$*" >&2; exit 1; }
sum() { if command -v sha256sum > /dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

if [ -z "${KEEL_RELEASE_ROOT:-}" ]; then
  # Stage one: verify, unpack, then run the rest with nothing of the caller.
  dir=$(cd "${1:-$TOP/dist/release}" && pwd) || die "no release folder ${1:-$TOP/dist/release}"
  [ -f "$dir/SHA256SUMS" ] && [ -f "$dir/release.json" ] || die "$dir holds no SHA256SUMS and release.json (bun scripts/release.ts makes them)"
  (cd "$dir" && sum -c SHA256SUMS > /dev/null) || die "the archive does not match $dir/SHA256SUMS"
  archive=$dir/$(awk '{print $2; exit}' "$dir/SHA256SUMS")
  say "ok  archive checksum: $(basename "$archive")"
  root=$(mktemp -d "${TMPDIR:-/tmp}/keel-release.XXXXXX")
  case "$root/" in "$TOP"/*) die "the throwaway folder $root is inside the source tree; set TMPDIR elsewhere" ;; esac
  tar -C "$root" -xzf "$archive"
  inner=$(find "$root" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  (cd "$inner" && sum -c SHA256SUMS > /dev/null) || die "a file in the archive does not match its SHA256SUMS"
  cmp -s "$inner/release.json" "$dir/release.json" || die "release.json in the archive differs from the one beside it"
  say "ok  unpacked outside the source tree, files match: $inner"
  mkdir -p "$root/home" "$root/tmp"
  # A PATH of the system's own tools only: the binary must not need Bun.
  path=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  clean=(env -i PATH="$path" HOME="$root/home" TMPDIR="$root/tmp" LANG="${LANG:-C.UTF-8}" KEEL_RELEASE_ROOT="$root" KEEL_RELEASE_DIR="$inner")
  if "${clean[@]}" bash -c 'command -v bun' > /dev/null 2>&1; then die "Bun is on the system PATH ($path): this check cannot show the binary runs without it"; fi
  rc=0
  if unshare --user --map-root-user --net true 2> /dev/null; then
    say "ok  running in a network namespace with only a loopback interface"
    "${clean[@]}" unshare --user --map-root-user --net -- bash -c \
      'ip link set lo up && exec unshare --user --map-user="$1" --map-group="$2" -- bash "$3"' \
      _ "$(id -u)" "$(id -g)" "$TOP/scripts/release-check.sh" || rc=$?
  else
    say "--  no network namespace on this kernel: running on the machine's loopback"
    "${clean[@]}" bash "$TOP/scripts/release-check.sh" || rc=$?
  fi
  if [ "$rc" = 0 ]; then rm -rf -- "$root"; say "release check passed"; else say "release check FAILED; the folder is kept at $root"; fi
  exit "$rc"
fi

# Stage two, with nothing of the caller: the binary as installed.
root=$KEEL_RELEASE_ROOT
cd "$KEEL_RELEASE_DIR"
field() { grep -o "\"$1\": *\"[^\"]*\"" release.json | head -n 1 | cut -d'"' -f4; }
revision=$(field revision); api=$(field api); target=$(field target)
command -v bun > /dev/null 2>&1 && die "Bun is on PATH"
./keel --help | grep -q "keel serve\|serve " || die "keel --help does not list serve"
say "ok  keel --help, with no Bun on PATH"
version=$(./keel --version)
case "$version" in *"$revision"*"$target"*"$api"*) ;; *) die "keel --version says '$version', the release is $revision $target $api" ;; esac
say "ok  $version"

free() { ! (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }
# Below the range the kernel gives to outgoing connections (32768 and up), where a
# port that was free can be taken before the daemon binds it.
port=0
for _ in 1 2 3 4 5 6 7 8; do port=$((20000 + RANDOM % 12000)); free "$port" && break; done
url=http://127.0.0.1:$port
mkdir -p "$root/ws"
./keel serve --bind "127.0.0.1:$port" --state-dir "$root/state" --workspace "$root/ws" > "$root/daemon.log" 2>&1 &
daemon=$!
trap 'kill "$daemon" 2> /dev/null || true; wait "$daemon" 2> /dev/null || true' EXIT
up=0
for _ in $(seq 1 120); do
  curl -fsS --max-time 2 "$url/api/health" > /dev/null 2>&1 && { up=1; break; }
  kill -0 "$daemon" 2> /dev/null || break
  sleep 0.25
done
[ "$up" = 1 ] || { tail -n 20 "$root/daemon.log" >&2; die "the daemon did not answer on $url"; }
curl -fsS "$url/api/daemon" | grep -q "\"state_dir\":\"$root/state\"" || die "the daemon on $url is not this check's"
say "ok  the daemon answers on the loopback ($url)"

# The page, and every file it refers to.
page() { curl -fsS "$url/"; }
assets() { page | grep -oE '(src|href)="/[^"]+"' | cut -d'"' -f2 | sort -u; }
page | grep -q '<meta name="keel-ui"' || die "the page carries no version"
n=0
for a in $(assets); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url$a")
  [ "$code" = 200 ] || die "the page refers to $a, which answers $code"
  n=$((n + 1))
done
[ "$n" -ge 2 ] || die "the page refers to $n files; a script and a stylesheet are expected"
# Every file of the page (its chunks, fonts and styles are the UI bundle's files) comes from the binary alone.
m=0
for f in $(tar -tzf keel-ui.tar.gz | grep -vE '^(manifest\.json|index\.html)$|/$'); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url/_ui/$f")
  [ "$code" = 200 ] || die "the binary does not serve /_ui/$f of its page ($code)"
  m=$((m + 1))
done
say "ok  the embedded page, the $n files it refers to and all $m files of the page, from the binary alone"
curl -fsS "$url/api/ui" | grep -q "\"api\":\"$api\"" || die "the daemon's API fingerprint is not the release's ($api)"
curl -fsS "$url/api/ui" | grep -q '"source":"embedded"' || die "a fresh daemon does not serve its embedded page"

# The release's own UI bundle over the running daemon, and back.
./keel ui install keel-ui.tar.gz --url "$url" > "$root/install.log" 2>&1 || { cat "$root/install.log" >&2; die "keel ui install refused the release's own bundle"; }
curl -fsS "$url/api/ui" | grep -q '"source":"installed"' || die "the installed bundle is not served"
for a in $(assets); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url$a")
  [ "$code" = 200 ] || die "after the install the page refers to $a, which answers $code"
done
./keel ui rollback --url "$url" > /dev/null
curl -fsS "$url/api/ui" | grep -q '"source":"embedded"' || die "the rollback did not return to the embedded page"
say "ok  the release's UI bundle installs over the running daemon (same API fingerprint $api) and rolls back"

curl -fsS "$url/api/telemetry?since_ms=0" | grep -q '"calls":0' || die "a model was called"
say "ok  no model call"
