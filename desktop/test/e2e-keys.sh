# Part of e2e.sh (it is read there, with the app up on the scratch daemon): the keys the desktop
# itself gives the app. The desktop's side is the check's stand-in for the portal
# (portal-host.js), which proves the app's part of that conversation and no desktop's own.
(eval "$ENVSH"; "$SHELL_BIN" --quit > /dev/null 2>&1); wait_for 10 '[ "$(app_pids | wc -l)" = 0 ]'
rm -rf "$D/portal"; mkdir -p "$D/portal"
( gjs -m "$HERE/portal-host.js" "$D/portal" > "$D/portal-host.out" 2>&1 & echo $! > "$D/host-portal.pid" )
wait_for 10 "grep -q READY '$D/portal-host.out'" || fail "the stand-in portal did not start"
portal() { grep -c "^$1" "$D/portal-host.out" 2> /dev/null || true; }
press() { gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method io.github.agent_sh.Keel.Check.Press "$1" "" > /dev/null 2>&1; }
# the app on a session's page, so that "a new session" is a change to see
on_session() { "$SHELL_BIN" "keel://session/$other" 2> /dev/null; wait_for 15 "said 'AT ' | grep -q \"AT $URL/s/$other \""; }
relaunch() { (eval "$ENVSH"; "$SHELL_BIN" --quit > /dev/null 2>&1); wait_for 10 '[ "$(app_pids | wc -l)" = 0 ]'; mark=$(lines); launch; wait_for 30 '[ "$(windows)" = 1 ]'; wait_for 20 "since $mark | grep -aq '^PROBE AT .* shell=object'"; }

# --- a. a desktop that has global shortcuts: the app offers them and asks for nothing unasked
relaunch
check "the app finds the desktop's global shortcuts, and tells its page" "wait_for 10 \"last shortcuts-known | grep -q Offer\" && wait_for 10 \"said 'AT ' | grep -q ' keys=true'\""
# (The check's script in the page asks for the dialog by itself a moment after every load.)
check "it asks the desktop for none before the owner does, though its page asks by itself" "wait_for 15 \"since $mark | grep -aq '^PROBE ASKED-KEYS'\" && sleep 2 && [ \"\$(portal BIND)\" = 0 ] && menu | grep -q 'Set Global Shortcuts'"

# --- b. the owner asks from the tray: the desktop's dialog, a yes, and the app holds two shortcuts
pick 13
check "the tray's item asks the desktop, which shows its dialog once" "wait_for 10 \"grep -q '^BIND dialog yes summon=Ctrl+Alt+K new-session=Ctrl+Alt+N' '$D/portal-host.out'\""
check "the app holds them, remembers the yes, and its menu now offers to change them" "wait_for 10 \"last shortcuts | grep -q '\\\"held\\\":true' && last shortcuts | grep -q 'summon=Ctrl+Alt+K'\" && grep -q '\"shortcuts\":true' '$D/shell/shell.json' && wait_for 10 \"menu | grep -q 'Change Global Shortcuts'\" && ! menu | grep -q 'Set Global Shortcuts'"
# The connection that asked is one of the app's own for the portal (not the one the toolkit
# shares, which may have spoken to the portal before), and the app's name was its first word on it.
asker=$(grep -m1 '^CREATE' "$D/portal-host.out" | awk '{print $3}')
owner=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetNameOwner "$BUS" 2> /dev/null | tr -d "(',)")
check "it names itself to the portal first, on a connection of its own for it" "[ -n \"$asker\" ] && [ -n \"$owner\" ] && [ \"$asker\" != \"$owner\" ] && [ \"\$(grep -n \"^REGISTER $BUS $asker\\$\" '$D/portal-host.out' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n '^CREATE' '$D/portal-host.out' | head -1 | cut -d: -f1)\" ]"

# --- c. the shortcut for a new session, pressed while the window shows a session
on_session; mark=$(lines)
press new-session
check "the new-session shortcut shows the new session's page, in the same window" "wait_for 10 \"since $mark | grep -aq '^PROBE AT $URL/ '\" && last shortcut | grep -q '\"id\":\"new-session\"' && [ \"\$(windows)\" = 1 ]"

# --- d. the shortcut that shows Keel, pressed while its window is hidden
read -r X Y W H _ <<< "$(geometry)"
hid=$(logged hidden); loads=$(logged load)
shut "$X" "$Y" "$W"
wait_for 10 "[ \"\$(logged hidden)\" -gt $hid ] && [ \"\$(windows)\" = 0 ]" || fail "the window did not hide for the shortcut's case"
press summon
check "the show shortcut brings the hidden window back, and loads nothing again" "wait_for 10 '[ \"\$(windows)\" = 1 ]' && last shortcut | grep -q '\"id\":\"summon\"' && [ \"\$(logged load)\" = \"$loads\" ]"
press quit
check "a shortcut the app never asked for does nothing" "sleep 1; last shortcut | grep -q '\"id\":\"summon\"' && [ \"\$(app_pids | wc -l)\" = 1 ]"

# --- e. the owner asks again: the desktop shows the shortcuts to be changed, and no second bind
binds=$(portal BIND)
pick 14
check "asked again, the desktop shows the app's shortcuts to be changed" "wait_for 10 \"grep -q '^CONFIGURE held' '$D/portal-host.out'\" && [ \"\$(portal BIND)\" = \"$binds\" ]"

# --- f. the tray's mark: the middle button starts a session; and the app's own key for one
on_session; mark=$(lines)
gdbus call --session --dest "$BUS" --object-path /StatusNotifierItem --method org.kde.StatusNotifierItem.SecondaryActivate 0 0 > /dev/null 2>&1
check "the middle button on the tray's mark starts a session" "wait_for 10 \"since $mark | grep -aq '^PROBE AT $URL/ '\""
on_session; mark=$(lines)
read -r X Y W H _ <<< "$(geometry)"
$A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" ctrl+n > /dev/null 2>&1
check "Ctrl+N in the window starts a session, from the message box too" "wait_for 10 \"since $mark | grep -aq '^PROBE AT $URL/ '\""

# --- f2. Find: the find key opens the page's own bar over a conversation (the web view has no Find
# of its own), from the message box too; and the app's Find of the page on its other pages.
on_session; mark=$(lines)
read -r X Y W H _ <<< "$(geometry)"
$A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" ctrl+f > /dev/null 2>&1; sleep 0.5
$A type --id "$WS" "one line" > /dev/null 2>&1
check "Ctrl+F over a conversation opens its own Find, which counts what the conversation holds" "wait_for 10 \"since $mark | grep -aq '^PROBE AT $URL/s/$other .* find=conversation:[0-9]*_of_[0-9]'\""
$A key --id "$WS" Escape > /dev/null 2>&1
check "Escape closes it and gives the keyboard back to the message box" "wait_for 10 \"said 'AT ' | grep -q ' active=composer .* find=-'\""
"$SHELL_BIN" "keel://settings/general" 2> /dev/null; wait_for 15 "said 'AT ' | grep -q \"AT $URL/settings\""; mark=$(lines)
$A key --id "$WS" ctrl+f > /dev/null 2>&1; sleep 0.5
$A type --id "$WS" "general" > /dev/null 2>&1
check "on a page that is no conversation the app's Find of the page opens and counts its words" "wait_for 10 \"since $mark | grep -aq '^PROBE AT .* find=page:[0-9]*_of_[0-9]'\""
$A key --id "$WS" Escape > /dev/null 2>&1
check "and closes on Escape" "wait_for 10 \"said 'AT ' | grep -q ' find=-'\""

# --- g. the next start asks again by itself, and the desktop answers with no dialog
binds=$(portal 'BIND silent')
relaunch
check "a start after the owner's yes holds the shortcuts again, with no dialog" "wait_for 10 \"[ \\\"\\\$(portal 'BIND silent')\\\" -gt $binds ]\" && wait_for 10 \"last shortcuts | grep -q '\\\"held\\\":true'\" && [ \"\$(portal 'BIND dialog')\" = 1 ]"

# --- g2. a desktop that could not do it is not the owner's no: what is remembered stands
rm -f "$D/portal/granted"; echo fail > "$D/portal/answer"
relaunch
check "a desktop that fails to bind changes nothing of what the owner said" "wait_for 10 \"grep -q '^BIND dialog fail' '$D/portal-host.out'\" && wait_for 10 \"last shortcuts | grep -q '\\\"failed\\\":true'\" && grep -q '\"shortcuts\":true' '$D/shell/shell.json'"

# --- h. the owner says no in the desktop's dialog: the app stops asking
rm -f "$D/portal/granted"; echo no > "$D/portal/answer"
relaunch
check "a no in the desktop's dialog is remembered: the app holds none and offers them again" "wait_for 10 \"grep -q '^BIND dialog no' '$D/portal-host.out'\" && wait_for 10 \"last shortcuts | grep -q '\\\"held\\\":false'\" && grep -q '\"shortcuts\":false' '$D/shell/shell.json' && wait_for 10 \"menu | grep -q 'Set Global Shortcuts'\""
binds=$(portal BIND)
relaunch
check "and the start after it asks the desktop for nothing, though its page asks by itself" "wait_for 15 \"since $mark | grep -aq '^PROBE ASKED-KEYS'\" && sleep 3 && [ \"\$(portal BIND)\" = \"$binds\" ]"
# The page's own command, at the owner's keys: the desktop is asked (and says no again).
read -r X Y W H _ <<< "$(geometry)"
$A click --id "$WS" $((X + 320 + (W - 320) / 2)) $((Y + H - 90)) > /dev/null 2>&1; sleep 0.5
$A key --id "$WS" ctrl+k > /dev/null 2>&1; sleep 1
$A type --id "$WS" "global shortcuts" > /dev/null 2>&1; sleep 1
$A key --id "$WS" Return > /dev/null 2>&1
check "asked from the command list at the owner's own keys, the desktop is asked" "wait_for 10 \"[ \\\"\\\$(portal BIND)\\\" = $((binds + 1)) ]\""
check "all the while the desktop showed the shortcuts to be changed once, at the owner's asking" "[ \"\$(portal CONFIGURE)\" = 1 ]"

# --- i. a desktop with no such portal: nothing is offered
sig -TERM "$(cat "$D/host-portal.pid")"; rm -f "$D/host-portal.pid"
relaunch
check "on a desktop without global shortcuts the app offers none, in its menu or to its page" "wait_for 10 \"last shortcuts-known | grep -q None\" && ! menu | grep -q 'Global Shortcuts' && wait_for 10 \"said 'AT ' | grep -q ' keys=false'\""
