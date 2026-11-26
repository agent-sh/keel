// What the owner answered on the cards of a session another harness runs (a command Codex asked about), by
// the call's id in its transcript: the bar of the session (OutsideBar.tsx) reads them with its details and
// its frames, and the call's line (ToolCall.tsx) says the answer, which the harness's own record does not.
import { useSyncExternalStore } from "react";

export type Answered = { state: "allowed" | "denied"; reason?: string };

let bySession: Record<string, Record<string, Answered>> = {};
const subs = new Set<() => void>();

export function setAnswers(sessionId: string, answers: Record<string, Answered> | undefined) {
  const next = answers ?? {};
  const had = bySession[sessionId];
  if (had && JSON.stringify(had) === JSON.stringify(next)) return;
  bySession = { ...bySession, [sessionId]: next };
  for (const f of subs) f();
}

const subscribe = (f: () => void) => { subs.add(f); return () => void subs.delete(f); };

export function useOutsideAnswer(sessionId: string | undefined, callId: string): Answered | undefined {
  return useSyncExternalStore(subscribe, () => (sessionId ? bySession[sessionId]?.[callId] : undefined));
}
