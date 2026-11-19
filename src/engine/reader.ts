// The reader: a cheaper model reads long content (a fetched page) once, with
// the question the working model asked, and hands back only what answers it.
// The working model's context then carries the answer instead of the page,
// which it would otherwise write to its cache and read again on every later
// step. Claude Code's WebFetch and Gemini CLI's web_fetch work this way (both
// tools take a prompt); the full page stays on disk for a Read when the answer
// is not enough.
import type { ModelInfo } from "../providers/types.ts";

// Text up to this many characters goes to the working model whole: the
// reader's answer runs to a few hundred tokens, so a page under about four
// times that saves too little to be worth a second model's paraphrase.
export const READ_WHOLE_CHARS = 8_000;

// The model that reads for a session on `current`: the owner's choice
// (KEEL_READER_MODEL, a full id; else the configured small Claude model,
// ANTHROPIC_DEFAULT_HAIKU_MODEL, when the session's provider lists it), else
// the cheapest model per input token of the same provider and family whose
// window holds the text (the newest of equals). A model without a price is
// never picked by price; with nothing cheaper the session's own model reads.
export function pickReader(models: ModelInfo[], current: ModelInfo, needTokens: number, env: Record<string, string | undefined> = process.env): ModelInfo {
  const fits = (m: ModelInfo) => m.context >= needTokens;
  const own = env.KEEL_READER_MODEL && models.find((m) => m.id === env.KEEL_READER_MODEL);
  if (own && fits(own)) return own;
  const small = env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.replace(/\[[^\]]*\]$/, "");
  const configured = current.family === "claude" && small && models.find((m) => m.provider === current.provider && m.model === small);
  if (configured && fits(configured)) return configured;
  const priced = (m: ModelInfo) => m.billing === "per_token" && typeof m.price?.input === "number";
  const pool = models.filter((m) => m.provider === current.provider && m.family === current.family && priced(m) && fits(m));
  pool.sort((a, b) => a.price!.input - b.price!.input || (b.release ?? "").localeCompare(a.release ?? ""));
  const best = pool[0];
  if (!best || !priced(current) || best.price!.input >= current.price!.input) return current;
  return best;
}

export function readerPrompt(source: string, prompt: string, text: string): string {
  return [
    `Content of ${source}:`,
    "<content>",
    text,
    "</content>",
    "",
    `Request: ${prompt}`,
    "",
    "Answer the request from the content above only. Quote exact values, code, commands, names, numbers and URLs verbatim. " +
      "When the content does not answer it, say so plainly and name what the content does cover. No preamble.",
  ].join("\n");
}
