// Dictation: speech into the message box as text, editable before it is sent. The box gives a target
// (what stood around the caret, where words go); this keeps the one recording at a time and what the
// owner sees of it. How the words are heard is lib/speech.ts, which also says which way is used.
import { useSyncExternalStore } from "react";
import { chooseListen, getPrefs, hear, langOf, loadSpeechModels, type Hear, type Way1 } from "./speech.ts";

export type DictTarget = {
  // The place the words go: where the caret is now.
  begin: () => void;
  // The words heard so far (final and interim, replaced each time).
  show: (words: string) => void;
  // The recording ended: the last words, put at the caret with the caret after them.
  end: (words: string) => void;
  // Whether the keyboard is in this box.
  holds: (el: Element | null) => boolean;
};

export type Dictation = { phase: "idle" | "listening" | "transcribing"; label: string; error: string | null; box: string | null };
let now: Dictation = { phase: "idle", label: "", error: null, box: null };
const subs = new Set<() => void>();
const set = (d: Partial<Dictation>) => { now = { ...now, ...d }; subs.forEach((f) => f()); };
export const useDictation = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);
export const dictation = () => now;

const targets = new Map<string, DictTarget>();
let current: string | undefined;
// The route's own box is the default; the box with the keyboard in it wins.
export function registerDictation(key: string, t: DictTarget): () => void {
  targets.set(key, t);
  return () => { if (targets.get(key) === t) targets.delete(key); };
}
export const setDictationHome = (key: string | undefined) => { current = key; };
const pick = (): string | undefined => {
  const at = document.activeElement;
  for (const [k, t] of targets) if (t.holds(at)) return k;
  return current && targets.has(current) ? current : [...targets.keys()][0];
};
// Whether a message box is here to dictate into.
export const canDictate = () => targets.size > 0;

let live: { hear: Hear; box: string } | null = null;
let starting = false;

async function begin(way: Way1, box: string, target: DictTarget, lang: string) {
  target.begin();
  set({ phase: "listening", label: way.label, error: null, box });
  const h = hear({
    way, lang,
    onWords: (f, i) => target.show(`${f} ${i}`.trim()),
    onState: (s) => set({ phase: s === "recording" ? "listening" : "transcribing" }),
    onDone: (text) => { live = null; target.end(text); set({ phase: "idle", box: null }); },
    onFail: (message, retry) => {
      live = null;
      // The browser's own service failed: a speech model of the owner's providers takes over where there is one.
      const next = retry && getPrefs().listen === "auto" ? chooseListen({ ...getPrefs(), listen: "model" }) : null;
      if (next?.way && way.source === "browser") { void begin(next.way, box, target, lang); return; }
      target.end("");
      set({ phase: "idle", error: message, box: null });
    },
  });
  live = { hear: h, box };
}

export async function startDictation(): Promise<void> {
  if (live || starting) return;
  const key = pick();
  const target = key ? targets.get(key) : undefined;
  if (!key || !target) return;
  starting = true;
  try {
    set({ error: null });
    await loadSpeechModels();
    const chosen = chooseListen();
    if (!chosen.way) return set({ error: chosen.why, phase: "idle", box: null });
    await begin(chosen.way, key, target, langOf());
  } finally {
    starting = false;
  }
}

// Ends the recording and puts what was heard in the box.
export function stopDictation() { live?.hear.stop(); }
// Ends it and drops what was heard (the box is as it was).
export function cancelDictation() {
  if (!live) return;
  const { hear: h, box } = live;
  live = null;
  h.cancel();
  targets.get(box)?.end("");
  set({ phase: "idle", box: null });
}
export const toggleDictation = () => (live ? stopDictation() : void startDictation());
export const dismissDictationError = () => set({ error: null });
