// An unsent side question stays with its session and the thread it was typed for while the panel is closed or
// another session is shown, in this tab only (memory, never the server or storage). It is never the message
// box's draft and never reaches the main turn. When the thread a follow-up continues moves (the first answer
// gives a new question its thread, a branch switch starts another, New thread), the words go with it unless the
// thread they move to already has words of its own. Sending a question or forgetting the session's side
// questions drops them.

export type SideDrafts = Map<string, string>;

// (A thread not made yet, the next question's, is "".)
const keyOf = (sid: string, thread: string | undefined) => `${sid}\u0000${thread ?? ""}`;

export const draftOf = (d: SideDrafts, sid: string, thread: string | undefined) => d.get(keyOf(sid, thread)) ?? "";

export function setDraft(d: SideDrafts, sid: string, thread: string | undefined, text: string) {
  if (text.trim()) d.set(keyOf(sid, thread), text);
  else d.delete(keyOf(sid, thread));
}

export function moveDraft(d: SideDrafts, sid: string, from: string | undefined, to: string | undefined) {
  if ((from ?? "") === (to ?? "")) return;
  const words = d.get(keyOf(sid, from));
  if (words === undefined) return;
  d.delete(keyOf(sid, from));
  if (!d.has(keyOf(sid, to))) d.set(keyOf(sid, to), words);
}

export function dropDrafts(d: SideDrafts, sid: string) {
  for (const k of [...d.keys()]) if (k.startsWith(`${sid}\u0000`)) d.delete(k);
}
