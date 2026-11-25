// The recording of dictation: the one microphone at a time, and the words it gives the box that asked
// (lib/dictation.ts holds the boxes and what the owner sees; this file is fetched with the first press).
import { set, pick, targets, type DictTarget } from "./dictation.ts";
import { chooseListen, getPrefs, hear, langOf, loadSpeechModels, type Hear, type Way1 } from "./speech.ts";

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
