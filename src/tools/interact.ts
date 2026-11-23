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
// `question`: the id of a question a server asked (a call can have several, one after another).
// `how`: answered, declined (a server's question), or not answered (its turn was stopped).
export type QuestionEnd = "answered" | "declined" | "not answered";
const closed: { call_id: string; session_id: string; at: number; answered: boolean; how: QuestionEnd; answers?: Answers; question?: string }[] = [];
// What the owner typed for a server's question is the server's alone: it is
// not kept here, so it reaches no other device.
const close = (call_id: string, session_id: string, reply: Reply, asked?: string) => {
  const answers = reply === DECLINED ? null : reply;
  const how: QuestionEnd = reply === DECLINED ? "declined" : reply === null ? "not answered" : "answered";
  closed.push({ call_id, session_id, at: Date.now(), answered: answers !== null, how, ...(answers && !asked ? { answers } : {}), ...(asked ? { question: asked } : {}) });
  if (closed.length > 300) closed.splice(0, closed.length - 300);
};
export const closedQuestions = (sinceMs: number) => closed.filter((q) => q.at >= sinceMs);
// How the last question of a call ended, while this daemon remembers it.
export const closedHow = (sessionId: string, callId: string): QuestionEnd | undefined => closed.findLast((q) => q.session_id === sessionId && q.call_id === callId)?.how;

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
        close(id, ctx.sessionId, a, asked?.id);
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
// `question`: the id of the question the answer is for. A server can ask one
// question after another on one call: an answer sent twice, or sent for the
// question that was on the card a moment ago, must not answer the next one
// unseen ("stale"). The model's own question has no id: one waits per call.
export function answer(sessionId: string, callId: string, answers: Answers, sendAnyway = false, question?: string): boolean | "unsent" | "stale" {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p) return false;
  if (p.question.asked && p.question.asked.id !== question) return "stale";
  if (p.question.asked?.sensitive && !sendAnyway) return "unsent";
  p.resolve(answers);
  return true;
}

// Only a question a server asked can be declined: the model's own takes an answer.
export function decline(sessionId: string, callId: string, question?: string): boolean | "stale" {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p?.question.asked) return false;
  if (p.question.asked.id !== question) return "stale";
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
