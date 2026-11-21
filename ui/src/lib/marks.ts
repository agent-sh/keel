// What a folded step must never hide: the calls the daemon marks (the gate's
// own policy says they are high risk or the owner's alone, they write outside
// the session's folder, the owner denied them, or a standing rule let them run
// without asking). Asked for per event, once, a little after its calls appear;
// kept for the page's life.
import { useSyncExternalStore } from "react";
import type { CallMark } from "../../../src/safety/marks.ts";
import { api, reportUnlessGone } from "./store.ts";

export type Mark = CallMark;

const bySession = new Map<string, Map<string, Mark[]>>();
const asked = new Map<string, Set<string>>();
const queue = new Map<string, Set<string>>();
const subs = new Set<() => void>();
let timer: Timer | undefined;

// The marks of the calls of these events are read, unless they were asked for before.
export function ensureMarks(sessionId: string, events: string[]) {
  const had = asked.get(sessionId) ?? new Set<string>();
  asked.set(sessionId, had);
  const q = queue.get(sessionId) ?? new Set<string>();
  for (const id of events) if (!had.has(id)) { had.add(id); q.add(id); }
  if (!q.size) return;
  queue.set(sessionId, q);
  timer ??= setTimeout(flush, 80);
}

// The marks of an event's calls are read again: what they hang on has changed (a program made a call).
export function marksAgain(sessionId: string, event: string) {
  asked.get(sessionId)?.delete(event);
  ensureMarks(sessionId, [event]);
}

async function flush() {
  timer = undefined;
  for (const [sessionId, q] of [...queue]) {
    queue.delete(sessionId);
    const events = [...q];
    // A long history is asked for in parts.
    for (let i = 0; i < events.length; i += 500) {
      try {
        const r = await api<{ marks: Record<string, Mark[]> }>(`/api/sessions/${sessionId}/call-marks`, { method: "POST", body: JSON.stringify({ events: events.slice(i, i + 500) }) });
        const ids = Object.keys(r.marks ?? {});
        if (!ids.length) continue;
        const m = bySession.get(sessionId) ?? new Map<string, Mark[]>();
        bySession.set(sessionId, m);
        for (const id of ids) m.set(id, r.marks[id]!);
        subs.forEach((f) => f());
      } catch (e) {
        // Said once; the calls show as they do without marks.
        reportUnlessGone(e, { at: "call marks" });
        break;
      }
    }
  }
}

const NONE: Mark[] = [];
export const marksOf = (sessionId: string | undefined, callId: string): Mark[] => (sessionId ? bySession.get(sessionId)?.get(callId) : undefined) ?? NONE;

const subscribe = (f: () => void) => { subs.add(f); return () => void subs.delete(f); };
// Which of these calls are marked, as their ids in one string: a component
// renders again only when that changes, and reads the marks with marksOf.
export function useMarked(sessionId: string | undefined, calls: { id: string }[]): string {
  return useSyncExternalStore(subscribe, () => {
    const m = sessionId ? bySession.get(sessionId) : undefined;
    if (!m?.size) return "";
    let out = "";
    for (const c of calls) if (m.has(c.id)) out += `${c.id} `;
    return out;
  });
}

// The words of a call's marks, as its line says them beside the verb.
export const markWords = (marks: Mark[]): string => marks.map((m) => m.why).join("; ");
