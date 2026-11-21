// Questions the model asks the owner (AskUserQuestion, request_user_input,
// ask_user). The tool call waits until the owner answers in the UI; the
// question itself is the tool_use block already in the transcript. Whether it
// can still be answered comes from this live registry, not that history.
import type { PendingQuestion } from "../core/types.ts";
import type { ToolContext } from "./types.ts";

// What the model is told of a question a daemon restart cut that could not be
// put back on its card (the session's model no longer has the tool). Nothing
// was answered: the inbox files it as a decision the owner still owes.
export const QUESTION_CUT = "No answer was recorded before the daemon restarted: the question expired. Ask it again if the decision still matters.";

export type Question = {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
};
// Per question id: the labels picked, plus free text the owner typed.
export type Answers = Record<string, { picked: string[]; other?: string }>;

type Pending = { question: PendingQuestion; resolve: (a: Answers | null) => void };
const pending = new Map<string, Pending>();
const keyOf = (sessionId: string, callId: string) => `${sessionId}:${callId}`;
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
  if (ctx.signal.aborted) return Promise.resolve(null);
  const id = ctx.callId ?? `q-${crypto.randomUUID()}`;
  const key = keyOf(ctx.sessionId, id);
  const question = { session_id: ctx.sessionId, call_id: id, parent_id: ctx.parentId };
  return new Promise((resolve) => {
    const done = (a: Answers | null) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (pending.get(key)?.resolve === done) {
        pending.delete(key);
        close(id, ctx.sessionId, a);
        ctx.questionChanged?.();
      }
      resolve(a);
    };
    const onAbort = () => done(null);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    pending.set(key, { question, resolve: done });
    ctx.questionChanged?.();
  });
}

export function answer(sessionId: string, callId: string, answers: Answers): boolean {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p) return false;
  p.resolve(answers);
  return true;
}

export const allPendingQuestions = () => Array.from(pending.values(), (p) => p.question);
export const pendingQuestions = (sessionId: string) =>
  allPendingQuestions().filter((q) => q.session_id === sessionId).map((q) => q.call_id);
export const questionsWaitingFor = (sessionId: string) =>
  allPendingQuestions().some((q) => q.session_id === sessionId || q.parent_id === sessionId);

export const answerText = (a: { picked: string[]; other?: string }) =>
  [...a.picked, ...(a.other?.trim() ? [a.other.trim()] : [])].join(", ") || "(no answer)";
