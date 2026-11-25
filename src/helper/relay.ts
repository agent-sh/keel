// The owner's typed answer to another session's open question, relayed by his
// helper. He answers in the helper's conversation; the helper carries his words
// to the card he means, so he is never asked the same thing twice.
//
// - Only his words: each answer is a verbatim quote of one of his own messages
//   in the helper's conversation (a prompt he typed, steered, queued or spoke;
//   never a digest, a wake or another input of the harness). The helper names
//   the message by its event id; a quote that is not in it is refused, so the
//   helper never answers a question in its own words this way.
// - Only a question: a model's question to the owner or a server's form that
//   does not ask for a secret. A permission card is not a question: the helper
//   answers those only by the approval rules (cards.ts, src/safety/delegate.ts).
// - Kept as his words: the call's result says the answer is the owner's,
//   relayed by the helper, quotes the words and names where he said them (the
//   helper's session and the event); the session's timeline has the same.
//
// - Whole: a quote is his whole message or one whole sentence of it (a line is a sentence too), never a part
//   of one, so no word of his is taken out of what it said ("not production" out of "use staging, not
//   production"). His words pick an offered option only when his whole message is that option.
// - After the question: the message is newer than the card, so an answer to something else is not taken.
// - A server's form (an MCP elicitation) stays his: he answers it on its card.
// - The session reads his whole message beside the quotes.
//
// Pure over the helper's branch (relay.test.ts); the tool carries the result.
import { isPeerMessage, ownerPrompt } from "../core/owner.ts";
import type { StoredEvent } from "../core/types.ts";
import { ownerWords } from "../safety/judge.ts";
import type { Answers, Question } from "../tools/interact.ts";

export type RelayAsk = { event: string; answers: { question?: string; quote: string }[] };

// Words as compared: runs of white space are one space, none at the ends.
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const bare = (t: string) => t.replace(/[.!?\u2026]+$/, "").trim();
// The sentences of a message: split after . ! ? or an ellipsis before white space, and at each line.
export const sentencesOf = (text: string): string[] => text.split(/\n+/).flatMap((l) => l.split(/(?<=[.!?\u2026])\s+/)).map(norm).filter(Boolean);
// Whether a quote is the whole message or one whole sentence of it (its closing mark may be left off).
export function wholeQuote(text: string, quote: string): boolean {
  const q = norm(quote);
  if (!q) return false;
  return [norm(text), ...sentencesOf(text)].some((s) => s === q || bare(s) === bare(q) && bare(q) !== "");
}

// The answers to send, or why the relay is refused. `line`: the helper's branch; `qs`: the card's questions;
// `since`: when the card was opened (the owner's message must come after it).
export function relayAnswers(line: readonly StoredEvent[], ask: RelayAsk, qs: readonly Question[], since: number): { answers: Answers; quotes: Record<string, string>; message: string } | { refused: string } {
  const said = line.find((e) => e.id === ask.event);
  if (!said) return { refused: `no message ${ask.event} in your conversation: name the owner's own message the words come from` };
  // The gate's own reading of the owner's words: no harness input, no peer's message, no input the harness marked.
  if (said.kind !== "user" || !ownerPrompt(said.data) || !ownerWords(said) || isPeerMessage(said)) return { refused: `event ${ask.event} is not a message the owner wrote: only his own words are relayed` };
  if (said.ts <= since) return { refused: `the owner's message ${ask.event} was written before the question was asked: it does not answer it, so the question stays his` };
  const text = String(said.data.text ?? "");
  if (!ask.answers.length) return { refused: "no answer given" };
  if (!qs.length) return { refused: "the card has no questions to answer" };
  const answers: Answers = {};
  const quotes: Record<string, string> = {};
  for (const a of ask.answers) {
    const quote = norm(String(a.quote ?? ""));
    if (!quote) return { refused: "an answer is the owner's words, quoted: it is empty" };
    if (!norm(text).includes(quote)) return { refused: `"${quote.slice(0, 120)}" is not in the owner's message ${ask.event}: relay his words verbatim, never your own` };
    if (!wholeQuote(text, quote)) return { refused: `"${quote.slice(0, 120)}" is part of a sentence of the owner's: quote his whole message or a whole sentence of it` };
    const q = a.question !== undefined ? qs.find((x) => x.id === String(a.question)) : qs.length === 1 ? qs[0] : undefined;
    if (!q) return { refused: a.question !== undefined ? `the card has no question ${a.question}` : `the card asks ${qs.length} questions: say which one each answer is for` };
    if (answers[q.id]) return { refused: `question ${q.id} is answered twice` };
    // His whole message that is one of the offered options picks it; anything else is his own answer, typed.
    const whole = bare(norm(text)).toLowerCase();
    const option = q.options.find((o) => bare(norm(o.label)).toLowerCase() === whole);
    answers[q.id] = option && bare(quote).toLowerCase() === whole ? { picked: [option.label] } : { picked: [], other: quote };
    quotes[q.id] = quote;
  }
  const missing = qs.filter((q) => !answers[q.id] && !q.optional);
  if (missing.length) return { refused: `the owner's words answer no question ${missing.map((q) => q.id).join(", ")}: relay an answer for each, or leave the card to him` };
  return { answers, quotes, message: text };
}
