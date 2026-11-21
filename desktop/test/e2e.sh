#!/usr/bin/env bash
# The end-to-end check of the desktop shell, in a hidden desktop: never the
# owner's screen, never their daemon. It starts a scratch daemon with the
# scripted stand-in model only, a hidden workspace (agent-workspace-linux), a
# stand-in tray host and a stand-in notification service on that workspace's
# session bus, and the shell inside it. It proves the window, the survival of
# a daemon restart, the tray count, a notification's click, a second launch,
# a keel:// link, the remembered size, and the start button.
#
#   desktop/test/e2e.sh                   native Wayland GNOME workspace
#   KEEL_E2E_BACKEND=x11 desktop/test/e2e.sh   an X11 workspace (also checks a session's own window)
#
# Needs: agent-workspace-linux, gjs, gdbus, curl, python3, bun, and the builds
# (dist/keel from `bun scripts/build.ts`, desktop/dist/keel-desktop from
# `desktop/build.sh`). Screenshots and logs stay in the folder it prints.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ID=io.github.agent_sh.Keel
BACKEND=${KEEL_E2E_BACKEND:-gnome}
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
app_pid() { pgrep -n -x keel-desktop || echo 0; }
logged() { grep -c "\"what\":\"$1\"" "$D/shell.jsonl" 2> /dev/null || true; }
last() { grep "\"what\":\"$1\"" "$D/shell.jsonl" 2> /dev/null | tail -1; }
# a picture of the app's largest window alone (of the whole desktop with `all`)
shot() {
  local id; id=$($A windows --id "$WS" --pid "$(app_pid)" 2> /dev/null | py 'import json,sys
ws=json.load(sys.stdin).get("windows", [])
print(max(ws, key=lambda w: w["geometry"]["width"]*w["geometry"]["height"])["id"] if ws else "")')
  if [ "${2:-}" = all ] || [ -z "$id" ]; then $A screenshot --id "$WS" --output "$D/shots/$1.png" > /dev/null 2>&1
  else $A screenshot-window --id "$WS" --window "$id" --output "$D/shots/$1.png" > /dev/null 2>&1; fi
}
# the main window: "x y width height title"
geometry() { $A windows --id "$WS" --pid "$(app_pid)" 2> /dev/null | py 'import json,sys
ws=json.load(sys.stdin).get("windows", [])
w=max(ws, key=lambda w: w["geometry"]["width"]*w["geometry"]["height"]) if ws else None
print(*( [w["geometry"][k] for k in ("x","y","width","height")] + [w.get("title","")] ) if w else "")'; }
windows() { $A windows --id "$WS" --pid "$(app_pid)" 2> /dev/null | py 'import json,sys; print(len(json.load(sys.stdin).get("windows", [])))'; }
api() { curl -fsS -m 10 -X "${3:-GET}" -H 'content-type: application/json' ${2:+-d "$2"} "$URL$1"; }
tray() { gdbus call --session --dest "$ID" --object-path /StatusNotifierItem --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem "$1" 2> /dev/null; }
menu() { gdbus call --session --dest "$ID" --object-path /StatusNotifierItem/Menu --method com.canonical.dbusmenu.GetLayout 0 1 "@as []" 2> /dev/null; }
pick() { gdbus call --session --dest "$ID" --object-path /StatusNotifierItem/Menu --method com.canonical.dbusmenu.Event "$1" clicked "<0>" 0 > /dev/null 2>&1; }

# --- the scratch daemon: a clean environment, a home of its own, the scripted model only
for _ in 1 2 3 4 5 6; do PORT=$((48200 + RANDOM % 1700)); ss -ltn | grep -q ":$PORT " || break; done
URL=http://127.0.0.1:$PORT
cat > "$D/keel" <<EOF
#!/usr/bin/env bash
# Stands in for the keel program the shell starts: the scratch daemon of this check.
cd "$REPO" && exec env -i PATH="$(dirname "$(command -v bun)"):/usr/local/bin:/usr/bin:/bin" HOME="$D/home" ${TMPDIR:+TMPDIR="$TMPDIR"} LANG=C.UTF-8 \\
  KEEL_KEYRING_SERVICE=keel-scratch-empty KEEL_DESKTOP_NOTIFY=off DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus XDG_RUNTIME_DIR="$D/home/run" KEEL_CRED_GET=/bin/false \\
  KEEL_DEV_DIR="$D/dev" KEEL_SCRIPTED_PROVIDER=1 KEEL_DEFAULT_MODEL=scripted:stand-in-strict KEEL_SERVER_NAME=desktop-e2e KEEL_BIN="$KEEL" bash scripts/dev.sh $PORT
EOF
chmod +x "$D/keel"
daemon_up() { (setsid nohup "$D/keel" >> "$D/daemon.log" 2>&1 < /dev/null &); wait_for 60 "curl -fsS -m 2 $URL/api/daemon | grep -q '$D/dev'"; }
daemon_down() {
  for p in $(ss -ltnpH "sport = :$PORT" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do tr '\0' ' ' < "/proc/$p/cmdline" | grep -q "$D/dev" && kill "$p"; done
  wait_for 20 "! curl -fsS -m 1 $URL/api/health"
}
cleanup() {
  [ -n "${WS_UP:-}" ] && (eval "$ENVSH"; KEEL_DESKTOP_DIR="$D/shell" "$SHELL_BIN" --quit > /dev/null 2>&1)
  daemon_down > /dev/null 2>&1
  for f in "$D"/host-*.pid; do [ -s "$f" ] && kill "$(cat "$f")" 2> /dev/null; done
  [ -n "${WS_UP:-}" ] && $A stop --id "$WS" > /dev/null 2>&1
  echo "evidence: $D"
}
trap cleanup EXIT
daemon_up || { echo "the scratch daemon did not come up; see $D/daemon.log"; exit 2; }
sleep 8
real=$(api /api/providers | py 'import json,sys; d=json.load(sys.stdin); d=d.get("providers", d); print(" ".join(x["id"] for x in d if x.get("available") and x["id"] not in ("scripted","acp","alibaba")))')
[ -z "$real" ] || { echo "the scratch daemon has real providers ($real): stopping"; exit 2; }

# --- the hidden desktop, with a tray host and a notification service of the check's own
$A start --ack-hidden-workspace --id "$WS" --session "$BACKEND" --width 2560 --height 1440 --purpose "keel-desktop end-to-end check" > "$D/workspace.json" 2>&1 || { echo "the hidden workspace did not start; see $D/workspace.json"; exit 2; }
WS_UP=1
ENVSH=$($A env --id "$WS" --shell 2> /dev/null)
[ -n "$ENVSH" ] || { echo "no environment for the workspace"; exit 2; }
# Everything below that touches the desktop runs with the workspace's environment.
eval "$ENVSH"
[ "$BACKEND" = x11 ] && export GDK_BACKEND=x11
( gjs -m "$HERE/tray-host.js" > "$D/tray-host.out" 2>&1 & echo $! > "$D/host-tray.pid" )
( gjs -m "$HERE/notify-host.js" > "$D/notify-host.out" 2>&1 & echo $! > "$D/host-notify.pid" )
wait_for 10 "grep -q READY '$D/tray-host.out' && grep -q READY '$D/notify-host.out'" || { echo "the stand-in hosts did not start"; exit 2; }

export KEEL_DESKTOP_DIR="$D/shell" KEEL_URL="$URL" KEEL_STATE_DIR="$D/dev/state" KEEL_BIN="$D/keel" KEEL_DESKTOP_LOG="$D/shell.jsonl" KEEL_DESKTOP_NO_BROWSER=1
echo '{"width":1920,"height":1040,"maximized":false,"zoom":1}' > "$D/shell/shell.json"
launch() { (setsid nohup "$SHELL_BIN" "$@" >> "$D/shell.out" 2>&1 < /dev/null &); }

# --- 1. the window
launch
check "the app's window opens" "wait_for 30 '[ \"\$(windows)\" = 1 ]'"
check "the shell found the daemon and attached to it" "wait_for 20 'last link | grep -q Up' && api /api/shell | grep -q '\"attached\":true'"
check "the tray host has the app's mark" "wait_for 10 \"grep -q 'ITEM ' '$D/tray-host.out'\""
sleep 3
read -r X Y W H _ <<< "$(geometry)"
check "the window has the remembered size (1920x1040, got ${W}x${H})" "[ \"$W\" = 1920 ] && [ \"$H\" = 1040 ]"
shot 01-window-light

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
api "/api/sessions/$ask/messages" '{"text":"script:calls [{\"name\":\"Bash\",\"input\":{\"command\":\"rm -rf dist build\"}}]"}' POST > /dev/null
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

# --- 5. a second launch and a keel:// link
"$SHELL_BIN" "keel://session/$ask"; code=$?
check "a second launch ends at once and hands its link to the first" "[ $code = 0 ] && wait_for 10 \"last present | grep -q '/s/$ask'\" && [ \"\$(pgrep -x keel-desktop | wc -l)\" = 1 ]"
check "the link's session is on screen" "wait_for 10 \"geometry | grep -q 'clean the build output'\""
"$SHELL_BIN" "keel://session/../../etc/passwd" 2> /dev/null
check "a link to anything but a place of the page is refused" "sleep 1; ! last present | grep -q passwd"
sleep 1; shot 05-link-approval-light

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
  $A click --id "$WS" $((X + 288)) $((Y + H - 28)) > /dev/null 2>&1; sleep 1.5
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
$A resize-window --id "$WS" --pid "$(app_pid)" 1500 900 > /dev/null 2>&1; sleep 1.5
pick 10
check "quit from the tray ends the app" "wait_for 10 '[ \"\$(pgrep -x keel-desktop | wc -l)\" = 0 ]'"
check "the daemon keeps running" "api /api/health | grep -q pid && api /api/shell | grep -q '\"attached\":false'"
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
"$SHELL_BIN" --window "/s/$other"
check "a session opens in a window of its own" "wait_for 20 '[ \"\$(windows)\" = 2 ]' && last present | grep -q '\"window\":\"session\"'"
sleep 4; shot 11-session-window-dark all
if [ "$BACKEND" = gnome ]; then
  echo "# note: under the headless GNOME workspace a second web view of one process is given no size (a bare WebKitGTK window shows the same), so the session window's content is checked under KEEL_E2E_BACKEND=x11"
fi

echo "$((n - fails)) of $n passed"
[ "$fails" = 0 ]
