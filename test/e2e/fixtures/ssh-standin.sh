#!/usr/bin/env bash
# A stand-in for ssh in a scratch daemon (KEEL_SSH): one host, named by
# KEEL_SSH_STANDIN_HOST, is this machine with the scratch home
# KEEL_SSH_STANDIN_HOME and a clean environment, the way a login over ssh gets
# one. Its commands run here, its master connection is a process that holds a
# file, and a forwarded socket is a link to the socket itself. Every other
# host goes to the real ssh unchanged.
HOST="${KEEL_SSH_STANDIN_HOST:-keel-standin}"
BOX="${KEEL_SSH_STANDIN_HOME:-}"
mine=0
for a in "$@"; do [ "$a" = "$HOST" ] && mine=1; done
if [ "$mine" = 0 ] || [ -z "$BOX" ]; then exec ssh "$@"; fi

ctl=""; op=""; fwd=""; master=0; config=0; cmd=""
while [ $# -gt 0 ]; do
  case "$1" in
    -S) ctl="$2"; shift 2 ;;
    -O) op="$2"; shift 2 ;;
    -L) fwd="$2"; shift 2 ;;
    -o) shift 2 ;;
    -M) master=1; shift ;;
    -G) config=1; shift ;;
    "$HOST") shift; cmd="$*"; break ;;
    *) shift ;;
  esac
done

if [ "$config" = 1 ]; then
  printf 'user standin\nhostname %s\nport 22\n' "$HOST"
  exit 0
fi
case "$op" in
  forward) ln -sfn "${fwd#*:}" "${fwd%%:*}"; exit 0 ;;
  cancel) rm -f "${fwd%%:*}"; exit 0 ;;
esac
if [ "$master" = 1 ]; then
  # The connection: there until it is closed, or the daemon that opened it is gone.
  : > "$ctl"
  trap 'kill "$held" 2>/dev/null; rm -f "$ctl"; exit 0' TERM INT HUP
  if tail --pid="$$" -f /dev/null --version >/dev/null 2>&1; then
    tail -f /dev/null --pid="$PPID" &
  else
    # No GNU tail (macOS): look every two seconds whether the daemon is still there.
    (while kill -0 "$PPID" 2>/dev/null; do sleep 2; done) &
  fi
  held=$!
  wait "$held"
  rm -f "$ctl"
  exit 0
fi
mkdir -p "$BOX/tmp"
exec env -i HOME="$BOX" USER="${USER:-standin}" LOGNAME="${USER:-standin}" SHELL=/bin/sh TMPDIR="$BOX/tmp" \
  PATH="${KEEL_SSH_STANDIN_PATH:-/usr/local/bin:/usr/bin:/bin}" LANG=C.UTF-8 /bin/sh -c "$cmd"
