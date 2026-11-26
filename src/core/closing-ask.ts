// What a reply says when nobody reads it at once: its first line, and the question to the owner
// it closes with, if any. A decision asked in prose (no card) is still a decision owed: a session
// whose unattended turn ended asking the owner counts as needing him until he writes there
// (src/server/routes/marks.ts keeps the mark, src/core/watch.ts says it). Pure.
//
// The rule for a closing question: the reply's last paragraph (code, quotes and inline code taken
// out) holds a question sentence, in a paragraph that tells of no one else's question ("I asked the
// reviewer:"), that is the paragraph's last sentence or speaks to the owner with at most two short
// sentences after it ("Do you want...? Until then..."). A bold label that asks heads its own answer. A rhetorical
// question answered in the same paragraph ("Why? The cache was cold.") is not one.

const MAX = 160;

const clip = (t: string, max = MAX) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

// Markdown marks a line shows as plain words.
const plain = (t: string) =>
  t.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

// The text without its fenced code.
const unfenced = (t: string) => t.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?(^\s*\1\s*$|$(?![\s\S]))/gm, "\n");

// The reply's first line of words: "Landing 275 is installed and verified."
export function firstLine(text: string): string {
  for (const l of unfenced(text).split("\n")) {
    const w = plain(l.replace(/^\s*>\s?/, ""));
    if (w && !/^[-=*_|:\s]+$/.test(w)) return clip(w);
  }
  return "";
}

const REPORTED = /\b(asked|asks|asking|wonder(?:s|ed)?|wants? to know)\b/i;
const TO_OWNER = /\b(you|your|yours)\b/i;

// The question the reply ends asking the owner, in one line, or undefined.
export function closingAsk(text: string): string | undefined {
  const paras = unfenced(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras.at(-1);
  if (!last) return undefined;
  const lines = last.split("\n").filter((l) => l.trim());
  // A quoted paragraph is someone else's words.
  if (lines.every((l) => /^\s*>/.test(l))) return undefined;
  // Questions told of ("I asked the reviewer three questions:") are another's to answer.
  if (REPORTED.test(last)) return undefined;
  const words = lines
    .filter((l) => !/^\s*>/.test(l))
    // Inline code and quoted words are not the reply's own question.
    // A bold label that asks ("**Did it run?** It did.") heads its answer.
    .map((l) => plain(l.replace(/`[^`]*`/g, "").replace(/"[^"\n]*"|“[^”\n]*”/g, "\"\"").replace(/(\*\*|__)[^*_\n]*\?\1/g, "")))
    .join(" ");
  const sentences = words.match(/[^.?!]+(?:[.?!]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!;
    if (!/\?[)\]*_]*$/.test(s)) continue;
    if (i === sentences.length - 1 || (TO_OWNER.test(s) && sentences.length - i <= 3)) return clip(s.replace(/\s+/g, " "), 240);
    return undefined;
  }
  return undefined;
}

// The words of a stored reply: its text blocks.
export const replyText = (data: { blocks?: unknown }): string =>
  (Array.isArray(data.blocks) ? data.blocks : []).filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim()).map((b: any) => b.text as string).join("\n\n");
