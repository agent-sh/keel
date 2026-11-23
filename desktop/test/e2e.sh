#!/usr/bin/env bash
# The end-to-end check of the desktop shell, in a hidden desktop: never the
# owner's screen, never their daemon. It starts a scratch daemon with the
# scripted stand-in model only, a hidden workspace (agent-workspace-linux), a
# stand-in tray host and a stand-in notification service on that workspace's
# session bus, and the shell inside it. It proves the window, the survival of
# a daemon restart, the tray count, a notification's click, a second launch,
# a keel:// link, the text size keys, the remembered size, and the start button.
# It also runs the reproductions of the first build's review: HTML shown in a
# sandboxed frame that tries to drive the app and read the clipboard, a page
# that tries to leave the daemon's origin, a stranger on the daemon's port
# (who must never be sent the token), an app that is stopped or has no
# notification service when an alert comes, a link to a session with a
# request waiting followed by Return, and quitting with a turn at work; and of
# its second review: a frame the owner clicked in racing the owner's paste for
# the clipboard, the main frame at an artifact's own address, a lock whose pid
# was given to another process, and an address that is not this machine's.
#
#   desktop/test/e2e.sh                         an X11 workspace
#   KEEL_E2E_BACKEND=kwin desktop/test/e2e.sh   a native Wayland workspace (KWin): also the clipboard's
#                                               picture and the focus a launch's activation token gives
#
# The workspace is one of those two. The check starts no desktop shell of a
# whole session (GNOME Shell and the like): such a shell, started a second
# time under one account, can reach that account's own session services.
#
# Needs: agent-workspace-linux, gjs, gdbus, curl, python3, bun, and the builds
# (dist/keel from `bun scripts/build.ts`, desktop/dist/keel-desktop from
# `desktop/build.sh`). Screenshots and logs stay in the folder it prints.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ID=io.github.agent_sh.Keel
# The check's app is an instance of its own name: its launches reach no other keel-desktop on
# the machine (the owner's installed app included), and no other reaches it.
export KEEL_DESKTOP_INSTANCE="Check$$"
BUS="$ID.$KEEL_DESKTOP_INSTANCE"
BACKEND=${KEEL_E2E_BACKEND:-x11}
case "$BACKEND" in x11|kwin) ;; *) echo "KEEL_E2E_BACKEND is x11 or kwin (see the top of this file)"; exit 2 ;; esac
SHELL_BIN=${KEEL_DESKTOP_BIN:-$REPO/desktop/dist/keel-desktop}
KEEL=${KEEL_BIN:-$REPO/dist/keel}
D=${KEEL_E2E_DIR:-$(mktemp -d -t keel-desktop-e2e.XXXXXX)}
WS=keel-desktop-e2e-$$
HOST_RUNTIME=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
A="env XDG_RUNTIME_DIR=$HOST_RUNTIME agent-workspace-linux workspace"
mkdir -p "$D/shots" "$D/home/run" "$D/shell"
chmod 700 "$D/home/run"
[ -x "$SHELL_BIN" ] || { echo "missing $SHELL_BIN: run desktop/build.sh"; exit 2; }
[ -x "$KEEL" ] || { echo "missing $KEEL: run bun scripts/build.ts"; exit 2; }
for t in agent-workspace-linux gjs gdbus curl python3 bun; do command -v "$t" > /dev/null || { echo "missing $t"; exit 2; }; done

fails=0; n=0
ok() { n=$((n + 1)); echo "ok $n - $1"; }
fail() { n=$((n + 1)); fails=$((fails + 1)); echo "FAIL $n - $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
# until CMD is true, at most SECONDS
wait_for() { local s=$1; shift; for _ in $(seq 1 $((s * 4))); do if eval "$*" > /dev/null 2>&1; then return 0; fi; sleep 0.25; done; return 1; }
py() { python3 -c "$@"; }
# the running app (the window list is asked by process: the window class differs between Wayland and X11)
# Only this check's own app counts: another keel-desktop on the machine is not its business.
app_pids() { for p in $(pgrep -x keel-desktop); do tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -qx "KEEL_DESKTOP_DIR=$D/shell" && echo "$p"; done; }
app_pid() { local p; p=$(app_pids | tail -1); echo "${p:-0}"; }
# the process that owns the app's windows: the app, or the program that draws them for it (the Qt engine)
win_pid() { local a q; a=$(app_pid); q=$(pgrep -x keel-desktop-qt -P "$a" 2> /dev/null | tail -1); echo "${q:-$a}"; }
# A signal goes only to a process this check started: a pid above 1 whose command line names the
# check's folder, its scripts or its daemon's address, or whose environment names its app's
# folder. A pid that was not found (0), or one another program has by now, gets none.
mine() {
  local p=${1:-0} up=0
  [ "$p" -gt 1 ] 2> /dev/null || return 1
  # (Itself, or a process it descends from: an engine's sandboxed child shows nothing of itself.)
  while [ "${p:-0}" -gt 1 ] && [ "$up" -lt 6 ]; do
    tr '\0' ' ' < "/proc/$p/cmdline" 2> /dev/null | grep -qF -e "$HERE/" -e "$D" -e "${URL:-no-address-yet}" && return 0
    tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -q "^KEEL_DESKTOP_DIR=$D" && return 0
    p=$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2> /dev/null); up=$((up + 1))
  done
  return 1
}
sig() { mine "$2" && kill "$1" "$2" 2> /dev/null; }
logged() { grep -c "\"what\":\"$1\"" "$D/shell.jsonl" 2> /dev/null || true; }
last() { grep "\"what\":\"$1\"" "$D/shell.jsonl" 2> /dev/null | tail -1; }
# a picture of the app's largest window alone (of the whole desktop with `all`)
shot() {
  local id; id=$($A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys
ws=json.load(sys.stdin).get("windows", [])
print(max(ws, key=lambda w: w["geometry"]["width"]*w["geometry"]["height"])["id"] if ws else "")')
  if [ "${2:-}" = all ] || [ -z "$id" ]; then $A screenshot --id "$WS" --output "$D/shots/$1.png" > /dev/null 2>&1
  else $A screenshot-window --id "$WS" --window "$id" --output "$D/shots/$1.png" > /dev/null 2>&1; fi
}
# the main window: "x y width height title"
geometry() { $A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys
ws=json.load(sys.stdin).get("windows", [])
w=max(ws, key=lambda w: w["geometry"]["width"]*w["geometry"]["height"]) if ws else None
print(*( [w["geometry"][k] for k in ("x","y","width","height")] + [w.get("title","")] ) if w else "")'; }
windows() { $A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys; print(len(json.load(sys.stdin).get("windows", [])))'; }
api() { curl -fsS -m 10 -X "${3:-GET}" -H 'content-type: application/json' ${2:+-d "$2"} "$URL$1"; }
tray() { gdbus call --session --dest "$BUS" --object-path /StatusNotifierItem --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem "$1" 2> /dev/null; }
menu() { gdbus call --session --dest "$BUS" --object-path /StatusNotifierItem/Menu --method com.canonical.dbusmenu.GetLayout 0 1 "@as []" 2> /dev/null; }
pick() { gdbus call --session --dest "$BUS" --object-path /StatusNotifierItem/Menu --method com.canonical.dbusmenu.Event "$1" clicked "<0>" 0 > /dev/null 2>&1; }

# --- the scratch daemon: a clean environment, a home of its own, the scripted model only
# (Asked of ss by port, not found by a search of its whole list: a search that stops at its first
# match ends the listing early, and under pipefail that reads as "not found".)
listening() { [ -n "$(ss -ltnH "sport = :$1" 2> /dev/null)" ]; }
# (A port of its own, and the program that starts the daemon on it. Another program may take the
# port between the look and the daemon's own bind: the check then takes another, once.)
scratch() {
  for _ in 1 2 3 4 5 6; do PORT=$((48200 + RANDOM % 1700)); listening "$PORT" || break; done
  URL=http://127.0.0.1:$PORT
  cat > "$D/keel" <<EOF
#!/usr/bin/env bash
# Stands in for the keel program the shell starts: the scratch daemon of this check.
cd "$REPO" && exec env -i PATH="$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin" HOME="$D/home" ${TMPDIR:+TMPDIR="$TMPDIR"} LANG=C.UTF-8 \\
  KEEL_KEYRING_SERVICE=keel-scratch-empty KEEL_DESKTOP_NOTIFY=off DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus XDG_RUNTIME_DIR="$D/home/run" KEEL_CRED_GET=/bin/false \\
  KEEL_DEV_DIR="$D/dev" KEEL_SCRIPTED_PROVIDER=1 KEEL_DEFAULT_MODEL=scripted:stand-in-strict KEEL_SERVER_NAME=desktop-e2e KEEL_BIN="$KEEL" bash scripts/dev.sh $PORT
EOF
  chmod +x "$D/keel"
}
scratch
daemon_up() { (setsid nohup "$D/keel" >> "$D/daemon.log" 2>&1 < /dev/null &); wait_for 60 "curl -fsS -m 2 $URL/api/daemon | grep -q '$D/dev'"; }
daemon_down() {
  for p in $(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do tr '\0' ' ' < "/proc/$p/cmdline" | grep -q "$D/dev" && kill "$p"; done
  wait_for 20 "! curl -fsS -m 1 $URL/api/health"
}
cleanup() {
  [ -n "${WS_UP:-}" ] && (eval "$ENVSH"; KEEL_DESKTOP_DIR="$D/shell" "$SHELL_BIN" --quit > /dev/null 2>&1)
  for p in $(pgrep -x keel-desktop); do tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -qx "KEEL_DESKTOP_DIR=$D/owners-app" && kill "$p"; done
  daemon_down > /dev/null 2>&1
  for f in "$D"/host-*.pid; do [ -s "$f" ] && sig -TERM "$(cat "$f")"; done
  [ -n "${WS_UP:-}" ] && $A stop --id "$WS" > /dev/null 2>&1
  echo "evidence: $D"
}
trap cleanup EXIT
daemon_up || { grep -q "could not be bound" "$D/daemon.log" && scratch && daemon_up; } || { echo "the scratch daemon did not come up; see $D/daemon.log"; exit 2; }
sleep 8
real=$(api /api/providers | py 'import json,sys; d=json.load(sys.stdin); d=d.get("providers", d); print(" ".join(x["id"] for x in d if x.get("available") and x["id"] not in ("scripted","acp","alibaba")))')
[ -z "$real" ] || { echo "the scratch daemon has real providers ($real): stopping"; exit 2; }

# --- the hidden desktop, with a tray host and a notification service of the check's own
$A start --ack-hidden-workspace --id "$WS" --session "$BACKEND" --width 2560 --height 1440 --purpose "keel-desktop end-to-end check" > "$D/workspace.json" 2>&1 || { echo "the hidden workspace did not start; see $D/workspace.json"; exit 2; }
WS_UP=1
ENVSH=$($A env --id "$WS" --shell 2> /dev/null)
[ -n "$ENVSH" ] || { echo "no environment for the workspace"; exit 2; }
# Everything below that touches the desktop runs with the workspace's environment: its own
# session bus and its own display. Without both, the app would open on the owner's desktop.
HOST_BUS=${DBUS_SESSION_BUS_ADDRESS:-}; HOST_WAYLAND=${WAYLAND_DISPLAY:-}; HOST_X=${DISPLAY:-}
eval "$ENVSH"
case "${DBUS_SESSION_BUS_ADDRESS:-}" in *agent-workspace-linux/"$WS"/*) ;; *) echo "the workspace gave no session bus of its own: stopping"; exit 2 ;; esac
[ "${DBUS_SESSION_BUS_ADDRESS:-}" != "$HOST_BUS" ] || { echo "the workspace's session bus is the host's: stopping"; exit 2; }
if [ "$BACKEND" = x11 ]; then [ -n "${DISPLAY:-}" ] && [ "${DISPLAY:-}" != "$HOST_X" ] || { echo "the workspace gave no display of its own: stopping"; exit 2; }
else [ -n "${WAYLAND_DISPLAY:-}" ] && { [ "${WAYLAND_DISPLAY:-}" != "$HOST_WAYLAND" ] || [ "${XDG_RUNTIME_DIR:-}" != "$HOST_RUNTIME" ]; } || { echo "the workspace gave no display of its own: stopping"; exit 2; }; fi
[ "$BACKEND" = x11 ] && export GDK_BACKEND=x11
( gjs -m "$HERE/tray-host.js" > "$D/tray-host.out" 2>&1 & echo $! > "$D/host-tray.pid" )
( gjs -m "$HERE/notify-host.js" > "$D/notify-host.out" 2>&1 & echo $! > "$D/host-notify.pid" )
# (And one for the desktop's word on a screen reader, where the workspace's bus has none of its own.)
if ! gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Get org.a11y.Status ScreenReaderEnabled > /dev/null 2>&1; then
  ( gjs -m "$HERE/a11y-host.js" > "$D/a11y-host.out" 2>&1 & echo $! > "$D/host-a11y.pid" )
  wait_for 10 "grep -q READY '$D/a11y-host.out'" || { echo "the stand-in accessibility bus did not start"; exit 2; }
fi
wait_for 10 "grep -q READY '$D/tray-host.out' && grep -q READY '$D/notify-host.out'" || { echo "the stand-in hosts did not start"; exit 2; }

export KEEL_DESKTOP_DIR="$D/shell" KEEL_URL="$URL" KEEL_STATE_DIR="$D/dev/state" KEEL_BIN="$D/keel" KEEL_DESKTOP_LOG="$D/shell.jsonl" KEEL_DESKTOP_NO_BROWSER=1
# The check's own script in the page (it shows the artifact's frame and tries to leave the origin), and a port nobody of Keel's is on.
for _ in 1 2 3 4 5 6; do FOREIGN=$((46200 + RANDOM % 1700)); listening "$FOREIGN" || break; done
sed "s/FOREIGN_PORT/$FOREIGN/" "$HERE/probe.js" > "$D/probe.js"
export KEEL_DESKTOP_PROBE="$D/probe.js"
echo '{"width":1920,"height":1040,"maximized":false}' > "$D/shell/shell.json"
# (A home of the app's own: what it saves goes to this check's folder, never the owner's.)
mkdir -p "$D/apphome"
launch() { (HOME="$D/apphome" setsid nohup "$SHELL_BIN" "$@" >> "$D/shell.out" 2>&1 < /dev/null &); }
said() { grep -a "^PROBE $1" "$D/shell.out" 2> /dev/null | tail -1; }
delivery() { api "/api/alerts?limit=20" | py 'import json,sys
d=json.load(sys.stdin); d=d.get("alerts", d)
print(next((a.get("delivery", {}).get("desktop", {}).get("state", "") for a in d if a["id"] == sys.argv[1]), ""))' "$1"; }
shows() { api /api/shell | grep -q '"acks":true'; }

# A reader of the app's stream that is not the app, attached before it: it must hold no alert.
(curl -sN -m 900 "$URL/api/shell/events" > "$D/reader.out" 2>&1 & echo $! > "$D/host-reader.pid")

# The environment the app is started in asks the Qt engine for its debugging port and for no
# sandbox: neither may be taken without --devtools (checked in e2e-more.sh).
for _ in 1 2 3 4 5 6; do DEBUG_PORT=$((44200 + RANDOM % 1700)); listening "$DEBUG_PORT" || break; done
export QTWEBENGINE_CHROMIUM_FLAGS="--remote-debugging-port=$DEBUG_PORT" QTWEBENGINE_DISABLE_SANDBOX=1

# --- 1. the window
launch
check "the app's window opens" "wait_for 30 '[ \"\$(windows)\" = 1 ]'"
# What draws the page in this run (KEEL_DESKTOP_ENGINE=qt|webkit chooses; else Qt where its program and libraries are there).
ENGINE=$(last engine | sed 's/.*"name":"\([a-z]*\)".*/\1/')
echo "# engine: $ENGINE $(last qt | sed 's/.*"v":\({[^}]*}\).*/\1/')"
check "the shell found the daemon and attached to it" "wait_for 20 'last link | grep -q Up' && api /api/shell | grep -q '\"attached\":true'"
check "the tray host has the app's mark" "wait_for 10 \"grep -q 'ITEM ' '$D/tray-host.out'\""
sleep 3
read -r X Y W H _ <<< "$(geometry)"
check "the window has the remembered size (1920x1040, got ${W}x${H})" "[ \"$W\" = 1920 ] && [ \"$H\" = 1040 ]"
shot 01-window-light
# The page is drawn, not only alive: with the light theme the middle of the window's picture is
# light. (A window whose engine draws where the window cannot show it is black, and every other
# case here would still pass: the page answers and takes keys.)
if command -v convert > /dev/null; then
  light=$(convert "$D/shots/01-window-light.png" -gravity center -crop 50%x50%+0+0 +repage -colorspace Gray -resize 1x1 -depth 8 txt: 2> /dev/null | sed -n 's/^0,0: (\([0-9]*\).*/\1/p' | head -1)
  if [ "${light:-0}" -ge 150 ]; then ok "the window's page is drawn (the middle of its picture is light: $light of 255)"; else fail "the window's page is not drawn: the middle of its picture is dark (${light:-unread} of 255) under the light theme"; fi
else
  echo "# note: no ImageMagick here, so the window's picture was not read (whether the page is drawn was not checked)"
fi
# --- 1b. another keel-desktop on the same desktop and the same session bus, under the app's own
# name, started after the check's (so its pid is the higher one): the owner's own app, as far as
# the check can tell. Nothing the check launches may reach it.
owners_pid() { for p in $(pgrep -x keel-desktop); do tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -qx "KEEL_DESKTOP_DIR=$D/owners-app" && echo "$p"; done | tail -1; }
(unset KEEL_DESKTOP_INSTANCE KEEL_DESKTOP_PROBE; export KEEL_DESKTOP_DIR="$D/owners-app" KEEL_URL="http://127.0.0.1:$FOREIGN" KEEL_DESKTOP_LOG="$D/owners-app.jsonl" KEEL_BIN=/bin/false; HOME="$D/apphome" setsid nohup "$SHELL_BIN" --hidden >> "$D/owners-app.out" 2>&1 < /dev/null &)
check "another keel-desktop runs beside the check's, under the app's own name" "wait_for 15 \"grep -q '\\\"what\\\":\\\"command\\\"' '$D/owners-app.jsonl'\" && [ -n \"\$(owners_pid)\" ] && [ \"\$(app_pid)\" != \"\$(owners_pid)\" ] && [ \"\$(app_pids | wc -l)\" = 1 ]"

# The text size keys drive the page's own setting: one scale, which the title bar follows.
scale() { py 'import json,sys; print(json.load(open(sys.argv[1])).get("look", {}).get("scale"))' "$D/shell/shell.json"; }
$A key --id "$WS" ctrl+plus > /dev/null 2>&1
check "Ctrl and plus makes the page's text larger, and the title bar follows" "wait_for 5 '[ \"\$(scale)\" = 1.1 ]' && wait_for 5 \"said AT | grep -q 'scale=1.1'\""
$A key --id "$WS" ctrl+0 > /dev/null 2>&1
check "Ctrl and zero puts it back" "wait_for 5 '[ \"\$(scale)\" = 1.0 ]'"

# --- 2. a daemon restart under the window
$A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + 336)) > /dev/null 2>&1
$A type --id "$WS" "a draft that must survive the restart" > /dev/null 2>&1
loads=$(logged load)
daemon_down
check "the shell says the daemon is restarting" "wait_for 10 'last link | grep -q Restarting'"
sleep 4; shot 02-restarting-light
check "the tray says so too" "tray ToolTip | grep -q 'Keel is restarting'"
daemon_up
check "the shell sees it back" "wait_for 20 'last link | grep -q Up'"
sleep 3; shot 03-back-light
check "the window stayed: the page was not loaded again" "[ \"\$(logged load)\" = \"$loads\" ] && [ \"\$(windows)\" = 1 ]"

# --- 3. the tray count: a session that asks before it runs a command
ask=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: clean the build output"}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
api "/api/sessions/$ask/permissions" '{"mode":"ask","sandbox":"off"}' PUT > /dev/null
# (What it asks for leaves a mark when it runs: the check below presses Return after a link and the mark must not appear.)
MARK="$D/approved-by-link"
api "/api/sessions/$ask/messages" "{\"text\":\"script:calls [{\\\"name\\\":\\\"Bash\\\",\\\"input\\\":{\\\"command\\\":\\\"touch $MARK\\\"}}]\"}" POST > /dev/null
check "the tray counts what waits: 1 needs you" "wait_for 30 \"tray ToolTip | grep -q '1 needs you'\""
check "the mark asks for attention" "tray Status | grep -q NeedsAttention"
check "the menu leads with the count" "menu | grep -q '1 needs you'"

# --- 4. a notification, shown once, and its click
notes=$(grep -c '^NOTIFY ' "$D/notify-host.out" || true)
check "the approval reached the desktop as a notification of the shell's" "wait_for 20 \"[ \\\$(grep -c '^NOTIFY ' '$D/notify-host.out') -gt 0 ]\""
other=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: the failed deploy","text":"One line."}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
sleep 3
notes=$(grep -c '^NOTIFY ' "$D/notify-host.out" || true)
alert=$(api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$other\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["alert"]["id"])')
check "an alert is shown once, by the shell (the daemon shows none itself)" "wait_for 10 \"[ \\\$(grep -c '^NOTIFY ' '$D/notify-host.out') = $((notes + 1)) ]\" && sleep 2 && [ \"\$(grep -c '^NOTIFY ' '$D/notify-host.out')\" = $((notes + 1)) ] && wait_for 10 \"api '/api/alerts?limit=5' | grep -q '\\\"desktop\\\":{\\\"state\\\":\\\"sent\\\"'\""
nid=$(grep '^NOTIFY ' "$D/notify-host.out" | tail -1 | py 'import json,sys; print(json.loads(sys.stdin.read()[7:])["id"])')
check "it carries the app's name, icon and an action to open" "grep '^NOTIFY ' '$D/notify-host.out' | tail -1 | grep -q '\"entry\":\"$ID\"' && grep '^NOTIFY ' '$D/notify-host.out' | tail -1 | grep -q '\"default\"'"
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method test.Notifications.Click "$nid" > /dev/null
check "its click opens the session it names, in the window, with the desktop's activation token" "wait_for 15 \"last present | grep -q '/s/$other'\" && last click | grep -q '\"token\":true'"
check "the window's title is the session's" "wait_for 10 \"geometry | grep -q 'the failed deploy'\""
check "still without loading the page again" "[ \"\$(logged load)\" = \"$loads\" ]"
shot 04-notification-click-light
check "the reader of the stream that is not the app was handed no alert" "! grep -q 'event: notify' '$D/reader.out' && grep -q 'event: hello' '$D/reader.out'"

# --- 4b. an alert the app cannot show is the daemon's again (this scratch daemon shows none itself, so it records a failure, never "sent")
# (A session that is not on screen: the daemon sends no desktop alert for the one the owner is looking at.)
quiet=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: not on screen","text":"One line."}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
sleep 3
sig -STOP "$(app_pid)"
stopped=$(api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$quiet\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["alert"]["id"])')
check "with the app stopped by a signal, the alert is not recorded as shown and the app is detached" "wait_for 10 '[ \"\$(delivery $stopped)\" = failed ]' && ! shows"
sig -CONT "$(app_pid)"
check "the app attaches again when it runs on" "wait_for 20 shows"
sig -TERM "$(cat "$D/host-notify.pid")"; sleep 1
unshown=$(api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$quiet\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["alert"]["id"])')
check "with no notification service, the alert is not recorded as shown" "wait_for 10 '[ \"\$(delivery $unshown)\" = failed ]'"
( gjs -m "$HERE/notify-host.js" >> "$D/notify-host.out" 2>&1 & echo $! > "$D/host-notify.pid" ); sleep 1
check "and the app attaches again" "wait_for 20 shows"
notes=$(grep -c '^NOTIFY ' "$D/notify-host.out" || true)
again=$(api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$quiet\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["alert"]["id"])')
check "the next alert is the app's again: shown once and recorded as sent" "wait_for 10 '[ \"\$(delivery $again)\" = sent ]' && [ \"\$(grep -c '^NOTIFY ' '$D/notify-host.out')\" = $((notes + 1)) ]"

# --- 5. a second launch and a keel:// link
"$SHELL_BIN" "keel://session/$ask"; code=$?
check "a second launch ends at once and hands its link to the first" "[ $code = 0 ] && wait_for 10 \"last present | grep -q '/s/$ask'\" && [ \"\$(app_pids | wc -l)\" = 1 ]"
check "the link's session is on screen" "wait_for 10 \"geometry | grep -q 'clean the build output'\""
"$SHELL_BIN" "keel://session/../../etc/passwd" 2> /dev/null
"$SHELL_BIN" "keel://session/%2e%2e%2fapi%2fdrain" 2> /dev/null
"$SHELL_BIN" "keel://session/$other?approval=x" 2> /dev/null
check "a link to anything but a place of the page is refused, and so is one that carries a query" "sleep 3; ! grep '\"what\":\"present\"' '$D/shell.jsonl' | grep -q 'passwd\|drain\|approval' && said AT | grep -q \"AT $URL/s/$ask \""
sleep 2; shot 05-link-approval-light
# The link raised the window on a session with a request waiting: a Return on its way answers nothing.
$A key --id "$WS" Return > /dev/null 2>&1; sleep 3
check "Return after a link does not answer the waiting request" "[ ! -e '$MARK' ] && api /api/approvals | grep -q '$ask' && ! said AT | grep -q 'active=allow'"

# --- 5b. HTML a session wrote, shown in the sandboxed frame of the Artifacts panel: it drives nothing and reads nothing
art=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: a page the model wrote","text":"One line."}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
mkdir -p "$D/dev/state/artifacts/$art" && cp "$HERE/artifact.html" "$D/dev/state/artifacts/$art/shell-probe.html"
SECRET="clipboard-secret-$RANDOM"
if command -v wl-copy > /dev/null && [ "$BACKEND" != x11 ]; then (wl-copy "$SECRET" > /dev/null 2>&1 &); else SECRET=; fi
sessions_before=$(grep -c '"window":"session"' "$D/shell.jsonl" || true)
"$SHELL_BIN" "keel://session/$art"
check "the artifact's frame ran its script" "wait_for 30 \"said 'ARTIFACT DONE' | grep -q DONE\""
# (WebKit's channel is open to every frame; Qt's does not reach a frame at all.)
reach=true; [ "$ENGINE" = qt ] && reach=false
check "it has the engine's channel ($reach under $ENGINE) but not the app's object, and none of its messages was acted on" "grep -aq '^PROBE ARTIFACT handler=$reach keelShell=undefined' '$D/shell.out' && [ \"\$(grep -c '\"window\":\"session\"' '$D/shell.jsonl' || true)\" = \"$sessions_before\" ] && [ \"\$(windows)\" = 1 ] && ! grep -q '\"what\":\"external\"' '$D/shell.jsonl' && ! grep -qi 'ff0000' '$D/shell/shell.json' && [ \"\$(logged start)\" = 0 ]"
check "it read nothing from the clipboard" "grep -aq '^PROBE ARTIFACT CLIP exec=' '$D/shell.out' && ! grep -a '^PROBE ARTIFACT CLIP' '$D/shell.out' | grep -q 'clipboard-secret' && ! grep -aq '^PROBE ARTIFACT CLIP event=' '$D/shell.out' && grep -aq '^PROBE ARTIFACT CLIP read refused' '$D/shell.out'"
[ -n "$SECRET" ] || echo "# note: no wl-copy for this backend, so the clipboard held no secret; the refusal itself was still checked"

# --- 5b2. the review's race: the owner clicks once inside the artifact, then pastes a copied picture into the message box
read -r X Y W H _ <<< "$(geometry)"
if [ -n "$SECRET" ]; then
  py 'import struct,sys,zlib
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
w, h = 40, 30
rows = b"".join(b"\x00" + bytes([18, 128, 153]) * w for _ in range(h))
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))' "$D/paste.png"
  (wl-copy -t image/png < "$D/paste.png" > /dev/null 2>&1 &); sleep 1
  # inside the frame (it sits in the lower right corner of the page), then the message box, then the paste key.
  # KEEL_E2E_5B2_TIMES: how often, each time with the frame shown anew (the race is one of timing).
  times=${KEEL_E2E_5B2_TIMES:-1}; attached=0
  for i in $(seq 1 "$times"); do
    if [ "$i" -gt 1 ]; then
      shown=$(grep -ac '^PROBE FRAME shown' "$D/shell.out"); done_before=$(grep -ac '^PROBE ARTIFACT DONE' "$D/shell.out")
      $A key --id "$WS" F8 > /dev/null 2>&1
      wait_for 20 "[ \"\$(grep -ac '^PROBE FRAME shown' '$D/shell.out')\" -gt $shown ] && [ \"\$(grep -ac '^PROBE ARTIFACT DONE' '$D/shell.out')\" -gt $done_before ]" || true
      sleep 1
    fi
    $A click --id "$WS" $((X + W - 16 - 176)) $((Y + H - 16 - 96)) > /dev/null 2>&1; sleep 0.7
    $A click --id "$WS" $((X + 1120)) $((Y + 953)) > /dev/null 2>&1; sleep 0.4
    $A key --id "$WS" ctrl+v > /dev/null 2>&1
    if wait_for 10 "said AT | grep -q 'imgs=$i'"; then attached=$((attached + 1)); fi
    sleep 4
  done
  [ "$times" = 1 ] || echo "# the race of case 5b2, $times times: the picture was attached $attached times, and landed in the frame $(grep -ac '^PROBE ARTIFACT PASTE landed' "$D/shell.out") times"
  check "the owner's paste of a copied picture attaches it" "[ $attached = $times ]"
  # (The Qt engine would hand the clipboard to whatever frame has the keyboard: there the app takes the paste keys and the page decides.)
  if [ "$ENGINE" = qt ]; then check "each paste key was the app's to hand to the page, not the engine's" "[ \"\$(grep -ac '^PROBE PASTE-KEY handed' '$D/shell.out')\" -ge $times ]"; fi
  check "the frame the owner had clicked in asked for the clipboard and got nothing" "grep -aq '^PROBE ARTIFACT CLICKED' '$D/shell.out' && grep -aq '^PROBE ARTIFACT CLIP timer' '$D/shell.out' && ! grep -a '^PROBE ARTIFACT CLIP timer' '$D/shell.out' | grep -q 'read='"
  check "it asked for the keyboard too, and the paste did not land in it" "! grep -aq '^PROBE ARTIFACT PASTE landed' '$D/shell.out'"
else
  echo "# note: the paste of a copied picture needs wl-copy and the native Wayland backend"
fi

# --- 5b3. the clipboard through the app: at the owner's press, and not without one
$A click --id "$WS" $((X + W / 2)) $((Y + 200)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" F7 > /dev/null 2>&1
check "a copy announced at the owner's press is written" "wait_for 5 \"grep -aq '^PROBE COPIED id=9001 ok=true' '$D/shell.out'\""
check "a copy four seconds later, with no press, is refused" "wait_for 8 \"grep -aq '^PROBE COPIED id=9002 ok=false' '$D/shell.out'\""
if [ -n "$SECRET" ] && command -v wl-paste > /dev/null; then
  check "the clipboard holds the copy the press allowed" "[ \"\$(wl-paste -n 2> /dev/null)\" = copied-by-the-check ]"
fi
if [ -n "$SECRET" ]; then
  # A picture larger than the page keeps one is handed over at that size, made ready off the main loop.
  py 'import struct,sys,zlib
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
w, h = 3000, 2000
row = b"\x00" + bytes([18, 128, 153]) * w
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h, 1)) + chunk(b"IEND", b""))' "$D/large.png"
  (wl-copy -t image/png < "$D/large.png" > /dev/null 2>&1 &); sleep 1.5
  $A key --id "$WS" F5 > /dev/null 2>&1
  check "a large pasted picture is handed over at the size the page keeps (3000x2000 as 1568x1045)" "wait_for 15 \"grep -aq '^PROBE PASTED id=9005 refused=false .*images=1 size=1568x1045 from=3000x2000' '$D/shell.out'\""
  # Bytes that are no picture, offered as one: said as a picture that could not be read, not as an empty clipboard.
  head -c 300000 /dev/urandom > "$D/broken.png"
  (wl-copy -t image/png < "$D/broken.png" > /dev/null 2>&1 &); sleep 1.5
  $A key --id "$WS" F5 > /dev/null 2>&1
  check "a picture that cannot be read is said to the page" "wait_for 15 \"grep -aq '^PROBE PASTED id=9005 refused=false .*images=0.* failed=true' '$D/shell.out'\""
  (wl-copy copied-by-the-check > /dev/null 2>&1 &); sleep 1
fi
$A key --id "$WS" F6 > /dev/null 2>&1
check "a paste is read at the owner's press" "wait_for 5 \"grep -aq '^PROBE PASTED id=9003 refused=false' '$D/shell.out'\""
check "a paste four seconds later, with no press, is refused" "wait_for 8 \"grep -aq '^PROBE PASTED id=9004 refused=true' '$D/shell.out'\""

# --- 5c. the main frame stays on the daemon's origin
(python3 "$HERE/listener.py" "$FOREIGN" 200 12 > "$D/foreign.out" 2>&1 &)
read -r X Y W H _ <<< "$(geometry)"
$A click --id "$WS" $((X + W / 2)) $((Y + 200)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" F8 > /dev/null 2>&1
# The page's own script still reports after the attempt: the page that was there is the page that is there.
check "a page that tries to leave the daemon's origin stays where it was, not loaded again" "wait_for 10 \"said LEAVING | grep -q LEAVING\" && sleep 5 && grep -a '^PROBE ' '$D/shell.out' | tail -1 | grep -q \"^PROBE AT $URL/s/$art shell=object\" && [ \"\$(logged load)\" = \"$loads\" ] && [ \"\$(windows)\" = 1 ] && ! geometry | grep -qi foreign"

# --- 5c2. the main frame shows places of the page only: not an artifact's own address, which is a sandboxed document
$A click --id "$WS" $((X + W / 2)) $((Y + 200)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" F9 > /dev/null 2>&1
check "the main frame does not show an artifact's own address, and the artifact gets no app object" "wait_for 10 \"said GOING-RAW | grep -q GOING\" && sleep 5 && grep -a '^PROBE ' '$D/shell.out' | tail -1 | grep -q \"^PROBE AT $URL/s/$art shell=object\" && ! grep -aq '^PROBE ARTIFACT handler=true keelShell=object' '$D/shell.out' && [ \"\$(logged load)\" = \"$loads\" ] && [ \"\$(windows)\" = 1 ]"
# The same address as a file to keep is saved, and the page is not loaded again.
$A key --id "$WS" F10 > /dev/null 2>&1
# (Nothing announced it: a file is kept when the page offered it at a link the owner pressed, and this is no such thing.)
check "a navigation to a file of the daemon's keeps no file, and the page stays" "wait_for 10 \"said GOING-DOWNLOAD | grep -q GOING\" && sleep 3 && [ ! -e '$D/apphome/Downloads/shell-probe.html' ] && grep -a '^PROBE ' '$D/shell.out' | tail -1 | grep -q \"^PROBE AT $URL/s/$art shell=object\" && [ \"\$(logged load)\" = \"$loads\" ]"
# The file offered as the page offers one (a link to keep it): saved under a free name in the downloads folder, never over a file.
kept=$(ls "$D/apphome/Downloads" 2> /dev/null | wc -l); notes=$(logged download)
$A key --id "$WS" F10 > /dev/null 2>&1
check "a file the page offers is saved to the downloads folder under a free name, and the page stays" "wait_for 10 \"[ \\\"\\\$(ls '$D/apphome/Downloads' | wc -l)\\\" = $((kept + 1)) ] && [ \\\"\\\$(logged download)\\\" = $((notes + 1)) ]\" && sleep 2 && ls '$D/apphome/Downloads' | grep -q '^shell-probe' && [ -z \"\$(ls -A '$D/apphome' | grep -v '^Downloads\$' | grep -i probe)\" ] && grep -a '^PROBE ' '$D/shell.out' | tail -1 | grep -q \"^PROBE AT $URL/s/$art shell=object\" && [ \"\$(logged load)\" = \"$loads\" ]"
# The same file offered by a script alone, twelve seconds after the owner's last press: nothing is kept.
# (No key and no click in between: the probe offers it by itself.)
before=$(ls "$D/apphome/Downloads" 2> /dev/null | wc -l)
if wait_for 20 "said OFFERING-LATE | grep -q LATE" && sleep 4 && [ "$(ls "$D/apphome/Downloads" | wc -l)" = "$before" ]; then ok "a file a script offers with no press of the owner's is not kept"; else fail "a file a script offers with no press of the owner's is not kept (the folder holds $(ls "$D/apphome/Downloads" | wc -l), held $before)"; fi

# --- 5d. focus: a launch with the desktop's activation token brings the window in front of another app, and only then
if [ "$BACKEND" = kwin ]; then
  active() { $A active-window --id "$WS" 2> /dev/null | py 'import json,sys; print((json.load(sys.stdin).get("active_window") or {}).get("title", ""))'; }
  ( gjs -m "$HERE/other-app.js" "$D/token" > "$D/other-app.out" 2>&1 & echo $! > "$D/host-other.pid" )
  wait_for 10 "grep -q READY '$D/other-app.out'"; sleep 1
  oid=$($A windows --id "$WS" 2> /dev/null | py 'import json,sys; print(next((w["id"] for w in json.load(sys.stdin).get("windows", []) if w.get("title") == "Another app"), ""))')
  $A focus-window --id "$WS" "$oid" > /dev/null 2>&1
  check "another app has the keyboard" "wait_for 5 \"active | grep -q 'Another app'\""
  env -u XDG_ACTIVATION_TOKEN -u DESKTOP_STARTUP_ID "$SHELL_BIN"
  XDG_ACTIVATION_TOKEN=made-up-token "$SHELL_BIN"
  sleep 2
  if active | grep -q 'Another app'; then ok "a launch without the desktop's token, or with a made-up one, does not take the keyboard from it"
  else
    # Without a token the desktop decides, and some let an app the owner has just used come
    # forward when its toolkit asks with a token of its own. The other app gets the keyboard back.
    echo "# note: this desktop let a launch without its token come forward (the app's toolkit asked by itself, on the owner's last press in it)"
    $A focus-window --id "$WS" "$oid" > /dev/null 2>&1
    wait_for 5 "active | grep -q 'Another app'" || true
  fi
  # The other app asks the desktop for a token at a key of the owner's in it. (It must have the
  # keyboard for that key: asked for again when the key did not reach it.)
  for _ in 1 2 3; do
    $A focus-window --id "$WS" "$oid" > /dev/null 2>&1
    wait_for 5 "active | grep -q 'Another app'" || true
    $A key --id "$WS" t > /dev/null 2>&1
    wait_for 5 "[ -s '$D/token' ]" && break
  done
  if [ -s "$D/token" ]; then
    XDG_ACTIVATION_TOKEN=$(cat "$D/token") "$SHELL_BIN"
    check "a launch with the desktop's token brings Keel's window to the front" "wait_for 5 \"active | grep -q 'Keel'\" && last present | grep -q '\"token\":true'"
  else
    fail "the other app was given no token by this desktop, so a launch with one was not tried"
  fi
  sig -TERM "$(cat "$D/host-other.pid")"
else
  echo "# note: focus on a launch with the desktop's activation token is checked under the native Wayland backend"
fi

# --- 6. the tray menu: pause and resume
check "the menu offers open, new session, pause and quit" "menu | grep -q 'Open Keel' && menu | grep -q 'New Session' && menu | grep -q 'Pause Notifications' && menu | grep -q \"'Quit'\""
pick 7
check "pause holds the daemon's alerts" "wait_for 10 \"api /api/snooze | grep -q '\\\"until_ms\\\":[0-9]'\" && wait_for 10 \"menu | grep -q 'Resume Notifications'\""
pick 6
check "resume lets them through again" "wait_for 10 \"api /api/snooze | grep -q '\\\"snooze\\\":null'\" && wait_for 10 \"menu | grep -q 'Pause Notifications'\""

# --- 7. the dark theme: the title bar follows the page
read -r X Y W H _ <<< "$(geometry)"
for _ in 1 2 3; do
  grep -q '"dark":true' "$D/shell/shell.json" && break
  # (Each click is given time to arrive: a second one would turn the theme back.)
  $A click --id "$WS" $((X + 288)) $((Y + H - 28)) > /dev/null 2>&1; wait_for 6 "grep -q '\"dark\":true' '$D/shell/shell.json'" || true
done
$A click --id "$WS" $((X + W - 300)) $((Y + H / 2)) > /dev/null 2>&1
check "the page's theme reached the shell (dark)" "grep -q '\"dark\":true' '$D/shell/shell.json'"
sleep 1; shot 06-window-dark
daemon_down
wait_for 10 'last link | grep -q Restarting'; sleep 4; shot 07-restarting-dark
check "past the wait for a restart, the shell says the daemon is not running" "wait_for 25 'last link | grep -q Down' && tray ToolTip | grep -q 'Keel is not running'"
sleep 1; shot 08-not-running-dark

# --- 8. the size is remembered, and quitting leaves the daemon alone
daemon_up; wait_for 20 'last link | grep -q Up'
# Quit and stop the daemon asks first, and names the turn it would end.
run=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: a long build"}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
api "/api/sessions/$run/permissions" '{"mode":"full-auto","sandbox":"off"}' PUT > /dev/null
api "/api/sessions/$run/messages" '{"text":"script:calls [{\"name\":\"Bash\",\"input\":{\"command\":\"sleep 40; echo ok\"}}]"}' POST > /dev/null
wait_for 15 "api /api/shell | grep -q 'a long build'"
pick 11
check "quit and stop the daemon asks first, naming the session at work" "wait_for 10 \"last confirm | grep -q 'a long build'\" && [ \"\$(app_pids | wc -l)\" = 1 ] && api /api/daemon | grep -q '\"draining\":null'"
sleep 1; shot 12-stop-question-dark all
$A key --id "$WS" Escape > /dev/null 2>&1
check "Cancel keeps the app, the daemon and the turn" "wait_for 10 \"last confirmed | grep -q '\\\"stop\\\":false'\" && sleep 1 && [ \"\$(app_pids | wc -l)\" = 1 ] && api /api/daemon | grep -q '\"draining\":null' && api /api/shell | grep -q 'a long build'"
api "/api/sessions/$run/interrupt" '{}' POST > /dev/null 2>&1
$A resize-window --id "$WS" --pid "$(win_pid)" 1500 900 > /dev/null 2>&1; sleep 1.5
pick 10
check "quit from the tray ends the app" "wait_for 10 '[ \"\$(app_pids | wc -l)\" = 0 ]'"
check "the daemon keeps running, and sees the app gone" "api /api/health | grep -q pid && wait_for 10 \"api /api/shell | grep -q '\\\"attached\\\":false'\""
check "the size was saved (1500x900)" "py 'import json; d=json.load(open(\"$D/shell/shell.json\")); assert abs(d[\"width\"]-1500) <= 2 and abs(d[\"height\"]-900) <= 2, d'"

# --- 9. started with no daemon: the calm page and its one button
daemon_down
launch
wait_for 30 '[ "$(windows)" = 1 ]'; sleep 3
read -r X Y W H _ <<< "$(geometry)"
check "the window comes back at the remembered size (${W}x${H})" "[ \$(( W - 1500 < 0 ? 1500 - W : W - 1500 )) -le 2 ] && [ \$(( H - 900 < 0 ? 900 - H : H - 900 )) -le 2 ]"
check "with no daemon the shell says it is not running" "wait_for 10 'last link | grep -q Down'"
shot 09-away-dark
# The button has the keyboard: Return presses it.
$A key --id "$WS" Return > /dev/null 2>&1
check "the button starts the daemon" "wait_for 60 'last link | grep -q Up' && last start | grep -q '\"starting\":true'"
check "and the page loads by itself" "wait_for 15 \"[ \\\$(logged load) -ge 1 ] && last load | grep -q main\""
sleep 4; shot 10-started-dark
real=$(api /api/providers | py 'import json,sys; d=json.load(sys.stdin); d=d.get("providers", d); print(" ".join(x["id"] for x in d if x.get("available") and x["id"] not in ("scripted","acp","alibaba")))')
check "the daemon it started is the scratch one (no real provider)" "[ -z \"$real\" ]"

# --- 10. a session in a window of its own
said_before=$(wc -l < "$D/shell.out")
"$SHELL_BIN" --window "/s/$other"
wait_for 20 '[ "$(windows)" = 2 ]'
check "a session opens in a window of its own (the app has $(windows) windows)" "[ \"\$(windows)\" = 2 ] && grep '\"what\":\"present\"' '$D/shell.jsonl' | tail -3 | grep -q '\"window\":\"session\"'"
[ "$(windows)" = 2 ] || $A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys
for w in json.load(sys.stdin).get("windows", []): print("# window:", w.get("title"), w["geometry"])'
sleep 4; shot 11-session-window-dark all
check "the session's window does not fight for the place it shows (no error from the page)" "! api '/api/errors?limit=100' | grep -qi 'replaceState\|history'"
check "the session's window shows its session, with the app's object" "wait_for 15 \"tail -n +$((said_before + 1)) '$D/shell.out' | grep -aq '^PROBE AT $URL/s/$other shell=object'\""

# --- 10b. the Qt engine's program stops under the app: it is started again and the windows come back
if [ "$ENGINE" = qt ]; then
  drew=$(win_pid); loads=$(logged load)
  sig -KILL "$drew"
  check "the program that draws the windows was killed: the app starts it again and both windows come back on the page" "wait_for 30 \"[ \\\"\\\$(win_pid)\\\" != $drew ] && [ \\\"\\\$(win_pid)\\\" != \\\"\\\$(app_pid)\\\" ] && [ \\\"\\\$(windows)\\\" = 2 ] && [ \\\"\\\$(logged load)\\\" -ge $((loads + 2)) ]\" && [ \"\$(app_pids | wc -l)\" = 1 ]"
  said_before=$(wc -l < "$D/shell.out")
  check "and the page in them is the app's again" "wait_for 15 \"tail -n +$((said_before + 1)) '$D/shell.out' | grep -aq '^PROBE AT $URL/s/$other shell=object'\""
fi

# --- 10c. what the review of the Qt engine asked for (a frame that asks for the keyboard in a loop, on both engines; the rest for Qt)
. "$HERE/e2e-more.sh"

# --- 11. a stranger on the daemon's port while the daemon is down is never sent the token
(eval "$ENVSH"; "$SHELL_BIN" --quit > /dev/null 2>&1); wait_for 10 '[ "$(app_pids | wc -l)" = 0 ]'
daemon_down
check "the state folder holds a token to protect" "[ -s '$D/dev/state/api-token' ]"
# The review's case: a lock left by a crash, whose pid a live process of this account has since
# been given (here the stand-in tray host), at the stranger's address.
printf '{"pid":%s,"born":"another-boot:1","url":"%s"}' "$(cat "$D/host-tray.pid")" "$URL" > "$D/dev/state/daemon.lock"
(python3 "$HERE/listener.py" "$PORT" 403 14 health > "$D/stranger.out" 2>&1 &)
sleep 0.5; launch
check "the app spoke to the stranger, on the health path and past it" "wait_for 12 \"grep -q 'REQUEST GET /api/health' '$D/stranger.out' && grep -q 'REQUEST GET /api/shell' '$D/stranger.out'\""
sleep 3
check "and never sent it the token, though the lock names a live process of this account" "! grep -q 'authorization=yes' '$D/stranger.out'"

# --- 12. an address that is not this machine's: the first page says so, and nothing is started there
(eval "$ENVSH"; "$SHELL_BIN" --quit > /dev/null 2>&1); wait_for 10 '[ "$(app_pids | wc -l)" = 0 ]'
printf '#!/usr/bin/env bash\necho "$@" > "%s"\n' "$D/stub-ran" > "$D/keel-stub"; chmod +x "$D/keel-stub"
starts=$(logged start)
(export KEEL_URL="http://10.0.0.9:$PORT" KEEL_BIN="$D/keel-stub"; launch)
wait_for 30 '[ "$(windows)" = 1 ]'; sleep 3
check "the first page says the address is not this machine's" "last away | grep -q '\"refused\":true' && last away | grep -q '10.0.0.9:$PORT'"
check "the tray offers no start for it" "! menu | grep -q 'Start Keel'"
shot 13-refused-address-dark
$A key --id "$WS" Return > /dev/null 2>&1; sleep 3
check "Return starts nothing there" "[ ! -e '$D/stub-ran' ] && [ \"\$(logged start)\" = \"$starts\" ]"

# --- 13. one shell takes the alerts: an app that attached second is told, and takes them when the first leaves
(eval "$ENVSH"; "$SHELL_BIN" --quit > /dev/null 2>&1); wait_for 10 '[ "$(app_pids | wc -l)" = 0 ]'
rm -f "$D/dev/state/daemon.lock"
wait_for 20 "! listening $PORT" # the stranger of section 11 lets go of the port
daemon_up
(curl -sN -m 120 "$URL/api/shell/events?acks=1&engine=another" > "$D/first-shell.out" 2>&1 & echo $! > "$D/host-first.pid")
wait_for 10 "grep -q 'event: hello' '$D/first-shell.out'"
check "the shell that attached first is the one handed the alerts" "grep -A1 'event: hello' '$D/first-shell.out' | grep -q '\"takes\":true'"
launch
check "the app, attached second, is told another takes the alerts, and its menu says so" "wait_for 30 \"last takes | grep -q '\\\"takes\\\":false'\" && wait_for 10 \"menu | grep -q 'Another Keel app shows the notifications'\""
sig -TERM "$(cat "$D/host-first.pid")"
check "when the first leaves, the app is told the alerts are its own" "wait_for 20 \"last takes | grep -q '\\\"takes\\\":true'\" && wait_for 10 \"! menu | grep -q 'Another Keel app shows the notifications'\""

# --- 14. the other keel-desktop was never reached: one launch of its own, no window raised, not quit
check "nothing the check launched reached the other keel-desktop" "[ \"\$(grep -c '\"what\":\"command\"' '$D/owners-app.jsonl')\" = 1 ] && ! grep -q '\"what\":\"present\"\|\"what\":\"quit\"\|\"what\":\"pick\"' '$D/owners-app.jsonl' && [ -n \"\$(owners_pid)\" ]"
(unset KEEL_DESKTOP_INSTANCE; KEEL_DESKTOP_DIR="$D/owners-app" "$SHELL_BIN" --quit > /dev/null 2>&1)
check "and its own launch still reaches it" "wait_for 10 '[ -z \"\$(owners_pid)\" ]'"

echo "$((n - fails)) of $n passed"
[ "$fails" = 0 ]
