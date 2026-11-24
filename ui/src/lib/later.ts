// Requests put away with "Later": an approval or a question that waits above the message box can be
// set aside to a count in the session's head, and brought back from it. Nothing is answered or
// dropped: the turn still waits on it, and its card is drawn again by the same count. Kept in the
// page only, per session. A request that comes after the pile was put away brings the whole pile
// back (the owner is shown what newly asks, with what they set aside).
import { useEffect, useSyncExternalStore } from "react";
import { getState, useStore } from "./store.ts";
import { getSafety, useSafety } from "./safety.ts";
import { awayOf, type Put } from "./later-rules.ts";

const put = new Map<string, Put>();
const subs = new Set<() => void>();
let version = 0;
const changed = () => { version++; subs.forEach((f) => f()); };

const NONE: string[] = [];
const NO_CARDS: { id: string }[] = [];
// The ids of what waits on the owner in this session: its approval cards and its open questions.
const waitingNow = (sessionId: string): string[] => [...(getSafety().approvals[sessionId] ?? NO_CARDS).map((a) => a.id), ...(getState().questionCalls[sessionId] ?? NONE)];

export const later = {
  // Puts the requests away (the pile as it is now: what comes after brings it all back).
  put(sessionId: string, ...ids: string[]) {
    const was = put.get(sessionId);
    put.set(sessionId, { ids: new Set([...(was?.ids ?? []), ...ids]), known: new Set(waitingNow(sessionId)) });
    changed();
  },
  bring(sessionId: string) {
    if (put.delete(sessionId)) changed();
  },
};

// The requests of the session put away now. A fresh set only when its members changed.
export function useAway(sessionId: string): ReadonlySet<string> {
  const approvals = useSafety((s) => s.approvals[sessionId]);
  const calls = useStore((s) => s.questionCalls[sessionId]);
  const v = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => version);
  void v;
  const waiting = [...(approvals ?? NO_CARDS).map((a) => a.id), ...(calls ?? NONE)];
  const next = awayOf(put.get(sessionId), waiting);
  // A pile that a new request broke is not put away any more: it must not come back as away when that request is answered.
  const p = put.get(sessionId);
  const broken = !!p && waiting.some((id) => !p.known.has(id));
  useEffect(() => { if (broken) later.bring(sessionId); }, [broken, sessionId]);
  const key = [...next].sort().join(" ");
  return cached(sessionId, key, next);
}
const last = new Map<string, { key: string; set: ReadonlySet<string> }>();
function cached(sessionId: string, key: string, set: ReadonlySet<string>) {
  const was = last.get(sessionId);
  if (was && was.key === key) return was.set;
  last.set(sessionId, { key, set });
  return set;
}
