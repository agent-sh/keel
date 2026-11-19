// Terminal output as styled runs: SGR color and weight codes become segments,
// every other escape sequence is dropped and carriage-return redraws keep
// their last frame. The 16 named colors map to the theme's tokens; 256-color
// and true-color codes keep the color the program asked for.

export type Seg = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean };

// Black, red, green, yellow, blue, magenta, cyan, white; bright ones share them.
const NAMED = ["var(--muted)", "var(--danger)", "var(--ok)", "var(--warn)", "var(--syn-function)", "var(--syn-keyword)", "var(--syn-type)", "var(--fg)"];

function xterm(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return NAMED[n % 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))}, ${c(Math.floor(i / 6) % 6)}, ${c(i % 6)})`;
}

type Style = Omit<Seg, "text">;

function apply(st: Style, params: number[]): Style {
  const s = { ...st };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) { for (const k of Object.keys(s)) delete (s as any)[k]; }
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) s.fg = NAMED[p % 10];
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) s.bg = NAMED[p % 10];
    else if (p === 39) delete s.fg;
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) { const c = xterm(params[i + 2] ?? -1); if (c) s[key] = c; i += 2; }
      else if (params[i + 1] === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if ([r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255)) s[key] = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
    }
  }
  for (const k of Object.keys(s) as (keyof Style)[]) if (s[k] === false || s[k] === undefined) delete s[k];
  return s;
}

const same = (a: Style, b: Style) => a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline;

// Carriage returns inside a line: what a progress bar drew last.
function lastFrames(s: string): string {
  return s.replace(/\r\n/g, "\n").split("\n").map((l) => {
    const t = l.replace(/\r+$/, "");
    const i = t.lastIndexOf("\r");
    return i < 0 ? t : t.slice(i + 1);
  }).join("\n");
}

export function parseAnsi(input: string): Seg[] {
  const s = lastFrames(input)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (titles, links)
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOc]/g, "");
  const out: Seg[] = [];
  let st: Style = {};
  const push = (text: string) => {
    if (!text) return;
    const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
    if (!clean) return;
    const last = out[out.length - 1];
    if (last && same(last, st)) last.text += clean;
    else out.push({ text: clean, ...st });
  };
  const re = /\x1b\[([0-?]*)[ -/]*([@-~])/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    push(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== "m") continue; // cursor moves, erases: dropped
    const params = m[1] === "" ? [0] : m[1]!.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
    st = apply(st, params);
  }
  push(s.slice(at));
  return out;
}

export const stripAnsiText = (s: string) => parseAnsi(s).map((x) => x.text).join("");
