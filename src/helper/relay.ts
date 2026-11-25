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
// Pure over the helper's branch (relay.test.ts); the tool carries the result.
import { ownerPrompt } from "../core/owner.ts";
import type { StoredEvent } from "../core/types.ts";
import type { Answers, Question } from "../tools/interact.ts";

export type RelayAsk = { event: string; answers: { question?: string; quote: string }[] };

// The answers to send, or why the relay is refused. `line`: the helper's branch; `qs`: the card's questions.
export function relayAnswers(line: readonly StoredEvent[], ask: RelayAsk, qs: readonly Question[]): { answers: Answers; quotes: Record<string, string> } | { refused: string } {
  const said = line.find((e) => e.id === ask.event);
  if (!said) return { refused: `no message ${ask.event} in your conversation: name the owner's own message the words come from` };
  if (said.kind !== "user" || !ownerPrompt(said.data)) return { refused: `event ${ask.event} is not a message the owner wrote: only his own words are relayed` };
  const text = String(said.data.text ?? "");
  if (!ask.answers.length) return { refused: "no answer given" };
  if (!qs.length) return { refused: "the card has no questions to answer" };
  const answers: Answers = {};
  const quotes: Record<string, string> = {};
  for (const a of ask.answers) {
    const quote = String(a.quote ?? "").trim();
    if (!quote) return { refused: "an answer is the owner's words, quoted: it is empty" };
    if (!text.includes(quote)) return { refused: `"${quote.slice(0, 120)}" is not in the owner's message ${ask.event}: relay his words verbatim, never your own` };
    const q = a.question !== undefined ? qs.find((x) => x.id === String(a.question)) : qs.length === 1 ? qs[0] : undefined;
    if (!q) return { refused: a.question !== undefined ? `the card has no question ${a.question}` : `the card asks ${qs.length} questions: say which one each answer is for` };
    if (answers[q.id]) return { refused: `question ${q.id} is answered twice` };
    // His words that are one of the offered options pick it; anything else is his own answer, typed.
    const option = q.options.find((o) => o.label.trim().toLowerCase() === quote.toLowerCase());
    answers[q.id] = option ? { picked: [option.label] } : { picked: [], other: quote };
    quotes[q.id] = quote;
  }
  const missing = qs.filter((q) => !answers[q.id] && !q.optional);
  if (missing.length) return { refused: `the owner's words answer no question ${missing.map((q) => q.id).join(", ")}: relay an answer for each, or leave the card to him` };
  return { answers, quotes };
}
