// Questions the model asks the owner (AskUserQuestion, request_user_input,
// ask_user). The tool call waits until the owner answers in the UI; the
// question itself is the tool_use block already in the transcript, so the UI
// needs no extra event to show it.
import type { ToolContext } from "./types.ts";

export type Question = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
};
// Per question id: the labels picked, plus free text the owner typed.
export type Answers = Record<string, { picked: string[]; other?: string }>;

type Pending = { sessionId: string; resolve: (a: Answers | null) => void };
const pending = new Map<string, Pending>();
// Questions that stopped waiting, newest last: a phone that saw one pending
// learns it closed. A few hundred are plenty.
// `answers`: what was picked, so a card reopened elsewhere shows it.
const closed: { call_id: string; session_id: string; at: number; answered: boolean; answers?: Answers }[] = [];
const close = (call_id: string, session_id: string, answers: Answers | null) => {
  closed.push({ call_id, session_id, at: Date.now(), answered: answers !== null, ...(answers ? { answers } : {}) });
  if (closed.length > 300) closed.splice(0, closed.length - 300);
};
export const closedQuestions = (sinceMs: number) => closed.filter((q) => q.at >= sinceMs);

export function ask(ctx: ToolContext): Promise<Answers | null> {
  const id = ctx.callId ?? `q-${Date.now()}`;
  return new Promise((resolve) => {
    const done = (a: Answers | null) => { if (pending.delete(id)) close(id, ctx.sessionId, a); ctx.signal.removeEventListener("abort", onAbort); resolve(a); };
    const onAbort = () => done(null);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { sessionId: ctx.sessionId, resolve: done });
  });
}

export function answer(sessionId: string, callId: string, answers: Answers): boolean {
  const p = pending.get(callId);
  if (!p || p.sessionId !== sessionId) return false;
  p.resolve(answers);
  return true;
}

export const pendingQuestions = (sessionId: string) =>
  [...pending.entries()].filter(([, p]) => p.sessionId === sessionId).map(([id]) => id);

export const answerText = (a: { picked: string[]; other?: string }) =>
  [...a.picked, ...(a.other?.trim() ? [a.other.trim()] : [])].join(", ") || "(no answer)";
