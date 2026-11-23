# Part of e2e.sh (it is read there, with the app up on the scratch daemon: the main window and
# a session's own): the cases the review of the Qt engine asked for. The first is for both
# engines; the rest are the Qt engine's and are skipped with the system web view.

# every process under one (the engine starts its pages' processes from a helper of its own)
under() { local p; for p in $(pgrep -P "$1" 2> /dev/null); do echo "$p"; under "$p"; done; }
# the pages' own processes
renderers() { local p; for p in $(under "$(win_pid)"); do tr '\0' ' ' < "/proc/$p/cmdline" 2> /dev/null | grep -q -- '--type=renderer\|WebKitWebProcess' && echo "$p"; done; }
# --- two windows whose pages' processes end at the same moment both come back as the app's
# (The engine left one of two such pages without the app's script in it, every time, when the
# page was only loaded again: drawn and working, and cut off from the app.)
if [ "$ENGINE" = qt ] && [ "$(windows)" = 2 ]; then
  mark=$(lines); stops=$(logged page-stopped)
  for p in $(renderers); do sig -KILL "$p"; done
  wait_for 15 "[ \"\$(logged page-stopped)\" -ge $((stops + 2)) ]" || true
  back() { since "$mark" | grep -a '^PROBE AT ' | grep ' shell=object ' | grep ' note=true' | grep -c " win=$1 " || true; }
  if wait_for 30 '[ "$(back main)" -gt 0 ] && [ "$(back session)" -gt 0 ]'; then ok "two windows whose pages' processes ended together both come back as the app's, each with its word"; else fail "of two windows whose pages' processes ended together, not both came back as the app's (main said $(back main) lines, the session's $(back session))"; fi
  # (The word is read and put away in the main window: it would lie over what the next cases press.)
  sleep 1
elif [ "$ENGINE" = qt ]; then
  fail "the session's own window is not there for the case of two pages"
fi

# The session's own window of the section before is closed, as the owner closes one: a press on
# its close button. What follows is typed into the main one.
$A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys
ws=sorted(json.load(sys.stdin).get("windows", []), key=lambda w: -w["geometry"]["width"]*w["geometry"]["height"])
for w in ws[1:]: print(w["id"], w["geometry"]["x"], w["geometry"]["y"], w["geometry"]["width"])' > "$D/others.txt"
while read -r oid ox oy ow; do
  $A focus-window --id "$WS" "$oid" > /dev/null 2>&1; sleep 0.5
  shut "$ox" "$oy" "$ow"; sleep 1
done < "$D/others.txt"
wait_for 10 '[ "$(windows)" = 1 ]' || echo "# note: the session's own window did not close; the cases below run with $(windows) windows"

# --- a. a content frame asks for the keyboard as fast as it can while the owner types: every
# character is the message box's, in an artifact's frame and in the preview's; and the owner's
# own press into the frame still gives it the keyboard.
typed=$(printf 'k%.0s' $(seq 1 41))
# What was typed has arrived when the page's count of it stands still (keys are sent one at a
# time, and a busy desktop delivers them slowly).
arrived() { local was=-1 now; for _ in $(seq 1 40); do now=$(said "LOOP at=$1" | sed -n 's/.* box=\([0-9-]*\) frameChars=\([0-9]*\) .*/\1+\2/p'); [ -n "$now" ] && [ "$now" = "$was" ] && return 0; was=$now; sleep 1.2; done; return 0; }
for kind in artifact preview; do
  loop=$(api /api/sessions "{\"model\":\"scripted:stand-in\",\"title\":\"Desktop: a frame that takes the keyboard ($kind)\"}" POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
  "$SHELL_BIN" "keel://session/$loop"
  if wait_for 20 "said 'LOOP shown kind=$kind' | grep -q shown"; then
    sleep 2
    # The window that shows the loop's session, found by its process and its title, and in
    # front: what is typed next must be typed into it and no other window of the app.
    aim=$($A windows --id "$WS" --pid "$(win_pid)" 2> /dev/null | py 'import json,sys
ws=[w for w in json.load(sys.stdin).get("windows", []) if sys.argv[1] in (w.get("title") or "")]
w=max(ws, key=lambda w: w["geometry"]["width"]*w["geometry"]["height"]) if ws else None
print(*([w["id"]] + [w["geometry"][k] for k in ("x","y","width","height")]) if w else "")' "takes the keyboard ($kind)")
    read -r WID X Y W H <<< "$aim"
    if [ -z "${WID:-}" ]; then fail "no window of the app shows the loop's session ($kind)"; continue; fi
    $A focus-window --id "$WS" "$WID" > /dev/null 2>&1
    wait_for 5 "$A active-window --id '$WS' 2> /dev/null | grep -q 'takes the keyboard ($kind)'" || { fail "the window of the loop's session ($kind) is not in front"; continue; }
    kept_before=$(ls "$D/apphome/Downloads" 2> /dev/null | wc -l)
    # the message box, at the foot of the pane beside the list (pressed twice: the first press
    # of a window that was behind another may only bring it forward)
    $A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 0.7
    $A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 1
    $A type --id "$WS" "$typed" > /dev/null 2>&1; arrived "$loop"
    # (The preview's frame offered files all the while, to a page the owner was typing in.)
    if [ "$kind" = preview ]; then
      if said "LOOP at=$loop" | grep -q ' offered=[1-9]' && [ "$(ls "$D/apphome/Downloads" 2> /dev/null | wc -l)" = "$kept_before" ]; then ok "a frame that may keep files kept none while the owner typed in the page ($(said "LOOP at=$loop" | sed -n 's/.* offered=\([0-9]*\) .*/\1/p') offered)"; else fail "a frame kept a file while the owner typed, or offered none: $(said "LOOP at=$loop" | cut -c1-120); $(ls "$D/apphome/Downloads" | tr '\n' ' ')"; fi
    fi
    got=$(said "LOOP at=$loop")
    if echo "$got" | grep -q " box=41 frameChars=0 "; then ok "a frame ($kind) that asks for the keyboard in a loop gets none of 41 characters typed into the message box"; else fail "a frame ($kind) that asks for the keyboard in a loop took what was typed: $got"; fi
    # the owner's own press in the frame, then three keys
    $A click --id "$WS" $((X + W - 176)) $((Y + H - 288)) > /dev/null 2>&1; sleep 1
    $A type --id "$WS" "abc" > /dev/null 2>&1; arrived "$loop"
    got=$(said "LOOP at=$loop")
    if echo "$got" | grep -q " frameChars=3 "; then ok "the owner's own press into the frame ($kind) gives it the keyboard"; else fail "the owner's own press into the frame ($kind) did not give it the keyboard: $got"; fi
    # And their paste, keyed while they are in the frame, lands there (the Qt engine's paste
    # keys are the app's first: it hands such a paste back to the engine).
    in_frame=3
    if [ -n "$SECRET" ]; then
      (wl-copy "into-the-frame" > /dev/null 2>&1 &)
      sleep 1
      $A key --id "$WS" ctrl+v > /dev/null 2>&1
      arrived "$loop"
      got=$(said "LOOP at=$loop")
      in_frame=$(echo "$got" | sed -n 's/.* frameChars=\([0-9]*\) .*/\1/p')
      if [ "$in_frame" = 17 ]; then ok "the owner's paste into the frame ($kind) they are in lands there"; else fail "the owner's paste into the frame ($kind) they are in did not land there: $got"; fi
    fi
    # The owner goes back to the message box. A frame they pressed in a moment ago may be given the
    # focus it asks for (Chromium counts their press for a while): the page gives the keyboard
    # back and stops the frame at once, and what is typed then is the message box's.
    $A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 1.5
    $A type --id "$WS" "$typed" > /dev/null 2>&1; arrived "$loop"
    got=$(said "LOOP at=$loop")
    # (A key that falls in the instant the frame takes the keyboard, before the page has it back,
    # can be lost to both: the frame gets none, and the box is allowed to miss three of the 41.)
    box=$(echo "$got" | sed -n 's/.* box=\([0-9]*\) .*/\1/p')
    if echo "$got" | grep -q " frameChars=$in_frame " && [ "${box:-0}" -ge 79 ]; then ok "back in the message box after that press, the frame ($kind) gets none of 41 more characters ($((${box:-0} - 41)) of them in the box)"; else fail "back in the message box after the owner's press in the frame ($kind), the frame took what was typed: $got"; fi
  else
    fail "the frame of the loop case ($kind) was not shown"
  fi
done

if [ "$ENGINE" != qt ]; then return 0; fi

# --- b. the pipe to the app is the drawing program's alone: no process it starts holds it
pipes() { for f in "/proc/$1/fd"/*; do readlink "$f" 2> /dev/null; done | grep '^pipe:' | sort -u; }
# the pipes the app and the drawing program share are the ones they speak over
shared=$(comm -12 <(pipes "$(app_pid)") <(pipes "$(win_pid)"))
leaks=0; seen=0
for p in $(under "$(win_pid)"); do
  seen=$((seen + 1))
  [ "$(readlink "/proc/$p/fd/1" 2> /dev/null)" = /dev/null ] || leaks=$((leaks + 1))
  [ -z "$(comm -12 <(pipes "$p") <(echo "$shared"))" ] || leaks=$((leaks + 1))
done
if [ "$seen" -gt 0 ] && [ -n "$shared" ] && [ "$leaks" = 0 ]; then ok "no process the drawing program started holds the pipe to the app ($seen looked at)"; else fail "$leaks of the drawing program's $seen processes hold the pipe to the app"; fi

# --- c. the environment asked for the engine's debugging port and for no sandbox: neither was taken
if ! listening "$DEBUG_PORT" && ! tr '\0' ' ' < "/proc/$(renderers | head -1)/cmdline" 2> /dev/null | grep -q -- '--no-sandbox' && grep -aq 'not taken from the environment' "$D/shell.out"; then
  ok "the engine's debugging port is not open and its sandbox is on, whatever the environment asked, and that was said"
else
  fail "the environment opened the engine's debugging port or took its sandbox off"
fi

# --- d. calls between browsers find no address of this machine, and the engine's own files are no frame's to load
if said 'RTC ' | grep -q 'RTC candidates=0\|RTC none'; then ok "a call between browsers finds no address here ($(said 'RTC ' | cut -c7-))"; else fail "a call between browsers found addresses: $(said 'RTC ')"; fi
if grep -aq '^PROBE ARTIFACT ENGINE-FILE refused' "$D/shell.out" && ! grep -aq '^PROBE ARTIFACT ENGINE-FILE loaded' "$D/shell.out"; then ok "a frame cannot load the engine's own files"; else fail "a frame loaded the engine's own files"; fi

# --- e. the drawing program stops under the app: the window comes back where it was, with what was typed a moment before
stay=$(api /api/sessions '{"model":"scripted:stand-in","title":"Desktop: where the window was"}' POST | py 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')
"$SHELL_BIN" "keel://session/$stay"
wait_for 15 "said 'AT ' | grep -q '/s/$stay '" || true
sleep 2
read -r X Y W H _ <<< "$(geometry)"
$A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 1
$A type --id "$WS" "typed a moment before the stop" > /dev/null 2>&1
sleep 1.5
drew=$(win_pid); mark=$(lines)
sig -KILL "$drew"
if wait_for 30 "[ \"\$(win_pid)\" != $drew ] && [ \"\$(win_pid)\" != \"\$(app_pid)\" ] && since $mark | grep -aq '^PROBE AT $URL/s/$stay '"; then ok "after the drawing program was killed the window is back on the session it showed"; else fail "after the drawing program was killed the window is not back where it was: $(said 'AT ' | cut -c1-90)"; fi
if wait_for 15 "since $mark | grep -a '^PROBE AT $URL/s/$stay ' | tail -1 | grep -q ' draft=30 '"; then ok "and what was typed a moment before the stop is in the message box"; else fail "what was typed a moment before the stop is gone: $(said 'AT ' | sed 's/.*active/active/')"; fi
# (The draft is taken out again: the box is the next section's.)
$A key --id "$WS" ctrl+a > /dev/null 2>&1; $A key --id "$WS" BackSpace > /dev/null 2>&1; sleep 1

# --- f. the desktop's word on a screen reader flips ten times in a row: the app goes on answering
flip() { gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set org.a11y.Status ScreenReaderEnabled "<$1>" > /dev/null 2>&1; }
# A second launch, timed: the best of three, in ms (it hands its words to the running app and
# ends; one the app does not answer is ended after ten seconds and counts as 99999).
launch_ms() {
  local best=99999 t0 t1 ms rc
  for _ in 1 2 3; do
    t0=$(date +%s%N); timeout 10 "$SHELL_BIN" keel://new; rc=$?; t1=$(date +%s%N)
    ms=$(( (t1 - t0) / 1000000 )); [ "$rc" = 0 ] && [ "$ms" -lt "$best" ] && best=$ms
    sleep 0.5
  done
  echo "$best"
}
if flip true; then
  # How long a second launch takes on this machine now, before anything is flipped: what it
  # takes after is held against this, not against a number. (A launch is a process that starts,
  # speaks to the app and ends: under load, or with the windows drawn in software, it alone takes
  # the hundred ms the case once allowed. The fault the case is for is an app that never answers.)
  before=$(launch_ms)
  flips=$(logged screen-reader)
  # (Each flip is given the time to be seen: the app starts the drawing program again for each.)
  turned() { local was; was=$(logged screen-reader); flip "$1"; wait_for 8 "[ \"\$(logged screen-reader)\" -gt $was ]" || true; }
  turned false; for _ in 1 2 3 4 5; do turned true; turned false; done
  # (Each flip the app saw started the drawing program again: they are done when their count stands.)
  seen=-1
  for _ in $(seq 1 15); do [ "$seen" = "$(logged screen-reader)" ] && break; seen=$(logged screen-reader); sleep 4; done
  after=$(launch_ms)
  allowed=$(( before * 3 > 100 ? before * 3 : 100 ))
  echo "# a second launch answered in $before ms before the flips and in $after ms after them ($(( $(logged screen-reader) - flips )) restarts of the drawing program); allowed: $allowed ms"
  if [ "$after" -le "$allowed" ] && [ "$(( $(logged screen-reader) - flips ))" -ge 10 ] && [ "$(app_pids | wc -l)" = 1 ] && [ "$(win_pid)" != "$(app_pid)" ]; then ok "after ten flips of the screen reader's word the app answers a second launch as fast as before them, and its windows are drawn"; else fail "after ten flips of the screen reader's word a second launch took $after ms (before them $before ms, allowed $allowed), or the app or its drawing program is gone"; fi
  wait_for 20 "[ \"\$(windows)\" -ge 1 ]" || true
else
  fail "the screen reader's word could not be set on the workspace's bus"
fi

# --- g. a page whose own process ends is loaded again and says so; one that keeps ending is left
# (One window, one page: of two pages whose processes end at the same moment one often comes
# back without the app's script in it, which the README names as known and not fixed.)
for round in 1 2 3 4; do
  stops=$(logged page-stopped); mark=$(lines)
  for p in $(renderers); do sig -KILL "$p"; done
  wait_for 15 "[ \"\$(logged page-stopped)\" -gt $stops ]" || true
  if [ "$round" = 1 ]; then
    if last page-stopped | grep -q '"again":true' && wait_for 20 "since $mark | grep -a '^PROBE AT ' | grep -q ' note=true'"; then ok "a page whose process ended is loaded again, and says once that it was"; else fail "a page whose process ended was not loaded again with a word: $(last page-stopped)"; fi
  fi
  sleep 4
done
if grep '"what":"page-stopped"' "$D/shell.jsonl" | tail -4 | grep -q '"again":false'; then ok "a page that ended four times in a minute is left, not loaded again without end"; else fail "a page that kept ending was loaded again every time: $(grep -c '"again":true' "$D/shell.jsonl") reloads"; fi
[ "$(app_pids | wc -l)" = 1 ] || fail "the app did not outlive its pages' processes"

# --- h. a Qt that cannot start, and one that stops before it drew anything: the app draws its windows itself
fallback() { # name, then the environment of that launch
  local name=$1; shift
  rm -rf "$D/fallback-$name"; mkdir -p "$D/fallback-$name"
  (unset KEEL_DESKTOP_PROBE; export KEEL_DESKTOP_INSTANCE="Fallback$name" KEEL_DESKTOP_DIR="$D/fallback-$name" KEEL_DESKTOP_LOG="$D/fallback-$name.jsonl" "$@"; rm -f "$D/fallback-$name.jsonl"; HOME="$D/apphome" setsid nohup "$SHELL_BIN" >> "$D/fallback-$name.out" 2>&1 < /dev/null &)
  local pid=""
  wait_for 25 "grep -q '\"name\":\"webkit\"' '$D/fallback-$name.jsonl' && grep -q '\"what\":\"load\"' '$D/fallback-$name.jsonl'" || true
  for p in $(pgrep -x keel-desktop); do tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -qx "KEEL_DESKTOP_DIR=$D/fallback-$name" && pid=$p; done
  local n=0
  for _ in $(seq 1 40); do
    n=$($A windows --id "$WS" --pid "${pid:-0}" 2> /dev/null | py 'import json,sys; print(len(json.load(sys.stdin).get("windows", [])))')
    [ "$n" = 1 ] && break; sleep 0.25
  done
  (export KEEL_DESKTOP_INSTANCE="Fallback$name" KEEL_DESKTOP_DIR="$D/fallback-$name"; timeout 10 "$SHELL_BIN" --quit > /dev/null 2>&1)
  # (Only a process this launch made is ended: with no pid there is nothing to end.)
  if [ -n "$pid" ]; then wait_for 10 "! kill -0 $pid 2> /dev/null" || sig -TERM "$pid"; fi
  [ -n "$pid" ] && [ "$n" = 1 ] && grep -q '"name":"webkit"' "$D/fallback-$name.jsonl" && grep -q '"what":"load"' "$D/fallback-$name.jsonl"
}
if fallback NoDisplay QT_QPA_PLATFORM=nonexistent; then ok "a Qt that cannot start leaves the app to draw its window itself"; else fail "a Qt that cannot start left no window ($(grep -o '"what":"[a-z-]*"' "$D/fallback-NoDisplay.jsonl" 2> /dev/null | sort | uniq -c | tr '\n' ' '))"; fi
# And one that drew, and then stops soon after each start: the second time the app draws its windows itself.
rm -rf "$D/fallback-Twice"; mkdir -p "$D/fallback-Twice"
(unset KEEL_DESKTOP_PROBE; export KEEL_DESKTOP_INSTANCE="FallbackTwice" KEEL_DESKTOP_DIR="$D/fallback-Twice" KEEL_DESKTOP_LOG="$D/fallback-Twice.jsonl"; rm -f "$D/fallback-Twice.jsonl"; HOME="$D/apphome" setsid nohup "$SHELL_BIN" >> "$D/fallback-Twice.out" 2>&1 < /dev/null &)
wait_for 25 "grep -q '\"what\":\"load\"' '$D/fallback-Twice.jsonl'" || true
twice=""; for p in $(pgrep -x keel-desktop); do tr '\0' '\n' < "/proc/$p/environ" 2> /dev/null | grep -qx "KEEL_DESKTOP_DIR=$D/fallback-Twice" && twice=$p; done
if [ -n "$twice" ]; then
  for _ in 1 2 3; do
    grep -q '"name":"webkit"' "$D/fallback-Twice.jsonl" && break
    drew=$(pgrep -x keel-desktop-qt -P "$twice" 2> /dev/null | tail -1)
    [ -n "$drew" ] && sig -KILL "$drew"
    wait_for 12 "grep -q '\"name\":\"webkit\"' '$D/fallback-Twice.jsonl' || { q=\$(pgrep -x keel-desktop-qt -P $twice | tail -1); [ -n \"\$q\" ] && [ \"\$q\" != \"${drew:-0}\" ]; }" || true
    sleep 1
  done
  has=0; for _ in $(seq 1 60); do
    has=$($A windows --id "$WS" --pid "$twice" 2> /dev/null | py 'import json,sys; print(len(json.load(sys.stdin).get("windows", [])))'); [ "$has" = 1 ] && break; sleep 0.25
  done
  if grep -q '"after":"qt"' "$D/fallback-Twice.jsonl" && [ "$has" = 1 ] && kill -0 "$twice" 2> /dev/null; then ok "a drawing program that stops soon after each start is given up on the second time, and the app draws its window itself"; else fail "a drawing program that kept stopping left the app with $has windows ($(grep -o '"what":"[a-z-]*"' "$D/fallback-Twice.jsonl" | sort | uniq -c | tr '\n' ' '))"; fi
  (export KEEL_DESKTOP_INSTANCE="FallbackTwice" KEEL_DESKTOP_DIR="$D/fallback-Twice"; timeout 10 "$SHELL_BIN" --quit > /dev/null 2>&1)
  wait_for 10 "! kill -0 $twice 2> /dev/null" || sig -TERM "$twice"
else
  fail "the app of the quick-stop case did not start"
fi
printf '#!/usr/bin/env bash\n# Stands in for the drawing program: it says it runs, and stops before it drew anything.\nprintf \x27{"t":"ready"}\\n\x27\nsleep 1\n' > "$D/stops-early.sh"; chmod +x "$D/stops-early.sh"
if fallback StopsEarly KEEL_DESKTOP_QT="$D/stops-early.sh" && grep -q '"after":"qt"' "$D/fallback-StopsEarly.jsonl"; then ok "a drawing program that stops before it drew anything is given up on, and the app draws its window itself"; else fail "a drawing program that stopped before it drew left no window ($(grep -o '"what":"[a-z-]*"' "$D/fallback-StopsEarly.jsonl" 2> /dev/null | sort | uniq -c | tr '\n' ' '))"; fi
