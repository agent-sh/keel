// What a waiting session waits on and until when, from its state alone, for a
// row of the sessions report whose timeline has no line of it (an agent parked
// on a wait of its own reads "waiting" and no more): "waiting for a timer",
// since when it began, and when it is due. The words are the vocabulary's
// (src/core/state-words.ts); a wait's note is never said (it may hold what
// another session's model should not read).
import { waitsFor } from "../core/state-words.ts";
import type { SessionState, Watch } from "../core/watch.ts";

type Row = { line?: string; from?: number; until?: number };
export function waitingOf(st: Pick<SessionState, "watch" | "why" | "on" | "since" | "until"> & { watch: Watch }, at: number): Row {
  if (st.watch !== "wait" || st.why === "resume") return {};
  const on = st.why === "wait" ? st.on : st.why;
  return {
    line: `waiting for ${on ? waitsFor(on) : "a condition it set"}`,
    ...(st.since && st.since < at ? { from: st.since } : {}),
    ...(st.until ? { until: st.until } : {}),
  };
}
