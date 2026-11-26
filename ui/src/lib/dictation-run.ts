// The recording of dictation: the one microphone at a time, and the words it gives the box that asked
// (lib/dictation.ts holds the boxes and what the owner sees; this file is fetched with the first press).
import { set, targets, type DictTarget } from "./dictation.ts";
import { chooseListen, getPrefs, hear, langOf, loadSpeechModels, type Hear, type Way1 } from "./speech.ts";

type Recording = { box: string; target: DictTarget; handle?: Hear; stopping?: boolean; keepDraft?: boolean };
let live: Recording | null = null;
let starting = false;

function begin(way: Way1, recording: Recording, lang: string) {
  const { box, target } = recording;
  let ended = false;
  const active = () => live === recording && !ended;
  const finish = (text: string | null, error: string | null) => {
    live = null;
    set({ phase: "idle", box: error ? box : null, error });
    target.end(text);
  };
  set({ phase: "listening", label: way.label, error: null, box });
  const handle = hear({
    way, lang,
    onWords: (f, i) => { if (active()) target.show(`${f} ${i}`.trim()); },
    onState: (s) => { if (active() && s === "transcribing") set({ phase: "transcribing" }); },
    onDone: (text) => { if (active()) finish(text, null); },
    onFail: (message, retry) => {
      if (!active()) return;
      // A model may take over while listening, but never record more after the owner asked to stop.
      const next = !recording.stopping && retry && getPrefs().listen === "auto" ? chooseListen({ ...getPrefs(), listen: "model" }) : null;
      if (next?.way && way.source === "browser") { ended = true; begin(next.way, recording, lang); return; }
      finish(null, message);
    },
  });
  if (active()) recording.handle = handle;
}

export async function startDictation(box: string, target: DictTarget): Promise<void> {
  if (live || starting) return;
  starting = true;
  try {
    set({ error: null });
    await loadSpeechModels();
    if (targets.get(box) !== target) return;
    const chosen = chooseListen();
    if (!chosen.way) return set({ error: chosen.why, phase: "idle", box: null });
    target.begin();
    begin(chosen.way, live = { box, target }, langOf());
  } finally {
    starting = false;
  }
}

// Ends the recording and puts what was heard in the box.
export function stopDictation(keepDraft: boolean) {
  if (!live) return;
  live.keepDraft ||= keepDraft;
  if (live.stopping) return;
  live.stopping = true;
  set({ phase: "transcribing" });
  live.handle?.stop();
}
// Send already stopped the microphone. Let its last words reach the original draft even after the box leaves.
export function abandon(target: DictTarget) {
  if (live?.target !== target || live.keepDraft) return;
  const { handle } = live;
  live = null;
  handle?.cancel();
  set({ phase: "idle", box: null });
}
