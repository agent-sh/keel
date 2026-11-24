// A session's title: a few words that say its task, written by one of the
// owner's small models after the first reply. Claude Code titles a session it
// was not given a name for with a background request to its small fast model,
// from the first prompt; the Codex app does the same after the first message
// (a cheap model at low effort, 36 characters at most), and a rename cancels
// a title still being made. Here:
//   - a title the owner or the session's maker gave is never replaced
//     (`title_by` is empty for those, and for sessions from before titles were
//     made); only the first prompt's own words are (`prompt`);
//   - the title is made once the first reply is in, from the owner's first
//     prompts and the start of the reply, in one request with no conversation,
//     no tools and no cache (it is not part of any turn's prefix);
//   - a first prompt that says nothing of a task yet (a greeting, one or two
//     words) gives a title made again once, after the next reply (`start`);
//   - an edit of the first prompt gives the session a new task: its title is
//     the new prompt's words until the next reply makes one again;
//   - the title is saved only when nobody renamed the session meanwhile;
//   - it is written by one of the owner's small models, else by a model
//     cheaper than the session's own (the readers' choices), never by the
//     session's own model unless the owner named it a small model: with no
//     such model the session keeps its first prompt's words.
import { registerSettings, settings } from "../admin/settings.ts";
import type { StoredEvent } from "../core/types.ts";

// A title made by a model costs one small request a session. With `by_model` off no request is made:
// the session keeps its first prompt's first line, cut (`firstLineTitle`).
registerSettings("titles", { by_model: true }, (v) => (typeof v.by_model === "boolean" ? undefined : "by_model is true or false"));
export const modelTitles = (): boolean => settings().titles?.by_model !== false;

// Who wrote a session's title: "" given (the owner, the session's maker, or a
// session from before), "prompt" the first prompt's first line, "model" a
// small model, "start" a small model from a first prompt that held no task yet.
export type TitleBy = "" | "prompt" | "model" | "start";

export const TITLE_SYSTEM = "You name a coding session in a list of sessions. You answer with the title only.";

// The longest title kept: the request asks for a few words (the Codex app's
// titles are 36 characters at most), and an answer longer than a first
// prompt's title (80 characters) is cut as that one is.
export const TITLE_CHARS = 80;
// The output a title request may take: a title is a dozen tokens, and a model
// that thinks at its lowest effort still fits.
export const TITLE_OUTPUT = 1024;
// What one request carries of the conversation: each of the first owner
// prompts up to PROMPT_CHARS, at most PROMPTS of them, and the first reply's
// start. About 1,000 tokens at most.
const PROMPT_CHARS = 1_500;
const PROMPTS = 3;
const REPLY_CHARS = 600;

const GREETING = /^(hi|hello|hey|hiya|yo|howdy|greetings|good (morning|afternoon|evening)|thanks|thank you|ok|okay|sup|shalom|hola|bonjour|ciao|hallo|start|begin|go|continue|test|ping)\b/i;

// Whether a first prompt says nothing of a task yet: a greeting, or one or two
// words. Its title is made again once after the next reply.
export function weakStart(text: string): boolean {
  const words = text.replace(/script:\S+.*$/gm, "").replace(/[^\p{L}\p{N}\s'-]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  return words.length <= 6 && GREETING.test(words.join(" "));
}

// The owner's own prompts of a branch, oldest first (no harness notes, no
// report, wake or loop envelope).
export function ownerPrompts(line: readonly StoredEvent[]): string[] {
  return line
    .filter((e) => e.kind === "user" && !e.data.kind && e.data.origin !== "restart" && typeof e.data.text === "string" && !e.data.text.startsWith("[harness]"))
    .map((e) => String(e.data.text).trim())
    .filter(Boolean);
}

// The text of the first reply of a branch that has one.
export function firstReply(line: readonly StoredEvent[]): string {
  for (const e of line) {
    if (e.kind !== "assistant") continue;
    const text = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    if (text) return text;
  }
  return "";
}

// Whether a title request is owed now, after a turn's end: the title is the
// first prompt's (or a weak start's), and the branch holds a reply to it (for
// a weak start, a reply to a later prompt as well).
export function titleOwed(by: TitleBy | undefined, line: readonly StoredEvent[]): boolean {
  if (by !== "prompt" && by !== "start") return false;
  const prompts = ownerPrompts(line);
  if (!prompts.length || !line.some((e) => e.kind === "assistant")) return false;
  if (by === "start") return prompts.length >= 2 && line.findLastIndex((e) => e.kind === "assistant") > line.findLastIndex((e) => e.kind === "user");
  return true;
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\u2026`);

// The one request a title takes.
export function titlePrompt(prompts: string[], reply: string): string {
  const said = prompts.slice(0, PROMPTS).map((p) => `<prompt>\n${cut(p, PROMPT_CHARS)}\n</prompt>`).join("\n");
  return [
    "Write a title for this coding session: what the owner asked for, in 3 to 6 words.",
    "Say the task, not the conversation: \"Fix the cart discount rounding\", not \"User asks about a bug\".",
    "Use the language the owner wrote in. Sentence case, no quotes, no period at the end, no markdown. Answer with the title alone.",
    "",
    said,
    ...(reply ? [`<reply>\n${cut(reply, REPLY_CHARS)}\n</reply>`] : []),
  ].join("\n");
}

// The title in a model's answer: its first line, without quotes, a "Title:"
// label, markdown or an end period, cut at a word within TITLE_CHARS. Empty
// when nothing is left.
export function cleanTitle(answer: string): string {
  let t = (answer.split("\n").map((l) => l.trim()).find(Boolean) ?? "");
  t = t.replace(/^[#>*_`\-\s]+/, "").replace(/^(session )?title\s*[:\-]\s*/i, "").replace(/[*_`]+/g, "");
  t = t.replace(/^["'\u201c\u2018\u00ab]+|["'\u201d\u2019\u00bb]+$/g, "").replace(/[.\s]+$/, "").replace(/\s+/g, " ").trim();
  if (t.length <= TITLE_CHARS) return t;
  const head = t.slice(0, TITLE_CHARS - 1);
  const at = head.lastIndexOf(" ");
  return (at > TITLE_CHARS / 2 ? head.slice(0, at) : head).replace(/[\s,.;:]+$/, "") + "\u2026";
}
