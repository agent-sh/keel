// Questions the model asks the owner (AskUserQuestion, request_user_input,
// ask_user). The tool call waits until the owner answers in the UI; the
// question itself is the tool_use block already in the transcript. Whether it
// can still be answered comes from this live registry, not that history.
import type { Asked, AskedQuestion, PendingQuestion } from "../core/types.ts";
import type { ToolContext } from "./types.ts";

export type Question = AskedQuestion;
// Per question id: the labels picked, plus free text the owner typed.
export type Answers = Record<string, { picked: string[]; other?: string }>;
// The owner said no to a question that can be declined (one a server asked).
export const DECLINED = "declined";
type Reply = Answers | typeof DECLINED | null;

type Pending = { question: PendingQuestion; resolve: (a: Reply) => void };
const pending = new Map<string, Pending>();
const keyOf = (sessionId: string, callId: string) => `${sessionId}:${callId}`;
// Questions that stopped waiting, newest last: a phone that saw one pending
// learns it closed. A few hundred are plenty.
// `answers`: what was picked, so a card reopened elsewhere shows it.
const closed: { call_id: string; session_id: string; at: number; answered: boolean; answers?: Answers }[] = [];
// What the owner typed for a server's question is the server's alone: it is
// not kept here, so it reaches no other device.
const close = (call_id: string, session_id: string, reply: Reply, asked: boolean) => {
  const answers = reply === DECLINED ? null : reply;
  closed.push({ call_id, session_id, at: Date.now(), answered: answers !== null, ...(answers && !asked ? { answers } : {}) });
  if (closed.length > 300) closed.splice(0, closed.length - 300);
};
export const closedQuestions = (sinceMs: number) => closed.filter((q) => q.at >= sinceMs);

// The model's own question: the card reads it from the call's input.
export const ask = (ctx: ToolContext) => askFor(ctx) as Promise<Answers | null>;

// `asked`: a question the call's input does not hold (a server asked it while
// the call ran). The card shows it from the registry, and the owner can
// decline it. One question waits per call at a time.
export function askFor(ctx: ToolContext, asked?: Asked): Promise<Reply> {
  if (ctx.signal.aborted) return Promise.resolve(null);
  const id = ctx.callId ?? `q-${crypto.randomUUID()}`;
  const key = keyOf(ctx.sessionId, id);
  const question: PendingQuestion = { session_id: ctx.sessionId, call_id: id, parent_id: ctx.parentId, ...(asked ? { asked } : {}) };
  return new Promise((resolve) => {
    const done = (a: Reply) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (pending.get(key)?.resolve === done) {
        pending.delete(key);
        close(id, ctx.sessionId, a, !!asked);
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

// `sendAnyway`: the owner's word for a form that asks for what looks like a
// secret. Without it such a form takes no answer ("unsent"): it is declined,
// or sent on purpose.
export function answer(sessionId: string, callId: string, answers: Answers, sendAnyway = false): boolean | "unsent" {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p) return false;
  if (p.question.asked?.sensitive && !sendAnyway) return "unsent";
  p.resolve(answers);
  return true;
}

// Only a question a server asked can be declined: the model's own takes an answer.
export function decline(sessionId: string, callId: string): boolean {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p?.question.asked) return false;
  p.resolve(DECLINED);
  return true;
}
export const askedOf = (sessionId: string, callId: string) => pending.get(keyOf(sessionId, callId))?.question.asked;

export const allPendingQuestions = () => Array.from(pending.values(), (p) => p.question);
export const pendingQuestions = (sessionId: string) =>
  allPendingQuestions().filter((q) => q.session_id === sessionId).map((q) => q.call_id);
export const questionsWaitingFor = (sessionId: string) =>
  allPendingQuestions().some((q) => q.session_id === sessionId || q.parent_id === sessionId);

export const answerText = (a: { picked: string[]; other?: string }) =>
  [...a.picked, ...(a.other?.trim() ? [a.other.trim()] : [])].join(", ") || "(no answer)";
