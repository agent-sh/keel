// Conversation mode: the owner speaks a message, it is sent when they stop, the reply is read aloud, and
// it listens again. The turns are talk-core.ts's (pure); this runs them against the microphone, the
// session's message box and the session's own events. It lives only while a view shows the session: leaving
// it ends the mode, and so does the owner's Stop, Esc, or the button and key that turned it on.
import { useSyncExternalStore } from "react";
import { STOPPERS } from "../../../src/core/stoppers.ts";
import { boxOf } from "./quote.ts";
import { modalOpen } from "./overlay.ts";
import { chooseListen, chooseSay, getPrefs, hear, hush, langOf, loadSpeechModels, speak, voicesReady, type Hear, type Way1 } from "./speech.ts";
import { getState, subscribe } from "./store.ts";
import { OFF, replyOf, spokenText, talkStep, type Effect, type Phase, type Talk, type TalkEvent } from "./talk-core.ts";
import { getUI, onUI } from "./ui.ts";

export type Conversation = {
  sid: string | null;
  phase: Phase;
  heard: string;                  // what is being heard now, as words
  recording: "recording" | "transcribing" | null;
  listenLabel: string;
  sayLabel: string | null;        // null: replies are not read aloud (note says why)
  note: string | null;
  error: string | null;
};
const IDLE: Conversation = { sid: null, phase: "off", heard: "", recording: null, listenLabel: "", sayLabel: null, note: null, error: null };
let view = IDLE;
const subs = new Set<() => void>();
const publish = (v: Partial<Conversation>) => { view = { ...view, ...v }; subs.forEach((f) => f()); };
export const useConversation = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => view);
export const conversation = () => view;

let talk: Talk = OFF;
let listenWay: Way1 | null = null;
let sayWay: Way1 | null = null;
let h: Hear | null = null;
let carry = "";          // words kept from a recognizer that ended by itself
let sentSeq: number | null = null;
let gen = 0;             // a mode turned off and on again is not the one an old callback belonged to
let silent: ReturnType<typeof setTimeout> | undefined;
let quick = 0;           // recognizers that ended at once, in a row
let unwatch: (() => void)[] = [];

const join = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(" ");
const lastSeq = (sid: string) => getState().events[sid]?.at(-1)?.seq ?? 0;

function dispatch(e: TalkEvent) {
  const r = talkStep(talk, e);
  const before = talk;
  talk = r.talk;
  publish({ phase: talk.phase, heard: join(talk.final, talk.interim), ...(talk.error ? { error: talk.error } : {}), ...(talk.phase !== "listening" ? { recording: talk.phase === "thinking" ? view.recording : null } : {}) });
  // Silence is counted from the last change of the words, on a timer that runs while they are heard.
  if (talk.phase === "listening" && talk.lastAt !== before.lastAt && listenWay?.source === "browser") {
    clearTimeout(silent);
    const ms = getPrefs().silenceMs;
    silent = setTimeout(() => dispatch({ t: "tick", now: Date.now(), silenceMs: ms }), ms + 20);
  }
  for (const f of r.effects) run(f);
}

function run(f: Effect) {
  if (f === "listen") return listen();
  if (f === "unlisten") { clearTimeout(silent); h?.cancel(); h = null; return; }
  if (f === "hush") { hush(); return; }
  if ("send" in f) return send(f.send);
  return say(f.speak);
}

function listen() {
  if (!listenWay || !view.sid) return;
  const mine = gen;
  const way = listenWay;
  const started = Date.now();
  h = hear({
    way, lang: langOf(),
    silenceMs: way.source === "model" ? getPrefs().silenceMs : undefined,
    onWords: (f, i) => { if (mine === gen) dispatch({ t: "words", final: join(carry, f), interim: i, at: Date.now() }); },
    onState: (s) => { if (mine !== gen) return; publish({ recording: s }); if (s === "transcribing") dispatch({ t: "captured" }); },
    onDone: (text, why) => {
      if (mine !== gen) return;
      h = null;
      if (way.source === "model") return dispatch({ t: "said", text });
      // The browser's recognizer ended on its own (it does, after a while): its words are kept and it starts again.
      carry = join(carry, text);
      quick = Date.now() - started < 1000 ? quick + 1 : 0;
      if (quick >= 5) return dispatch({ t: "failed", why: "The browser's recognizer keeps stopping." });
      void why;
      dispatch({ t: "recognizer-ended" });
    },
    onFail: (message, retry) => {
      if (mine !== gen) return;
      h = null;
      const next = retry && way.source === "browser" && getPrefs().listen === "auto" ? chooseListen({ ...getPrefs(), listen: "model" }) : null;
      if (next?.way) { listenWay = next.way; publish({ listenLabel: next.way.label, note: `${message} Listening with ${next.way.label} instead.` }); return listen(); }
      dispatch({ t: "failed", why: message });
    },
  });
  publish({ recording: way.source === "model" ? view.recording : null });
}

function send(text: string) {
  const sid = view.sid;
  if (!sid) return;
  carry = "";
  sentSeq = lastSeq(sid);
  const box = boxOf(sid);
  if (!box?.say(text, false)) {
    sentSeq = null;
    publish({ note: "The message was not sent. The box says why." });
    dispatch({ t: "send-failed" });
    return;
  }
  publish({ note: null, heard: text });
  watch();
}

function say(text: string) {
  const mine = gen;
  const done = () => { if (mine === gen) dispatch({ t: "spoken" }); };
  if (!sayWay) { done(); return; }
  speak(text, sayWay, getPrefs()).then(done, (e) => { if (mine === gen) publish({ note: `Not read aloud: ${(e as Error).message}` }); done(); });
}

// The session's events say when the turn has ended and what it answered; the session leaving the screen ends the mode.
function watch() {
  const sid = view.sid;
  if (!sid || talk.phase !== "thinking" || sentSeq === null) return;
  const r = replyOf(getState().events[sid], sentSeq);
  if (!r.done) return;
  const ended = getState().events[sid]!.find((e) => e.seq > sentSeq! && e.kind === "turn_end");
  sentSeq = null;
  // The owner stopped the turn: that is the end of the conversation too.
  if (r.reason === "interrupted" && STOPPERS[String(ended?.data?.stopped_by)]?.owner) return stop();
  dispatch({ t: "reply", text: r.reason === "end_turn" ? spokenText(r.text) : "" });
}

function away() {
  const r = getUI().route;
  if (view.phase === "off" || !view.sid) return;
  if (r.name !== "session" || r.id !== view.sid || !getState().sessions[view.sid]) stop();
}

const onKey = (e: KeyboardEvent) => {
  // Esc ends the mode at once. It does not stop the page's own Esc (a running turn stops too).
  if (e.key === "Escape" && !e.repeat && view.phase !== "off" && !modalOpen()) stop();
};

export async function startConversation(sid: string): Promise<void> {
  if (view.phase !== "off") return;
  const mine = ++gen;
  publish({ ...IDLE, sid, note: null, error: null });
  await Promise.all([loadSpeechModels(), voicesReady()]);
  if (mine !== gen) return;
  const l = chooseListen();
  if (!l.way) return publish({ ...IDLE, error: l.why });
  const s = chooseSay();
  listenWay = l.way;
  sayWay = s.way;
  carry = ""; quick = 0; sentSeq = null;
  const busy = getState().sessions[sid]?.phase === "working";
  if (busy) {
    const start = getState().events[sid]?.findLast((e) => e.kind === "turn_start");
    sentSeq = start ? start.seq - 1 : lastSeq(sid);
  }
  publish({ sid, listenLabel: l.way.label, sayLabel: s.way?.label ?? null, note: s.way ? null : `Replies are not read aloud. ${s.why}`, error: null });
  unwatch = [subscribe(watch), subscribe(away), onUI(away)];
  addEventListener("keydown", onKey, true);
  dispatch({ t: "start", busy });
  watch();
}

// Ends the mode at once: the microphone closes and the voice stops.
export function stop() {
  gen++;
  clearTimeout(silent);
  unwatch.forEach((f) => f());
  unwatch = [];
  removeEventListener("keydown", onKey, true);
  const had = talk.phase !== "off";
  talk = OFF;
  h?.cancel();
  h = null;
  hush();
  sentSeq = null;
  if (had || view.phase !== "off") publish({ ...IDLE, note: null });
}

export const toggleConversation = (sid: string) => (view.phase === "off" && !view.error ? void startConversation(sid) : stop());
export const dismissConversationError = () => publish({ error: null });
