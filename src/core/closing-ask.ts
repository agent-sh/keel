// What a reply says when nobody reads it at once: its first line, and the question to the owner
// it closes with, if any. A decision asked in prose (no card) is still a decision owed: a session
// whose unattended turn ended asking the owner counts as needing him until he writes there
// (src/server/routes/marks.ts keeps the mark, src/core/watch.ts says it). Pure.
//
// The rule for a closing question: the reply's last paragraph (code, quotes, inline code, headings, table rows
// and links taken out) ends asking the owner. A question there counts when it is the paragraph's last sentence,
// or speaks to the owner ("you") with at most two short sentences after it ("Do you want...? Until then...").
// One that does not say "you" counts only alone in its paragraph ("Want me to draft the reply?"): after a status
// line ("Nine lanes are working. Should I go on?") it is the reply thinking aloud. A list that ends the reply is
// judged by its last item, and a list under a lead that tells of another's question ("Open items I am tracking:",
// "I asked the reviewer:") asks nothing. A question told of, or sent to someone else ("I told the lane: can you
// rebase?", "Waiting on the agent's answer to: why...?"), is another's to answer. A bold label that asks heads its
// own answer. A rhetorical question answered in the same paragraph ("Why? The cache was cold.") is not one.
// Only the reply's last WINDOW characters are judged, and every pattern is linear: a reply can be long.

const MAX = 160;
const WINDOW = 4096;

const clip = (t: string, max = MAX) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

// Markdown marks a line shows as plain words.
const plain = (t: string) =>
  t.replace(/^[ \t]{0,3}(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

const FENCE = /^[ \t]*(```|~~~)/;

// The text without its fenced code, one line at a time.
function unfenced(t: string): string {
  const out: string[] = [];
  let open: string | undefined;
  for (const l of t.split("\n")) {
    const m = FENCE.exec(l);
    if (open) { if (m && m[1] === open && /^[ \t]*(```|~~~)[ \t]*$/.test(l)) { open = undefined; out.push(""); } continue; }
    if (m) { open = m[1]; continue; }
    out.push(l);
  }
  return out.join("\n");
}

// The reply's first line of words: "Landing 275 is installed and verified."
export function firstLine(text: string): string {
  for (const l of unfenced(text.trimStart().slice(0, WINDOW)).split("\n")) {
    const w = plain(l.replace(/^[ \t]*>[ \t]?/, ""));
    if (w && !/^[-=*_|:\s]+$/.test(w)) return clip(w);
  }
  return "";
}

// Words that tell of a question someone else asked, was sent or is tracked, not one asked of the owner.
const TOLD = /\b(asked|asks|asking|wonder(?:s|ed)?|wants? to know|told|tell(?:s|ing)?|sent|send(?:s|ing)?|messaged|messag(?:e|es|ing) (?:the|to)|answers? to|tracking|track(?:s|ed)?)\b/i;
// A lead that names another party before a colon: "to the lane:", "the reviewer's question:".
const OTHER_LEAD = /\b(lanes?|agents?|reviewers?|subagents?|workers?|coordinators?|sessions?|models?|harness)(?:'s|s')?\b[^:?]{0,80}:/i;
const toldOf = (t: string) => TOLD.test(t) || OTHER_LEAD.test(t);
const TO_OWNER = /\b(you|your|yours)\b/i;
const LIST = /^[ \t]{0,3}([-*+]|\d+[.)])[ \t]+/;
const TABLE = /^[ \t]*\|/;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]/;

// A line's own words: inline code and quoted words are not the reply's question; a bold label that asks
// ("**Did it run?** It did.") heads its answer; a link's address is no sentence.
const own = (l: string) =>
  plain(l.replace(/`[^`\n]*`/g, "").replace(/"[^"\n]*"|“[^”\n]*”/g, "\"\"").replace(/(\*\*|__)[^*_\n]*\?\1/g, "").replace(/\bhttps?:\/\/\S+/g, "a link"));

const sentencesOf = (words: string) => words.match(/[^.?!]+(?:[.?!]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

// The question the reply ends asking the owner, in one line, or undefined.
export function closingAsk(text: string): string | undefined {
  let tail = text.length > WINDOW ? text.slice(text.indexOf("\n", text.length - WINDOW) + 1 || text.length - WINDOW) : text;
  // A fence opened before the window is still open in it.
  if (tail !== text && (text.slice(0, text.length - tail.length).split("\n").filter((l) => FENCE.test(l)).length % 2)) tail = "```\n" + tail;
  const paras = unfenced(tail).split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  const at = paras.length - 1;
  const last = paras[at];
  if (!last) return undefined;
  // Quoted lines are someone else's words; headings and table rows are labels and cells.
  const lines = last.split("\n").filter((l) => l.trim() && !/^[ \t]*>/.test(l) && !TABLE.test(l) && !HEADING.test(l));
  if (!lines.length) return undefined;
  // A list that ends the reply: its last item, under the lead before the list (in this paragraph or the one before).
  let unit = lines;
  if (LIST.test(lines.at(-1)!)) {
    let i = lines.length - 1;
    while (i > 0 && !LIST.test(lines[i]!)) i--; // the last item's first line
    const item = lines.slice(i);
    let j = i - 1;
    while (j >= 0 && LIST.test(lines[j]!)) j--;
    const lead = j >= 0 ? lines[j]! : paras[at - 1]?.split("\n").filter((l) => l.trim()).at(-1) ?? "";
    if (lead && toldOf(own(lead))) return undefined;
    unit = item;
  }
  const words = unit.map(own).join(" ");
  const sentences = sentencesOf(words);
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i]!;
    if (!/\?[)\]*_]*$/.test(s)) continue;
    if (toldOf(s) || toldOf(sentences[i - 1] ?? "")) return undefined;
    const you = TO_OWNER.test(s);
    const closes = i === sentences.length - 1 || (you && sentences.length - i <= 3);
    if (closes && (you || i === 0)) return clip(s.replace(/\s+/g, " "), 240);
    return undefined;
  }
  return undefined;
}

// The words of a stored reply: its text blocks.
export const replyText = (data: { blocks?: unknown }): string =>
  (Array.isArray(data.blocks) ? data.blocks : []).filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim()).map((b: any) => b.text as string).join("\n\n");
