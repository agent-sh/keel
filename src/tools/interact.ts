// Questions the model asks the owner (AskUserQuestion, request_user_input,
// ask_user). The tool call waits until the owner answers in the UI; the
// question itself is the tool_use block already in the transcript. Whether it
// can still be answered comes from this live registry, not that history.
import type { Asked, AskedQuestion, PendingQuestion } from "../core/types.ts";
import type { ToolContext } from "./types.ts";

export type Question = AskedQuestion;
// Per question id: the labels picked, plus free text the owner typed.
// `skipped`: the owner sent the others without this one ("Skip the rest" on a card of several questions).
export type Answers = Record<string, { picked: string[]; other?: string; skipped?: true }>;
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

// Standing rulings (src/automation/rulings.ts) join here: `before` may answer
// the model's own questions from a ruling the owner kept, with no card;
// `after` takes the owner's answer from a card and says what keeping it as a
// ruling would cover (the offer the card shows under the answer). A server's
// question and a permission card never reach either.
// `ruled`: the ruling named in the call's result, and what the page shows of it.
export type Ruled = { note: string; shown: { id: string; scope: string; name: string; words: string[] } };
export type Offer = { scopes: { scope: string; name: string }[] };
// `before` answers at once when it can tell at once (no ruling is in scope: the
// card is registered in the same step, as it always was), and with a promise
// when a ruling must be read first.
type Ruling = { answers: Answers; ruled: Ruled };
export const standing: {
  before?: (ctx: ToolContext, qs: Question[]) => Ruling | Promise<Ruling | undefined> | undefined;
  after?: (ctx: ToolContext, qs: Question[], answers: Answers) => Offer | undefined;
} = {};
// `relayed`: the owner's answer came through his helper, from his own words in its conversation (src/helper/relay.ts).
export type Got = { answers: Answers; ruled?: Ruled; offer?: Offer; relayed?: Relayed };
// An answer the helper relayed: its conversation, the owner's message there it quotes, and his words verbatim per question.
// `message`: his whole message, which the session reads beside the quotes.
export type Relayed = { by: "helper"; session: string; event: string; quotes: Record<string, string>; message: string };
const relays = new Map<string, Relayed>();

// The model's own question: the card reads it from the call's input.
// `qs`: its questions, as the tool read them from its input.
export function ask(ctx: ToolContext, qs: Question[] = []): Promise<Got | null> {
  if (ctx.signal.aborted) return Promise.resolve(null);
  let r: ReturnType<NonNullable<typeof standing.before>>;
  // (A ruling that cannot be read is no answer: the owner is asked.)
  try { r = qs.length ? standing.before?.(ctx, qs) : undefined; } catch { r = undefined; }
  if (!r) return card(ctx, qs);
  if (!(r instanceof Promise)) return Promise.resolve(r);
  return r.catch(() => undefined).then((x) => x ?? (ctx.signal.aborted ? null : card(ctx, qs)));
}
async function card(ctx: ToolContext, qs: Question[]): Promise<Got | null> {
  const answers = (await askFor(ctx, undefined, qs)) as Answers | null;
  const key = keyOf(ctx.sessionId, ctx.callId ?? "");
  const relayed = relays.get(key);
  relays.delete(key);
  if (!answers) return null;
  // (A relayed answer is the owner's words for this one card: never offered for keeping as a ruling.)
  if (relayed) return { answers, relayed };
  let offer: Offer | undefined;
  try { offer = standing.after?.(ctx, qs, answers); } catch {} // (No offer is no loss: the answer stands.)
  return { answers, ...(offer ? { offer } : {}) };
}
// What a tool stores with its result for the page: the answers, and the ruling or the offer.
export const shownOf = (g: Got) => ({ answers: g.answers, ...(g.ruled ? { ruling: g.ruled.shown } : {}), ...(g.offer ? { offer: g.offer } : {}), ...(g.relayed ? { relayed: g.relayed } : {}) });
// What the model reads first of an answer the helper relayed: whose words they are and where they were said.
export const relayNote = (r: Relayed) =>
  `The owner answered through his helper: these are his own words, quoted verbatim from his message ${r.event} in the helper's conversation (session ${r.session}). ${Object.entries(r.quotes).map(([q, w]) => `Question ${q}: "${w}"`).join("; ")}.\nHis whole message there: "${r.message}"`;
// The result text with the ruling named first, when one answered, or the relay's note.
export const ruledText = (g: Got, text: string) => (g.ruled ? `${g.ruled.note}\n\n${text}` : g.relayed ? `${relayNote(g.relayed)}\n\n${text}` : text);

// `asked`: a question the call's input does not hold (a server asked it while
// the call ran). The card shows it from the registry, and the owner can
// decline it. One question waits per call at a time.
// `qs`: the model's own questions, kept with the pending card for whoever answers it from elsewhere (the helper's relay).
export function askFor(ctx: ToolContext, asked?: Asked, qs?: Question[]): Promise<Reply> {
  if (ctx.signal.aborted) return Promise.resolve(null);
  const id = ctx.callId ?? `q-${crypto.randomUUID()}`;
  const key = keyOf(ctx.sessionId, id);
  const question: PendingQuestion = { session_id: ctx.sessionId, call_id: id, parent_id: ctx.parentId, ...(asked ? { asked } : {}) };
  if (qs?.length) questionsOf.set(key, qs);
  return new Promise((resolve) => {
    const done = (a: Reply) => {
      ctx.signal.removeEventListener("abort", onAbort);
      if (pending.get(key)?.resolve === done) {
        pending.delete(key);
        questionsOf.delete(key);
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
// The questions a pending card asks: the model's own (as its tool read them) or a server's.
const questionsOf = new Map<string, Question[]>();
export const pendingAsks = (sessionId: string, callId: string): Question[] | undefined => {
  const p = pending.get(keyOf(sessionId, callId));
  return p ? p.question.asked?.questions ?? questionsOf.get(keyOf(sessionId, callId)) ?? [] : undefined;
};

// The owner's answer relayed by his helper (src/helper/relay.ts checks the words are his first): the card is
// answered with them and the call's result says whose words they are and where he said them. A server's form takes
// no relay: it stays the owner's.
export function relay(sessionId: string, callId: string, answers: Answers, r: Relayed): boolean | "form" {
  const p = pending.get(keyOf(sessionId, callId));
  if (!p) return false;
  // A server's form (an MCP elicitation) is answered by the owner on its own card: what it fills goes to the server.
  if (p.question.asked) return "form";
  relays.set(keyOf(sessionId, callId), r);
  const sent = answer(sessionId, callId, answers);
  if (sent !== true) relays.delete(keyOf(sessionId, callId));
  return sent === true;
}

export const allPendingQuestions = () => Array.from(pending.values(), (p) => p.question);
export const pendingQuestions = (sessionId: string) =>
  allPendingQuestions().filter((q) => q.session_id === sessionId).map((q) => q.call_id);
export const questionsWaitingFor = (sessionId: string) =>
  allPendingQuestions().some((q) => q.session_id === sessionId || q.parent_id === sessionId);

export const SKIPPED = "skipped by the owner";
export const answerText = (a: { picked: string[]; other?: string; skipped?: true }) =>
  a.skipped ? SKIPPED : [...a.picked, ...(a.other?.trim() ? [a.other.trim()] : [])].join(", ") || "(no answer)";
