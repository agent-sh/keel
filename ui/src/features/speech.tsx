// Dictation and conversation mode: their keys, commands and the Settings > Speech section. The buttons
// and the line that says what is happening are in the message box (components/Speech.tsx).
import { Mic } from "lucide-react";
import { lazy } from "react";
import { canDictate, dictation, setDictationHome, startDictation, stopDictation, toggleDictation } from "../lib/dictation.ts";
import { settingsSections } from "../lib/extend.ts";
import { matches, registerCommand } from "../lib/keys.ts";
import { modalOpen } from "../lib/overlay.ts";
import { conversation, toggleConversation } from "../lib/talk.ts";
import { getState } from "../lib/store.ts";
import { getUI, onUI } from "../lib/ui.ts";

settingsSections.add({
  id: "speech",
  label: "Speech",
  words: "voice dictation conversation microphone speak listen read aloud text to speech whisper",
  icon: <Mic className="size-4" />,
  order: 39,
  component: lazy(() => import("../components/SpeechSettings.tsx").then((m) => ({ default: m.SpeechSettings }))),
});

// Alt Shift D: no browser takes it, and no command of the page does. A tap starts and a second tap ends; holding it
// past this long is push to talk (the words go in when the key comes up).
const DICTATE = "alt+shift+d";
const CONVERSE = "alt+shift+v";
const HOLD_MS = 350;
const sessionNow = () => { const r = getUI().route; return r.name === "session" && getState().sessions[r.id] ? r.id : undefined; };

registerCommand(
  {
    id: "dictate", label: "Dictate into the message box", group: "Voice", keys: DICTATE, inInput: true, words: "speech microphone voice speak type words",
    when: () => canDictate(), run: () => toggleDictation(),
  },
  {
    id: "converse", label: "Talk with this session (conversation mode)", group: "Voice", keys: CONVERSE, inInput: true, words: "speech microphone voice speak listen hands free hear reply aloud",
    when: () => !!sessionNow(), run: () => { const id = sessionNow(); if (id) toggleConversation(id); },
  },
);

// The box the keyboard is in, or the route's own, is where dictation goes.
onUI(() => setDictationHome(sessionNow() ?? "start"));
setDictationHome(sessionNow() ?? "start");

// The key acts on press and on release: a tap toggles, a hold records while it is down. The page's keymap
// sees only the press, so this takes the key first.
let held: number | null = null;
window.addEventListener("keydown", (e) => {
  if (!matches(e, DICTATE) || modalOpen() || conversation().phase !== "off" || !canDictate()) return;
  e.preventDefault();
  if (e.repeat) return;
  if (dictation().phase !== "idle") { stopDictation(); held = null; return; }
  held = Date.now();
  void startDictation();
}, true);
window.addEventListener("keyup", (e) => {
  if (held === null || !/^(d|alt|shift)$/i.test(e.key)) return;
  const long = Date.now() - held >= HOLD_MS;
  held = null;
  if (long) stopDictation();
}, true);
// Esc while dictating ends it and keeps the words heard: it stops nothing else.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || dictation().phase === "idle" || modalOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stopDictation();
}, true);

