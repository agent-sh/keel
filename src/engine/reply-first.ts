// The owner's words that join a running turn are answered first. A steer waits for the step boundary
// (the model's reply and its tool calls end first), and then the model would often take another tool
// step or more before it writes a word to the owner: each step at a coordinator's context costs about
// as much time as the first one. So the step that takes an owner's steer is told, in the system role
// after it, to reply in that step's own text: an answer to a question from what it knows now (or the
// one line of what it will check), a line of what it takes from anything else. Its tool calls go
// beside that text in the same step, so the reply costs no step of its own.
// Only the owner's own words (a steer with no mark of the harness's); an agent's message from its
// parent or a peer is work, not a person waiting.

export const REPLY_FIRST = "reply_first";

// A steer of the owner's that still waits this long for the step boundary moves the commands the
// turn's calls wait on behind them, as the owner's own Move does, so the steer joins at once. The
// number is the model's own time to a first token at a coordinator's context (about ten seconds,
// measured on the owner's sessions): a command still running by then holds the reply longer than
// the reply itself takes, and a command that ends sooner is left alone (a moved one costs the model
// a read of its output later).
export const STEER_MOVE_MS = 10_000;

// A question by its words: a question mark, or one of the words a question opens with.
const OPENERS = /^(?:what|why|how|where|when|which|who|whom|whose|is|are|am|was|were|do|does|did|can|could|should|shall|will|would|may|might|has|have|had|any|isn't|aren't|doesn't|didn't|can't|won't|למה|מה|איך|איפה|מתי|האם|כמה|מי|יש)(?=[\s,]|$)/iu;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？؟]/u.test(t)) return true;
  return OPENERS.test(t);
}

// The note for the steers one step takes, or undefined when none of them is the owner's.
export function replyFirst(steers: readonly { text: string; owner: boolean }[]): string | undefined {
  const own = steers.filter((s) => s.owner && s.text.trim());
  if (!own.length) return undefined;
  const asks = own.some((s) => isQuestion(s.text));
  const which = own.length > 1 ? "messages" : "message";
  return asks
    ? `[harness] The owner wrote the ${which} above while you worked, and is waiting for your reply. Answer the question first, in a few sentences, in the text of this step: from what you know now, or, when it needs a look, one line of what you will check. Write that before any further tool call (the calls can go in the same step), then go on with the work.`
    : `[harness] The owner wrote the ${which} above while you worked, and is waiting for your reply. Say in a line or two, in the text of this step, what you take from it and what you will do (the tool calls can go in the same step), then go on with the work.`;
}
