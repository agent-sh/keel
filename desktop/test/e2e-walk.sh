# Part of e2e.sh (read there, with the app up on the scratch daemon, at the owner's window size): a walk through what
# the owner uses every day, in the light theme and then the dark one: the state dots of the rail and their glow, the
# two lines over the message box and the places their buttons lead to, the microphone, the helper's face on its
# notifications, and the tray's list. It is also run alone: `KEEL_E2E_ONLY=walk desktop/test/e2e.sh`.

walk_ws="$D/walk-ws"; mkdir -p "$walk_ws/src"; echo 'export const a = 1;' > "$walk_ws/src/a.ts"
git -C "$walk_ws" init -q 2> /dev/null || true
# A prompt that carries the scripted model's calls, as a JSON body for the daemon.
calls_of() { py 'import json,sys; print(json.dumps({"text": "script:calls " + sys.argv[1]}))' "$1"; }
mk_session() { api /api/sessions "$(py 'import json,sys; print(json.dumps({"model":"scripted:stand-in","title":sys.argv[1],"workspace":sys.argv[2]}))' "$1" "$2")" POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])'; }
rested() { api "/api/sessions/$1" | py 'import json,sys; d=json.load(sys.stdin); print(0 if d.get("running") or d["events"][-1]["kind"] != "turn_end" else 1)'; }
# Where the page said a button of the lines over the message box is (its middle, and the page's size).
where() { grep -a '^PROBE WHERE ' "$D/shell.out" | tail -1 | tr ' ' '\n' | grep "^$1=" | cut -d= -f2; }
page_size() { grep -a '^PROBE WHERE ' "$D/shell.out" | tail -1 | sed 's/.* size=//'; }
# A press on an element of the page, found from the window's edges (the page reaches its left, right and bottom).
press_at() {
  local xy sz; xy=$(where "$1"); sz=$(page_size)
  { [ -n "$xy" ] && [ "$xy" != "-" ]; } || return 1
  local x y w h; read -r x y w h _ <<< "$(geometry)"
  local cx=${xy%,*} cy=${xy#*,} iw=${sz%x*} ih=${sz#*x}
  $A click --id "$WS" $((x + cx + (w - iw) / 2)) $((y + h - (ih - cy))) > /dev/null 2>&1
}
panel_is() { grep -a '^PROBE UI ' "$D/shell.out" | tail -1 | grep -q " side=$1 "; }
theme_is() { grep -q "\"dark\":$1" "$D/shell/shell.json"; }
# The theme button of the rail, until the page has the theme asked for (each click is given time to arrive).
set_theme() {
  local want=$1 x y w h
  for _ in 1 2 3 4; do
    theme_is "$want" && return 0
    read -r x y w h _ <<< "$(geometry)"
    $A click --id "$WS" $((x + 288)) $((y + h - 28)) > /dev/null 2>&1
    wait_for 3 "theme_is $want" || true
  done
  theme_is "$want"
}
shown_here() { where "$1" | grep -q '[0-9]'; }

# Notifications that are still up from before count toward the app's "more than three sessions alert together": the walk
# starts with none (all read, so the daemon takes them down).
api /api/alerts/read '{}' POST > /dev/null 2>&1 || true
up_now() { gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method test.Notifications.Shown 2> /dev/null; }
wait_for 20 'up_now | grep -q "\[\]"' || echo "# note: notifications from before were still up at the start of the walk"

# Sessions in the states the rail has a dot for: at work (a plan, two agents, files changed, a command that names a file), asking, done.
busy=$(mk_session "Walk: release notes" "$walk_ws")
api "/api/sessions/$busy/permissions" '{"mode":"full-auto","sandbox":"off"}' PUT > /dev/null
api "/api/sessions/$busy/messages" "$(calls_of '[{"name":"TodoWrite","input":{"todos":[{"content":"Read the notes","activeForm":"Reading the notes","status":"completed"},{"content":"Check the changelog","activeForm":"Checking the changelog","status":"in_progress"},{"content":"Write the summary","activeForm":"Writing the summary","status":"pending"}]}},{"name":"Bash","input":{"command":"echo more >> src/a.ts; echo new > src/b.ts"}}]')" POST > /dev/null
wait_for 60 "[ \"\$(rested $busy)\" = 1 ]"
slow='[{"name":"Bash","input":{"command":"sleep 200"}}]'
api "/api/sessions/$busy/messages" "$(py 'import json,sys
slow = lambda t: {"name": "spawn_agent", "input": {"message": t + "\nscript:calls " + sys.argv[1], "isolation": "none"}}
print(json.dumps({"text": "script:batch " + json.dumps([slow("Reader"), slow("Checker")])}))' "$slow")" POST > /dev/null
wait_for 60 "[ \"\$(rested $busy)\" = 1 ]"
api "/api/sessions/$busy/messages" "$(calls_of '[{"name":"Bash","input":{"command":"sleep 200","description":"Editing src/a.ts"}}]')" POST > /dev/null
asker=$(mk_session "Walk: asks first" "$walk_ws")
api "/api/sessions/$asker/permissions" '{"mode":"ask","sandbox":"off"}' PUT > /dev/null
api "/api/sessions/$asker/messages" "$(calls_of "[{\"name\":\"Bash\",\"input\":{\"command\":\"touch $D/walk-asked\"}}]")" POST > /dev/null
doner=$(api /api/sessions "{\"model\":\"scripted:stand-in\",\"title\":\"Walk: finished\",\"text\":\"One line.\",\"workspace\":\"$walk_ws\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
mark=$(lines)
"$SHELL_BIN" "keel://session/$busy" 2> /dev/null
check "the session at work shows both lines over its message box" "wait_for 40 \"since $mark | grep -a '^PROBE UI ' | tail -1 | grep -q ' now=true'\" && wait_for 40 'shown_here dock-agents && shown_here dock-changes-open'"
# --- the rail's dots: the dot at work is drawn, and its glow runs (the page's own animation)
check "the rail's working dot breathes: its glow's animation runs in the app's page" "wait_for 20 \"grep -a '^PROBE UI ' '$D/shell.out' | tail -1 | grep -Eq ' work=[1-9][0-9]* breathing=[1-9]'\""

set_theme false || echo "# note: the page's theme could not be set to light for the walk"
sleep 2; shot w1-light-session-at-work

# --- the two lines: the changes, the folder and the agents lead to their places
press_at dock-changes-open
check "the changes in the second line open the Changes panel" "wait_for 10 'panel_is changes'"
sleep 1; shot w2-light-changes-panel
press_at dock-folder
check "the folder in the second line opens the Files panel" "wait_for 10 'panel_is files'"
press_at dock-agents
check "the agents in the first line open their list" "wait_for 10 \"grep -a '^PROBE UI ' '$D/shell.out' | tail -1 | grep -q ' agents=true'\""
sleep 1; shot w3-light-agents-list
blank_click

# --- the microphone: given once at the owner's press and no other time (this desktop has no device, so a request the app
# allowed ends in "no microphone found", one it refused in "not allowed")
read -r X Y W H _ <<< "$(geometry)"
blank_click
$A key --id "$WS" F12 > /dev/null 2>&1
check "the microphone is refused when the page did not say, at the owner's press, that it asks" "wait_for 10 \"grep -aq '^PROBE MIC unsaid NotAllowedError' '$D/shell.out'\""
blank_click
$A key --id "$WS" F11 > /dev/null 2>&1
check "the microphone is given to the page that said it, at the owner's press (it ends in no device, not in a refusal)" "wait_for 10 \"grep -aqE '^PROBE MIC said (NotFoundError|granted)' '$D/shell.out'\""

# --- the helper's face on its notifications
notes_shown() { grep -c '^NOTIFY ' "$D/notify-host.out" || true; }
last_note() { grep '^NOTIFY ' "$D/notify-host.out" | tail -1; }
helper=$(api /api/helper '{"on":true}' PUT 2> /dev/null | py 'import json,sys; print(json.load(sys.stdin).get("session_id") or "")' 2> /dev/null || true)
png "$D/face.png"
curl -sS -m 10 -X POST -H 'content-type: image/png' --data-binary "@$D/face.png" "$URL/api/helper/avatar" > "$D/avatar.out" 2>&1 || true
if [ -n "$helper" ]; then
  api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$helper\"}" POST > /dev/null
  check "the helper's own alert is shown by the app with the helper's face as its icon" "wait_for 15 'last_note | grep -q avatar'"
  hid=$(last_note | py 'import json,sys; print(json.loads(sys.stdin.read()[7:])["id"])')
  gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method test.Notifications.Click "$hid" > /dev/null 2>&1
  check "its click opens the helper's conversation" "wait_for 15 \"last present | grep -q '/s/$helper'\""
else
  fail "the helper did not start for the walk"
fi
shown_before=$(notes_shown)
api /api/alerts/test "{\"kind\":\"failed\",\"session_id\":\"$doner\"}" POST > /dev/null
check "another session's alert carries no helper's face, the app's own icon" "wait_for 15 '[ \"\$(notes_shown)\" -gt $shown_before ]' && last_note | grep -q '\"icon\":\"$ID\"'"
api /api/helper '{"on":false}' PUT > /dev/null 2>&1 || true
curl -fsS -m 10 -X DELETE "$URL/api/helper/avatar" > /dev/null 2>&1 || true

# --- a click on the notification of a request opens the session that asks, at that request
aid=$(grep '^NOTIFY ' "$D/notify-host.out" | grep 'Approval: Walk: asks first' | head -1 | py 'import json,sys; print(json.loads(sys.stdin.read()[7:])["id"])')
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method test.Notifications.Click "$aid" > /dev/null 2>&1
check "a click on the notification of a request opens the session that asks, at its request" "wait_for 15 \"last present | grep -q '/s/$asker?approval='\""

# --- the tray's list, with the sessions in their states
walk_lines() { menu | grep -o "'label': <'[^']*'>" | sed "s/^'label': <'//; s/'>\$//" | grep -F ' · ' || true; }
# (The list holds five: the ones that need the owner first, so the one at work may not be among them when others wait.)
check "the tray lists the session that asks with its state word" "wait_for 20 \"walk_lines | grep -q '^Walk: asks first · Needs you\$'\""

# --- the dark theme, the same session
set_theme true || echo "# note: the page's theme could not be set to dark for the walk"
press_at dock-changes-open; sleep 2; shot w1-dark-changes-panel
press_at dock-agents; sleep 1; shot w2-dark-agents-list
blank_click

# (The panel is left open; the cases after it close theirs by the page's own command.)
# What the walk started is stopped: the cases after it count the sessions at work.
for s in $busy $asker; do api "/api/sessions/$s/interrupt" '{"by":"owner"}' POST > /dev/null 2>&1 || true; done
for a in $(api "/api/sessions/$asker/approvals" 2> /dev/null | py 'import json,sys; print(*[x["id"] for x in json.load(sys.stdin).get("approvals", [])])' 2> /dev/null); do api "/api/sessions/$asker/approvals/$a" '{"choice":"deny"}' POST > /dev/null 2>&1 || true; done
