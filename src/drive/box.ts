// What a live session's input box holds, read from its screen (the agent view's `live` lines, with their colours):
// a text sent while the owner's unsent draft sits in the box would go out inside it, recorded by the harness as one
// typed prompt. Pure, so it is tested on screens.
//
// "draft": the box holds text: in the terminal's own colour, as typed text is, or drawn in a colour (Claude Code
//   colours a command or a shell line). A send is refused.
// "empty": the box was found and holds nothing, or only its placeholder (every character faint or grey).
// "unread": no box was found on the screen (a window the agent view cannot read, a dialog in its place, a harness
//   whose box is not known here, a Codex box whose first line shows neither text nor its placeholder). A model's send goes,
//   its words kept loosely (src/drive/sent-read.ts keysInto); the owner's composer refuses it
//   (src/integrations/outside/terminal.ts).
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

const ESC = /^\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/;

// The style a character is drawn with, as far as telling a placeholder from typed text needs: faint, a grey
// foreground, inverse (the cursor's cell), and anything else (a colour, bold, a background).
type Style = { faint: boolean; grey: boolean; inverse: boolean; other: boolean };
const PLAIN: Style = { faint: false, grey: false, inverse: false, other: false };

// A placeholder's grey foreground: bright black, the mid-range 256-colour greys (8, 240 to 250, and 102 and 145 of
// the cube's diagonal), or a true colour whose channels are close to each other with a mean of 100 to 200. White,
// black and the near ones are a theme's text colour, so text drawn in them is typed.
function greyOf(codes: string[], i: number): { grey: boolean; used: number } {
  const c = codes[i]!;
  if (c === "90") return { grey: true, used: 1 };
  if (c === "38" && codes[i + 1] === "5") {
    const n = Number(codes[i + 2]);
    return { grey: n === 8 || (n >= 240 && n <= 250) || n === 102 || n === 145, used: 3 };
  }
  if (c === "38" && codes[i + 1] === "2") {
    const rgb = [3, 4, 5].map((k) => Number(codes[i + k - 1]));
    const mean = (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
    return { grey: Math.max(...rgb) - Math.min(...rgb) < 24 && mean >= 100 && mean <= 200, used: 5 };
  }
  return { grey: false, used: 1 };
}

function apply(st: Style, params: string): Style {
  const codes = params.split(";");
  if (!params) return { ...PLAIN };
  let s = { ...st };
  for (let i = 0; i < codes.length; ) {
    const c = codes[i] || "0";
    if (c === "0") { s = { ...PLAIN }; i++; continue; }
    if (c === "2") s.faint = true;
    else if (c === "22") { s.faint = false; s.other = false; }
    else if (c === "7") s.inverse = true;
    else if (c === "27") s.inverse = false;
    else if (c === "39") { s.grey = false; s.other = false; }
    else if (c === "23" || c === "24" || c === "49") s.other = false;
    else if (c === "38" || c === "90" || /^3[0-7]$/.test(c) || /^9[1-7]$/.test(c)) {
      const g = c === "38" || c === "90" ? greyOf(codes, i) : { grey: false, used: 1 };
      s.grey = g.grey;
      s.other = !g.grey;
      i += g.used;
      continue;
    } else if (c === "48" || c === "58") { s.other = true; i += codes[i + 1] === "5" ? 3 : codes[i + 1] === "2" ? 5 : 1; continue; }
    else s.other = true;
    i++;
  }
  return s;
}

// An SGR's parameters with ';' between every code. A colon group of a direct colour (kitty, ITU T.416:
// `38:2::r:g:b`, or `38:2:cs:r:g:b`) carries a colour-space field that the semicolon form has not: it is dropped.
function sgrParams(params: string): string {
  return params
    .split(";")
    .map((p) => {
      const q = p.split(":");
      if (["38", "48", "58"].includes(q[0]!) && q[1] === "2" && q.length === 6) q.splice(2, 1);
      return q.join(";");
    })
    .join(";");
}

// The text after the marker in a raw line, and how it is drawn: "plain" (the terminal's own colour, as typed text
// is), "placeholder" (every character faint or grey, the cursor's inverse cell aside), or "coloured" (any other
// style: a draft drawn in colour, as Claude Code draws a command or a shell line).
type Look = "plain" | "placeholder" | "coloured";
function after(raw: string, marker: RegExp): { text: string; look: Look } | undefined {
  const plain = stripAnsi(raw);
  const m = plain.match(marker);
  if (!m) return undefined;
  const tail = plain.slice(m[0].length);
  const text = tail.replace(/\s*│?\s*$/u, "").trim();
  if (!text) return { text, look: "plain" };
  const from = m[0].length + (tail.length - tail.trimStart().length);
  const to = from + text.length;
  let st = { ...PLAIN };
  let seen = 0;
  let typed = false;
  let coloured = false;
  let dim = false;
  for (let i = 0; i < raw.length && seen < to; ) {
    const rest = raw.slice(i);
    const sgr = /^\x1b\[([0-9;:]*)m/.exec(rest);
    if (sgr) { st = apply(st, sgrParams(sgr[1]!)); i += sgr[0].length; continue; }
    const esc = ESC.exec(rest);
    if (esc) { i += esc[0].length; continue; }
    const ch = String.fromCodePoint(raw.codePointAt(i)!);
    if (seen >= from && ch.trim()) {
      if (st.other) coloured = true;
      else if (st.faint || st.grey) dim = true;
      else if (!st.inverse) typed = true;
    }
    seen += ch.length;
    i += ch.length;
  }
  const look: Look = coloured || (typed && dim) ? "coloured" : typed ? "plain" : dim ? "placeholder" : "plain";
  return { text, look };
}

// The screen without its blank lines at the end: a fresh session draws its box near the top of a tall screen.
function trimmed(lines: string[]): string[] {
  let n = lines.length;
  while (n > 0 && !stripAnsi(lines[n - 1]!).trim()) n--;
  return lines.slice(0, n);
}

function claude(all: string[]): Box {
  const lines = trimmed(all);
  const plain = lines.map((l) => stripAnsi(l));
  // Claude Code 2.1.332 writes a no-break space after its glyph, earlier builds a space.
  const marker = /^\s*│?\s*[>❯](?=[ \u00a0]|$)[ \u00a0]?/u;
  for (let i = plain.length - 1; i >= Math.max(1, plain.length - BOTTOM); i--) {
    if (!marker.test(plain[i]!) || !RULE.test(plain[i - 1]!)) continue;
    let end = i + 1;
    while (end < plain.length && !RULE.test(plain[end]!)) end++;
    if (end >= plain.length) return "unread"; // no rule closes it: not the box as drawn
    const head = after(lines[i]!, marker);
    if (!head) return "unread";
    const rest = plain.slice(i + 1, end).map((l) => l.replace(BORDER, "").trim()).filter(Boolean);
    if (!rest.length && (!head.text || head.look === "placeholder")) return "empty";
    return "draft";
  }
  return "unread";
}

function codex(all: string[]): Box {
  const lines = trimmed(all);
  const plain = lines.map((l) => stripAnsi(l));
  const marker = /^\s*›(?= |$) ?/u;
  for (let i = plain.length - 1; i >= Math.max(0, plain.length - BOTTOM); i--) {
    if (!marker.test(plain[i]!)) continue;
    // Below the box: its continuation and the footer, each indented, or blank; a cell of the history is not.
    if (plain.slice(i + 1).some((l) => l.trim() && !/^\s{2}/.test(l))) return "unread";
    const head = after(lines[i]!, marker);
    if (!head) return "unread";
    if (head.text && head.look !== "placeholder") return "draft";
    // Empty only when its first line shows the placeholder: a bare `›` may open a draft whose first lines are
    // empty (Ctrl-J), its text further down among lines that look like the footer's.
    return head.text && head.look === "placeholder" ? "empty" : "unread";
  }
  return "unread";
}

export function boxOf(kind: string, lines: string[]): Box {
  if (kind === "claude") return claude(lines);
  if (kind === "codex") return codex(lines);
  return "unread";
}
