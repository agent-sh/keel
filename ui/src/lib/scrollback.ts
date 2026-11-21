// What the terminal pane keeps of a running command's output while it
// follows it: the newest SHOWN characters. A command that prints for hours
// would otherwise grow the page without end, and every new line would be
// parsed for colors together with all the lines before it. The whole output
// stays in the command's log on disk.
export const SHOWN = 256 * 1024;
// Cut when the text passed the budget by a quarter, not at every line added.
const SLACK = SHOWN / 4;

const SGR = /\x1b\[([0-?]*)m/g;
// An escape sequence that starts at the text's start (a color, a cursor move, a title).
const SEQUENCE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78DEHMNOc])/;

// The text with its oldest part let go once it is over the budget, and how
// many characters went. The cut is at a line's start when one is near, never
// inside an escape sequence or between the halves of a character, and the
// colors in force at the cut lead what is kept, so its first lines look as
// they did.
export function bounded(text: string, max = SHOWN, slack = max === SHOWN ? SLACK : max / 4): { text: string; cut: number } {
  if (text.length <= max + slack) return { text, cut: 0 };
  let at = text.length - max;
  const line = text.indexOf("\n", at);
  if (line >= 0 && line - at < 4096) at = line + 1;
  else {
    // A sequence that began before the cut and ends after it goes whole; one
    // with no end in reach (a title or a link that never closed) stays whole
    // in what is kept, from its start.
    const esc = text.lastIndexOf("\x1b", at - 1);
    if (esc >= 0 && at - esc < 8192) {
      const m = SEQUENCE.exec(text.slice(esc, esc + 16384));
      if (m && esc + m[0].length > at) at = esc + m[0].length;
      else if (!m && text.charCodeAt(esc + 1) === 0x5d) at = esc;
    }
    const c = text.charCodeAt(at);
    if (c >= 0xdc00 && c <= 0xdfff) at++; // the second half of a character
  }
  // The color codes since the last reset in what goes.
  let carry: string[] = [];
  const gone = text.slice(0, at);
  SGR.lastIndex = 0;
  for (let m = SGR.exec(gone); m; m = SGR.exec(gone)) {
    if (m[1] === "" || m[1]!.split(/[;:]/)[0] === "0" || m[1] === "0") carry = [];
    carry.push(m[0]);
    if (carry.length > 16) carry.shift();
  }
  const lead = carry.length === 1 && /^\x1b\[0?m$/.test(carry[0]!) ? "" : carry.join("");
  return { text: lead + text.slice(at), cut: at };
}
