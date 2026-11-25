// What a write to a terminal types, read as a person's keys at a line editor: which lines the write completes
// (each Enter ends one), what stays in the line for the next write, and whether a line's text is known.
//
// A shell on a terminal runs a line when Enter arrives, and until then the keys only edit it. Keel judges the line
// that runs, so it follows the editing keys a shell's line editor (readline) has: characters insert at the cursor,
// Backspace, Delete, Ctrl-U, Ctrl-K and Ctrl-W remove text, Ctrl-A, Ctrl-E and the arrow keys move the cursor,
// Ctrl-C drops the line, a bracketed paste (ESC [ 200 ~ ... ESC [ 201 ~) holds Enter keys as text. Keys that
// bring text from somewhere Keel does not see (history, completion, the kill ring, a search, a quoted insert, an
// Alt key) leave the line `unsure`: what runs is not what was typed, so the line is not read as a command.
// Keys that touch no line (Ctrl-D on an empty line, Ctrl-Z, Ctrl-\, Ctrl-L) pass.

export type Typing = {
  readonly text: readonly string[]; // the line so far, one code point each
  readonly at: number;              // the cursor
  readonly unsure: boolean;
  readonly paste: boolean;          // inside a bracketed paste
  readonly esc: string;             // an escape sequence the last write left unfinished
  readonly n: number;               // how many writes made it (a write is judged from one value of it)
};

export const EMPTY: Typing = { text: [], at: 0, unsure: false, paste: false, esc: "", n: 0 };

export type TypedLine = { text: string; unsure: boolean };

const ESC_MAX = 24;

// What a finished escape sequence does: a move of the cursor, a delete, the edges of a paste, or nothing known.
type Key = "left" | "right" | "home" | "end" | "delete" | "paste" | "pasted" | "unknown";

// The key of an escape sequence, or undefined while it is not finished.
function keyOfEscape(esc: string): Key | undefined {
  if (esc.length < 2) return undefined;
  const kind = esc[1]!;
  if (kind === "O") {
    if (esc.length < 3) return undefined;
    return { C: "right", D: "left", H: "home", F: "end" }[esc[2]!] as Key | undefined ?? "unknown";
  }
  if (kind !== "[") return "unknown"; // Alt and a key: a word moved, killed or changed
  const last = esc.charCodeAt(esc.length - 1);
  if (esc.length === 2 || last < 0x40 || last > 0x7e) return undefined; // parameters and intermediates go on
  const params = esc.slice(2, -1);
  const final = esc[esc.length - 1]!;
  if (final === "~") return ({ "3": "delete", "1": "home", "7": "home", "4": "end", "8": "end", "200": "paste", "201": "pasted" } as Record<string, Key>)[params] ?? "unknown";
  if (params === "") return ({ C: "right", D: "left", H: "home", F: "end" } as Record<string, Key>)[final] ?? "unknown";
  return "unknown"; // up and down (history), a modifier on an arrow (a word moved), the rest
}

// `opens`: the write holds the start of a bracketed paste (or one was open before it). Only a line editor that honours the
// markers (readline in bash, zsh and fish) holds Enter keys inside it as text; dash and sh read ESC [ 200 ~ as keys and
// run what follows, so for any other shell a paste is a write that is asked about (typed.ts).
export function step(from: Typing, chars: string): { lines: TypedLine[]; next: Typing; opens: boolean } {
  let opens = from.paste;
  let text = [...from.text], at = from.at, unsure = from.unsure, paste = from.paste, esc = from.esc;
  const lines: TypedLine[] = [];
  const insert = (c: string) => { text.splice(at, 0, c); at++; };
  const reset = () => { text = []; at = 0; unsure = false; };
  const done = () => { if (text.length || unsure) lines.push({ text: text.join(""), unsure }); reset(); };
  for (const c of chars) {
    if (esc) {
      esc += c;
      const key = keyOfEscape(esc);
      if (key === undefined && esc.length <= ESC_MAX) continue;
      const esc0 = esc[1];
      esc = "";
      // Inside a paste only its end is a key; anything else the text carried is not kept, so the line is not known.
      if (paste && key !== "pasted") { unsure = true; continue; }
      switch (key) {
        case "left": at = Math.max(0, at - 1); break;
        case "right": at = Math.min(text.length, at + 1); break;
        case "home": at = 0; break;
        case "end": at = text.length; break;
        case "delete": if (at < text.length) text.splice(at, 1); break;
        case "paste": paste = true; opens = true; break;
        case "pasted": paste = false; break;
        default:
          unsure = true;
          // Alt and Enter: no line editor binds it, but a program may take it for Enter.
          if (esc0 === "\r" || esc0 === "\n") done();
      }
      continue;
    }
    if (c === "\x1b") { esc = c; continue; }
    // A pasted text is the line's text, control characters and Enter keys included.
    if (paste) { insert(c); continue; }
    const code = c.codePointAt(0)!;
    if (c === "\r" || c === "\n") done();
    else if (c === "\x7f" || c === "\b") { if (at > 0) { text.splice(at - 1, 1); at--; } }
    else if (c === "\x03") reset();
    else if (c === "\x04") { if (at < text.length) text.splice(at, 1); }
    else if (c === "\x15") { text.splice(0, at); at = 0; }
    else if (c === "\x0b") text.splice(at);
    else if (c === "\x17") {
      let to = at;
      while (to > 0 && /\s/.test(text[to - 1]!)) to--;
      while (to > 0 && !/\s/.test(text[to - 1]!)) to--;
      text.splice(to, at - to);
      at = to;
    }
    else if (c === "\x01") at = 0;
    else if (c === "\x05") at = text.length;
    else if (c === "\x02") at = Math.max(0, at - 1);
    else if (c === "\x06") at = Math.min(text.length, at + 1);
    else if (c === "\x0c" || c === "\x1a" || c === "\x1c" || c === "\x00" || c === "\x07") { /* touches no line */ }
    else if (code < 0x20 || (code >= 0x80 && code < 0xa0)) unsure = true; // Tab (completion), Ctrl-Y, Ctrl-T, Ctrl-R, Ctrl-V...
    else insert(c);
  }
  return { lines, next: { text, at, unsure, paste, esc, n: from.n + 1 }, opens };
}
