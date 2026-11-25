// What a live session's input box holds, read from its screen (the agent view's `live` lines, with their colours):
// a text sent while the owner's unsent draft sits in the box would go out inside it, recorded by the harness as one
// typed prompt. Pure, so it is tested on screens.
//
// "draft": the box holds text in the terminal's own colour (what is typed there); the send is refused.
// "empty": the box was found and holds nothing.
// "unread": no box was found on the screen (a window the agent view cannot read, a dialog in its place, a harness
//   whose box is not known here), or what it holds is styled (a placeholder, or a draft drawn in colour). The send
//   goes, and its words are kept loosely (src/drive/sent-read.ts keysInto).
//
// Claude Code draws its box between two rules, its first line opening with `>` (or `❯`), each line perhaps inside
// `│` borders; a prompt in its history has no rules around it. Codex opens its composer with `›` at the bottom of
// its screen, below the last cell of its history; only the box's first line is read there, since the lines under it
// are its continuation or the footer and look alike.
export type Box = "draft" | "empty" | "unread";

import { stripAnsi } from "../core/text.ts";

const RULE = /^\s*[╭╰]?─{8,}[╮╯]?\s*$/u;
const BORDER = /^\s*│|│\s*$/gu;
const BOTTOM = 12; // the box is within this many lines of the screen's end

// Codes of an SGR sequence that put the default style back (all, or the colour, weight, italics, underline, inverse).
const RESET = new Set(["0", "22", "23", "24", "27", "39", "49"]);
const ESC = /^\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/;

// The text after the marker in a raw line, and whether its first character was drawn with a style (a colour,
// faint, bold): the SGR sequences before it, the last one deciding.
function after(raw: string, marker: RegExp): { text: string; styled: boolean } | undefined {
  const plain = stripAnsi(raw);
  const m = plain.match(marker);
  if (!m) return undefined;
  const tail = plain.slice(m[0].length);
  const text = tail.replace(/\s*│?\s*$/u, "").trim();
  if (!text) return { text, styled: false };
  const pos = m[0].length + (tail.length - tail.trimStart().length);
  let styled = false;
  let seen = 0;
  for (let i = 0; i < raw.length; ) {
    const rest = raw.slice(i);
    const sgr = /^\x1b\[([0-9;]*)m/.exec(rest);
    if (sgr) {
      styled = !sgr[1]!.split(";").filter(Boolean).every((c) => RESET.has(c));
      i += sgr[0].length;
      continue;
    }
    const esc = ESC.exec(rest);
    if (esc) { i += esc[0].length; continue; }
    if (seen === pos) break;
    seen++;
    i++;
  }
  return { text, styled };
}

function claude(lines: string[]): Box {
  const plain = lines.map((l) => stripAnsi(l));
  const marker = /^\s*│?\s*[>❯](?= |$) ?/u;
  for (let i = plain.length - 1; i >= Math.max(1, plain.length - BOTTOM); i--) {
    if (!marker.test(plain[i]!) || !RULE.test(plain[i - 1]!)) continue;
    let end = i + 1;
    while (end < plain.length && !RULE.test(plain[end]!)) end++;
    if (end >= plain.length) return "unread"; // no rule closes it: not the box as drawn
    const head = after(lines[i]!, marker);
    if (!head) return "unread";
    const rest = plain.slice(i + 1, end).map((l) => l.replace(BORDER, "").trim()).filter(Boolean);
    if (!head.text && !rest.length) return "empty";
    if (head.text && head.styled) return "unread";
    return "draft";
  }
  return "unread";
}

function codex(lines: string[]): Box {
  const plain = lines.map((l) => stripAnsi(l));
  const marker = /^\s*›(?= |$) ?/u;
  for (let i = plain.length - 1; i >= Math.max(0, plain.length - BOTTOM); i--) {
    if (!marker.test(plain[i]!)) continue;
    // Below the box: its continuation and the footer, each indented, or blank; a cell of the history is not.
    if (plain.slice(i + 1).some((l) => l.trim() && !/^\s{2}/.test(l))) return "unread";
    const head = after(lines[i]!, marker);
    if (!head || !head.text || head.styled) return "unread";
    return "draft";
  }
  return "unread";
}

export function boxOf(kind: string, lines: string[]): Box {
  if (kind === "claude") return claude(lines);
  if (kind === "codex") return codex(lines);
  return "unread";
}
