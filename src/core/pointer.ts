// Another session named in a prompt: a short pointer to it, never its history. The
// message box puts this text where the mention was typed; it holds the session's title,
// its id, how it stands and the first line of its last reply, so the model knows which
// session is meant and can ask for more (its timeline) when it needs it.
import { STATE_WORD } from "./state-words.ts";
import type { Watch } from "./watch.ts";

export type PointerFacts = { id: string; title: string; watch?: Watch; last_reply?: string };

const MAX_LINE = 160;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// The first line of a reply with words in it, cut at MAX_LINE.
export function firstLine(text: string): string {
  const line = text.split("\n").map(oneLine).find((l) => l && !/^[#>*\-`|\s]*$/.test(l)) ?? "";
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line;
}

export function pointerText(f: PointerFacts): string {
  const title = oneLine(f.title).replace(/["\]]/g, "'").slice(0, 120) || "Untitled";
  const state = f.watch ? `, ${STATE_WORD[f.watch].toLowerCase()}` : "";
  const last = f.last_reply ? ` Its last reply began: "${f.last_reply.replace(/"/g, "'")}".` : "";
  return `[Another session, "${title}" (id ${f.id}${state}).${last} Its history is not in this prompt: read its timeline at /api/sessions/${f.id}/timeline?format=text if you need more.]`;
}
