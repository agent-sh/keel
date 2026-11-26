// Dictation: speech into the message box as text, editable before it is sent. The box gives a target
// (what stood around the caret, where words go); this keeps the one recording at a time and what the
// owner sees of it. How the words are heard is lib/speech.ts, which also says which way is used. This file is
// what the page needs before anyone speaks (the boxes, the state); the recording is dictation-run.ts, which
// loads with the first press (or the pointer over the button).
import { useSyncExternalStore } from "react";

export type DictTarget = {
  // The place the words go: where the caret is now.
  begin: () => void;
  // The words heard so far (final and interim, replaced each time).
  show: (words: string) => void;
  // The last words, or null if transcription failed and the visible draft should stay.
  end: (words: string | null) => void;
  // Whether the keyboard is in this box.
  holds: (el: Element | null) => boolean;
};

export type Dictation = { phase: "idle" | "listening" | "transcribing"; label: string; error: string | null; box: string | null };
let now: Dictation = { phase: "idle", label: "", error: null, box: null };
const subs = new Set<() => void>();
export const set = (d: Partial<Dictation>) => { now = { ...now, ...d }; subs.forEach((f) => f()); };
export const useDictation = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => now);
export const dictation = () => now;

export const targets = new Map<string, DictTarget>();
let current: string | undefined;
// The route's own box is the default; the box with the keyboard in it wins.
export function registerDictation(key: string, t: DictTarget): () => void {
  targets.set(key, t);
  return () => {
    if (targets.get(key) === t) targets.delete(key);
    run?.abandon(t);
  };
}
export const setDictationHome = (key: string | undefined) => { current = key; };
export const pick = (): string | undefined => {
  const at = document.activeElement;
  for (const [k, t] of targets) if (t.holds(at)) return k;
  return current && targets.has(current) ? current : [...targets.keys()][0];
};
// Whether a message box is here to dictate into.
export const canDictate = () => targets.size > 0;
export const hasDictationBox = (key: string) => targets.has(key);

// The recording itself loads on first use: the pointer over a speech button, or the first press.
let run: typeof import("./dictation-run.ts") | null = null;
const engine = () => import("./dictation-run.ts").then((m) => (run = m));
export const warmDictation = () => void engine().catch(() => {});

export async function startDictation(key = pick()): Promise<void> {
  const target = key ? targets.get(key) : undefined;
  if (key && target) await (run ?? (await engine())).startDictation(key, target);
}

// Ends the recording and puts what was heard in the box.
export function stopDictation(keepDraft = false) { run?.stopDictation(keepDraft); }
export const toggleDictation = (key?: string) => (now.phase !== "idle" ? stopDictation() : void startDictation(key));
export const dismissDictationError = () => set({ error: null });
