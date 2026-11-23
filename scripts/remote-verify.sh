#!/usr/bin/env bash
# Checks a commit on another machine, so a slow or busy machine is not what a change waits for.
#
#   scripts/remote-verify.sh --host build-box            the commit at HEAD
#   scripts/remote-verify.sh --host build-box COMMIT     another commit of this repository
#   scripts/remote-verify.sh --e2e SPEC... [COMMIT]      also the named browser specs (--e2e alone: the smoke case)
#   scripts/remote-verify.sh --only unit,cli             some stages only (install always runs)
#   scripts/remote-verify.sh --out DIR                   where the logs are copied to (a new folder under $TMPDIR by default)
#   scripts/remote-verify.sh --dir PATH                  the folder on the host, from its home (.cache/keel-verify by default)
#   scripts/remote-verify.sh --wait SECONDS              how long to wait for a free place on the host (1800 by default)
#
# --host names anything `ssh` reaches; KEEL_VERIFY_HOST gives it when the flag is not there.
# Nothing else of this machine is used, and nothing of it is copied there but the commit:
# no credentials, no config, no state.
#
# The commit is pushed to a bare repository on the host and checked out in a folder of its
# own there, kept for a day and used again by a later run of the same commit. Its packages
# are installed from the lockfile into that folder. The stages then run one after another,
# at a low priority, each with a clean environment (a home, a temporary folder and a config
# folder of the run's own; no credential helper, no memory store, no keyring):
#
#   install     bun install --frozen-lockfile
#   typecheck   tsc --noEmit -p .
#   unit        bun test                 (src)
#   ui          bun test ./ui/src/lib
#   scripts     bun test ./scripts
#   cli         bun test ./test/cli      (builds the binary)
#   e2e         scripts/smoke.sh SPEC... (only with --e2e; a daemon of its own on the scripted provider)
#
# Every stage runs, also after one failed. One line is printed as each ends and a table at
# the end; the logs stay on the host under runs/<run> and are copied back. Exit code: 0 when
# every stage passed, 1 when one failed, 2 for a refusal (a tree with changes that are not
# committed, no host, a tool missing there), 3 when the host is too busy to start (a load
# over 20, or no free place within the wait: at most four runs are on a host at once; KEEL_VERIFY_MAX_LOAD and
# KEEL_VERIFY_MAX_RUNS change both).
set -euo pipefail

MAX_LOAD=${KEEL_VERIFY_MAX_LOAD:-20}   # the host's one-minute load above which a run does not start
MAX_RUNS=${KEEL_VERIFY_MAX_RUNS:-4}    # runs on a host at once (four by default: a run takes about two of its threads a stage)
KEEP_DAYS=1     # how long a commit's folder and a run's logs stay on the host

if [ "${1:-}" != "__remote" ]; then
  # ---- here: what to check, the push, the copy of this script, the logs back ----
  TOP=$(cd "$(dirname "$0")/.." && pwd)
  host=${KEEL_VERIFY_HOST:-}; dir=.cache/keel-verify; out=""; only=""; wait_s=1800; e2e=0; specs=(); commit=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host) host=${2:?--host takes a name ssh reaches}; shift ;;
      --dir) dir=${2:?--dir takes a path from the home on the host}; shift ;;
      --out) out=${2:?--out takes a folder}; shift ;;
      --only) only=${2:?--only takes stages, separated by commas}; shift ;;
      --wait) wait_s=${2:?--wait takes seconds}; shift ;;
      --e2e) e2e=1 ;;
      -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      -*) echo "remote-verify: unknown option $1 (see --help)" >&2; exit 2 ;;
      *)
        # After --e2e, what names a spec is a spec; anything else is the commit.
        if [ "$e2e" = 1 ] && { [[ "$1" == *.spec.ts* ]] || [[ "$1" == test/e2e* ]]; }; then
          [[ "$1" =~ ^[A-Za-z0-9_./:-]+$ ]] || { echo "remote-verify: a spec is named by its path (and a line): $1" >&2; exit 2; }
          specs+=("$1")
        elif [ -z "$commit" ]; then commit=$1
        else echo "remote-verify: one commit at a time ($commit, then $1)" >&2; exit 2; fi ;;
    esac
    shift
  done
  [ -n "$host" ] || { echo "remote-verify: no host. Name one with --host (anything ssh reaches) or KEEL_VERIFY_HOST." >&2; exit 2; }
  case "$dir" in /*|*..*|"") echo "remote-verify: --dir is a path from the home on the host, without ..: $dir" >&2; exit 2 ;; esac
  [[ "$wait_s" =~ ^[0-9]+$ ]] || { echo "remote-verify: --wait takes whole seconds" >&2; exit 2; }
  [[ "$only" =~ ^[a-z0-9,]*$ ]] || { echo "remote-verify: --only takes stage names separated by commas" >&2; exit 2; }
  cd "$TOP"
  if [ -z "$commit" ]; then
    # What is checked is a commit: changes that are not in one would not be.
    if [ -n "$(git status --porcelain)" ]; then
      echo "remote-verify: this tree has changes that are not committed; they would not be checked. Commit them, or name a commit." >&2
      git status --short | head -n 10 >&2
      exit 2
    fi
    commit=HEAD
  fi
  sha=$(git rev-parse --verify --quiet "$commit^{commit}") || { echo "remote-verify: $commit is not a commit of this repository" >&2; exit 2; }
  ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "$@"; }
  run=$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}-$$
  # The host's folder and its bare repository; this script goes with the run, so a commit from before it can be checked too.
  ssh_ "mkdir -p '$dir/runs/$run' && { [ -d '$dir/repo.git' ] || git init -q --bare '$dir/repo.git'; } && cat > '$dir/runs/$run/remote-verify.sh'" < "$0" \
    || { echo "remote-verify: could not reach $host or write under ~/$dir there" >&2; exit 2; }
  echo "remote-verify: ${sha:0:12} to $host"
  GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" git push -q "$host:$dir/repo.git" "+$sha:refs/heads/verify-${sha:0:12}" || { echo "remote-verify: the push to $host failed" >&2; exit 2; }
  rc=0
  # A terminal on the far side: when this side goes away (Ctrl-C, a stopped caller, a closed
  # session), the far side is hung up and ends its run. This side waits for it as a job, so a
  # signal to this script is acted on at once and takes the connection with it.
  ssh -q -tt -o BatchMode=yes -o ConnectTimeout=15 "$host" \
    "KEEL_VERIFY_MAX_RUNS=$MAX_RUNS KEEL_VERIFY_MAX_LOAD=$MAX_LOAD bash '$dir/runs/$run/remote-verify.sh' __remote '$dir' '$run' '$sha' '$wait_s' '$only' '$e2e' ${specs[*]:-}" < /dev/null &
  far=$!
  trap 'kill "$far" 2> /dev/null || true; wait "$far" 2> /dev/null || true; echo "remote-verify: stopped; the run on $host is ended" >&2; exit 130' INT TERM HUP
  wait "$far" || rc=$?
  trap - INT TERM HUP
  [ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/keel-verify-${sha:0:12}.XXXXXX")
  mkdir -p "$out"
  if ssh_ "tar -C '$dir/runs/$run' -cf - logs 2> /dev/null" | tar -C "$out" -xf - 2> /dev/null; then echo "remote-verify: logs in $out/logs (on $host: ~/$dir/runs/$run/logs)"
  else echo "remote-verify: no logs came back (on $host: ~/$dir/runs/$run)" >&2; fi
  exit "$rc"
fi

# ---- on the host ----
shift
dir=$1; run=$2; sha=$3; wait_s=$4; only=$5; e2e=$6; shift 6
base=$HOME/$dir; here=$base/runs/$run; wt=$base/wt/$sha
# The terminal may be gone (the caller was cut off): saying something then fails, and must not end the clean-up.
say() { printf 'remote-verify: %s\n' "$*" 2> /dev/null || true; }
# Lines end as on a file, not as on a terminal.
[ -t 1 ] && stty -onlcr 2> /dev/null || true
# Each command this script starts is a job with a process group of its own, waited for: a
# signal to the script is acted on at once (a shell does not run a trap while a command it
# runs in the foreground goes on), and the job's whole group can be ended.
set -m
job=""
# run COMMAND...: as a job, waited for; its exit code.
run() {
  local rc=0
  "$@" &
  job=$!
  wait "$job" || rc=$?
  job=""
  return "$rc"
}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$run" =~ ^[0-9A-Za-z-]+$ ]] || { say "not a run this script started"; exit 2; }
BUN=$(command -v bun || true); [ -n "$BUN" ] || BUN=$HOME/.bun/bin/bun
for tool in git flock nice tar "$BUN"; do command -v "$tool" > /dev/null || { say "$tool is not on this host"; exit 2; }; done
mkdir -p "$base/wt" "$base/locks" "$here/logs" "$here/home/run" "$here/tmp" "$here/config" "$base/bun-cache"
chmod 700 "$here/home/run"

# What a run started that is still there when it ends, however it ends: its group, and whatever names its folders.
sweep() {
  trap '' HUP INT TERM
  [ -z "$job" ] || kill -TERM -- "-$job" 2> /dev/null || true
  for pid in $(pgrep -f -- "$here/" || true) $(pgrep -f -- "$wt/" || true); do [ "$pid" = "$$" ] || kill -TERM "$pid" 2> /dev/null || true; done
  sleep 1
  for pid in $(pgrep -f -- "$here/" || true); do [ "$pid" = "$$" ] || kill -KILL "$pid" 2> /dev/null || true; done
}
trap 'say "cut off: ending the run"; sweep; exit 130' HUP INT TERM

# At most MAX_RUNS at once on the host: a place is a lock held for the run's life.
got=0; waited=0
while [ "$got" = 0 ]; do
  for n in $(seq 1 "$MAX_RUNS"); do
    exec 8> "$base/locks/place-$n"
    if flock -n 8; then got=$n; break; fi
  done
  [ "$got" != 0 ] && break
  [ "$waited" -lt "$wait_s" ] || { say "no free place on this host after ${waited} s ($MAX_RUNS runs at once): not started"; exit 3; }
  [ "$waited" = 0 ] && say "waiting for a free place ($MAX_RUNS runs at once)"
  run sleep 10; waited=$((waited + 10))
done
load=$(cut -d' ' -f1 /proc/loadavg)
if awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN { exit !(l > m) }'; then say "this host's load is $load (over $MAX_LOAD): not started"; exit 3; fi

# Folders of commits and runs older than KEEP_DAYS go, unless a run holds them.
old() { find "$1" -mindepth 1 -maxdepth 1 -type d -mtime +$((KEEP_DAYS - 1)) 2> /dev/null; }
for d in $(old "$base/wt"); do
  name=$(basename "$d"); [[ "$name" =~ ^[0-9a-f]{40}$ ]] || continue
  ( exec 7> "$base/locks/wt-$name"; flock -n 7 || exit 0
    git --git-dir="$base/repo.git" worktree remove --force "$d" 2> /dev/null || rm -rf -- "$d"
    git --git-dir="$base/repo.git" update-ref -d "refs/heads/verify-${name:0:12}" 2> /dev/null || true
    rm -f -- "$base/locks/wt-$name" )
done
git --git-dir="$base/repo.git" worktree prune 2> /dev/null || true
for d in $(old "$base/runs"); do [ "$d" = "$here" ] || rm -rf -- "$d"; done

# The commit's folder: one run in it at a time.
exec 7> "$base/locks/wt-$sha"
waited=0
until flock -n 7; do
  [ "$waited" -lt "$wait_s" ] || { say "another run of ${sha:0:12} did not end within $wait_s s: not started"; exit 3; }
  [ "$waited" = 0 ] && say "waiting for another run of ${sha:0:12} to end (one run in a commit's folder at a time)"
  run sleep 10; waited=$((waited + 10))
done
if [ -d "$wt" ]; then
  [ "$(git -C "$wt" rev-parse HEAD 2> /dev/null)" = "$sha" ] || { say "$wt is not at $sha: remove it and run again"; exit 2; }
  # As the commit has it: what an earlier run left in tracked files is put back.
  git -C "$wt" checkout -q -- . && touch "$wt"
else
  git --git-dir="$base/repo.git" worktree add -q --detach "$wt" "$sha" || { say "could not check out $sha"; exit 2; }
fi
[ ! -L "$wt/node_modules" ] || { say "$wt/node_modules is a link: packages are installed into a folder of the commit's own"; exit 2; }
cd "$wt"

# The environment of every stage: nothing of the account on this host but Bun and the system's tools.
clean=(env -i
  HOME="$here/home" PATH="$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin" TMPDIR="$here/tmp" LANG=C.UTF-8 TERM=dumb
  KEEL_CONFIG_DIR="$here/config" KEEL_CRED_GET=/bin/false TACIT_BIN=/bin/false
  # No keyring, whatever this host has: it is reached through the session bus, by the account and not by the home.
  KEEL_KEYRING_SERVICE=keel-scratch-empty DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus XDG_RUNTIME_DIR="$here/home/run"
  KEEL_DESKTOP_NOTIFY=off
  # Stores of the host's folder, shared by its runs: Bun's package cache and the browsers.
  BUN_INSTALL_CACHE_DIR="$base/bun-cache" PLAYWRIGHT_BROWSERS_PATH="$base/ms-playwright")

names=(); codes=(); passes=(); fails=(); secs=(); failed=0
wanted() { [ -z "$only" ] || [[ ",$only," == *",$1,"* ]]; }
# stage NAME COMMAND...: runs it, keeps its log, says how it went.
stage() {
  local name=$1; shift
  local log=$here/logs/$name.log t0=$SECONDS rc=0 pass=- fail=-
  say "$name: started"
  run nice -n 10 "${clean[@]}" "$@" > "$log" 2>&1 < /dev/null || rc=$?
  # Bun's summary (" 12 pass", " 0 fail") or Playwright's ("12 passed", "1 failed"), when the stage has one.
  if grep -qE '^ *[0-9]+ pass$' "$log"; then
    pass=$(grep -E '^ *[0-9]+ pass$' "$log" | tail -n 1 | tr -dc 0-9); fail=$(grep -E '^ *[0-9]+ fail$' "$log" | tail -n 1 | tr -dc 0-9 || true)
  elif grep -qE '^ +[0-9]+ passed' "$log"; then
    # A run with no failure has no line of them.
    pass=$(grep -E '^ +[0-9]+ passed' "$log" | tail -n 1 | grep -oE '[0-9]+' | head -n 1); fail=$(grep -E '^ +[0-9]+ failed' "$log" | tail -n 1 | grep -oE '[0-9]+' | head -n 1 || true)
  fi
  [ -n "$fail" ] || fail=0
  names+=("$name"); codes+=("$rc"); passes+=("$pass"); fails+=("$fail"); secs+=("$((SECONDS - t0))")
  local n=""; [ "$pass" = - ] || n=" ($pass pass)"
  if [ "$rc" = 0 ]; then say "$name: ok in $((SECONDS - t0)) s$n"
  else
    failed=1; say "$name: FAILED (exit $rc) in $((SECONDS - t0)) s; the end of its log:"
    { grep -E '^\(fail\)|^ +✘|error TS' "$log" | head -n 20; tail -n 4 "$log"; } | cut -c1-220 | sed 's/^/    /'
  fi
  return 0
}

say "run $run (place $got of $MAX_RUNS, load $load, Bun $("$BUN" --version))"
stage install "$BUN" install --frozen-lockfile
if [ "${codes[0]}" != 0 ]; then say "the packages could not be installed: nothing else was run"
else
  # The compiler's own entry, run by Bun: its command in node_modules/.bin asks for Node, which a host may not have.
  wanted typecheck && stage typecheck "$BUN" node_modules/typescript/bin/tsc --noEmit -p .
  wanted unit && stage unit "$BUN" test --timeout 20000
  wanted ui && stage ui "$BUN" test --timeout 20000 ./ui/src/lib
  wanted scripts && stage scripts "$BUN" test --timeout 20000 ./scripts
  wanted cli && stage cli "$BUN" test ./test/cli
  if [ "$e2e" = 1 ] && wanted e2e; then
    if [ ! -f scripts/smoke.sh ]; then say "e2e: this commit has no scripts/smoke.sh: not run"; names+=(e2e); codes+=(2); passes+=(-); fails+=(-); secs+=(0); failed=1
    else
      # The browser is fetched once into the host's folder. Without namespaces for a user the run
      # still has no credentials (the clean environment); its traffic is then not blocked.
      stage browser "$BUN" x playwright install chromium
      net=(); unshare --user --map-root-user --net --pid --fork true 2> /dev/null || { net=(--allow-network); say "e2e: no namespaces for a user on this host: running with --allow-network"; }
      stage e2e bash scripts/smoke.sh "${net[@]}" "$@"
      # A failed run keeps its folder: the daemon's log and each failed test's page go back with the logs.
      kept=$(sed -n 's/^smoke: the run.s folder is kept at \([^ ]*\).*/\1/p' "$here/logs/e2e.log" | tail -n 1)
      if [ -n "$kept" ] && [ -d "$kept" ]; then
        mkdir -p "$here/logs/e2e"
        cp "$kept/daemon.log" "$here/logs/e2e/daemon.log" 2> /dev/null || true
        find "$kept/home/.cache/keel-work/bun/e2e-out" -name error-context.md 2> /dev/null | while read -r f; do cp "$f" "$here/logs/e2e/$(basename "$(dirname "$f")").md"; done
      fi
    fi
  fi
fi

printf '\n%-10s %5s %6s %6s %8s\n' stage exit pass fail seconds
for i in "${!names[@]}"; do printf '%-10s %5s %6s %6s %8s\n' "${names[$i]}" "${codes[$i]}" "${passes[$i]}" "${fails[$i]}" "${secs[$i]}"; done
printf '\n'
sweep
# A run that failed keeps its home and temporary folder with its logs, until the folder's day is over.
if [ "$failed" = 0 ]; then rm -rf -- "$here/home" "$here/tmp" "$here/config"; else say "what the run left is kept on the host for a day: ~/$dir/runs/$run"; fi
exit "$failed"
