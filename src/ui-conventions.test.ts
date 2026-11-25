// The look is one system: what the stylesheets and components may write is
// checked over the UI source, so a second scale or a fifth face cannot come
// back. The checks read the source the way it is built: comments are not
// code, a rule is its selector and its declarations wherever its lines break,
// a class list is its classes, a call is its arguments. Each check is a
// function of file texts, run over the tree and over small fixtures of what
// it must refuse and what it must let through.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { OFFLINE, QUEUED, STATE_WORD } from "./core/state-words.ts";
import { sectionsIn } from "../ui/src/lib/settings-find.macro.ts";

type Src = { file: string; text: string };
const UI = join(import.meta.dir, "../ui/src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? files(p) : [p];
  });
}
const read = (dir: string, paths: string[], ext: RegExp): Src[] => paths.filter((f) => ext.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => ({ file: relative(dir, f), text: readFileSync(f, "utf8") }));
const ui = files(UI);
const sheets = read(UI, ui, /\.css$/);
const page = read(UI, ui, /\.tsx?$/);
const daemon = read(import.meta.dir, files(import.meta.dir), /\.ts$/);

// ---------- Reading the source ----------

// Every check reads the same source snapshot. Parse each distinct text once.
function remember<T>(read: (text: string) => T): (text: string) => T {
  const kept = new Map<string, T>();
  return (text) => {
    const got = kept.get(text);
    if (got !== undefined) return got;
    const value = read(text);
    kept.set(text, value);
    return value;
  };
}

// The text with its comments blanked (line and block, in CSS, TypeScript and
// JSX), every other character and every line break in its place. Strings,
// templates and regular expressions are kept: a `//` inside one is not a
// comment. A quote opens a string only when it closes on its line, so an
// apostrophe in JSX text does not swallow what follows it.
const tsCode = remember((text) => withoutComments(text, false));
const cssCode = remember((text) => withoutComments(text, true));
const code = (text: string, css = false) => (css ? cssCode : tsCode)(text);
function withoutComments(text: string, css: boolean): string {
  if (!text.includes("/*") && (css || !text.includes("//"))) return text;
  const out: string[] = [];
  let i = 0, copied = 0;
  const blank = (to: number) => {
    out.push(text.slice(copied, i), text.slice(i, to).replace(/[^\n]/g, " "));
    copied = i = to;
  };
  // The end of a quoted run that starts at `from` (its quote), or -1 when it does not close.
  const closes = (from: number, quote: string, lines: boolean) => {
    for (let j = from + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === quote) return j;
      else if (text[j] === "\n" && !lines) return -1;
    }
    return -1;
  };
  // A slash opens a regular expression where a value may begin; it ends on its line.
  const regex = (from: number) => {
    let k = from;
    while (k > 0 && /\s/.test(text[k - 1]!)) k--;
    const before = text.slice(Math.max(0, k - 7), k);
    if (!/[(,=:[!&|?{;]$|\breturn$|^$/.test(before)) return -1;
    let set = false;
    for (let j = from + 1; j < text.length && text[j] !== "\n"; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === "[") set = true;
      else if (text[j] === "]") set = false;
      else if (text[j] === "/" && !set) return j;
    }
    return -1;
  };
  // Between quotes and slashes there is nothing to do. Scan spans, not characters.
  const specials = /["'`/]/g;
  for (;;) {
    specials.lastIndex = i;
    const found = specials.exec(text);
    if (!found) break;
    i = found.index;
    const c = found[0], next = text[i + 1];
    let end = -1;
    if (c === "/" && next === "*") {
      end = text.indexOf("*/", i + 2);
      blank(end < 0 ? text.length : end + 2);
    } else if (!css && c === "/" && next === "/" && text[i - 1] !== ":") {
      end = text.indexOf("\n", i);
      blank(end < 0 ? text.length : end);
    } else if ((c === '"' || c === "'") && (end = closes(i, c, css)) > 0) i = end + 1;
    else if (!css && c === "`" && (end = closes(i, c, true)) > 0) i = end + 1;
    else if (!css && c === "/" && (end = regex(i)) > 0) i = end + 1;
    else i++;
  }
  return out.length ? out.join("") + text.slice(copied) : text;
}
// A line lookup must not split the entire prefix for each declaration or
// string. Index line ends once, then use the number strictly before `at`.
const lineEnds = remember((text) => {
  const ends: number[] = [];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) ends.push(i);
  return ends;
});
function lineOf(text: string, at: number) {
  const ends = lineEnds(text);
  let lo = 0, hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ends[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

// A stylesheet as its rules: the selector (or the at-rule, for one that holds
// declarations itself, as @theme does), the at-rules around it, and its
// declarations, each with the line it starts on.
type Rule = { selector: string; line: number; within: string[]; decls: { prop: string; value: string; line: number }[] };
const rules = remember((text): Rule[] => {
  const css = code(text, true);
  const out: Rule[] = [];
  const stack: { at: string; rule?: Rule }[] = [];
  let start = 0, paren = 0;
  const declare = (rule: Rule | undefined, from: number, to: number) => {
    const d = css.slice(from, to), colon = d.indexOf(":");
    if (rule && colon > 0 && d.trim()) rule.decls.push({ prop: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim().replace(/\s+/g, " "), line: lineOf(css, from + d.search(/\S/)) });
  };
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (paren) continue;
    else if (c === "{") {
      const prelude = css.slice(start, i).trim();
      const rule: Rule = { selector: prelude.replace(/\s+/g, " "), line: lineOf(css, start + css.slice(start, i).search(/\S/)), within: stack.map((s) => s.at).filter(Boolean), decls: [] };
      out.push(rule);
      stack.push({ at: prelude.startsWith("@") ? prelude : "", rule });
      start = i + 1;
    } else if (c === ";") { declare(stack.at(-1)?.rule, start, i); start = i + 1; }
    else if (c === "}") { declare(stack.at(-1)?.rule, start, i); stack.pop(); start = i + 1; }
  }
  return out;
});

// The string literals of a module (quoted, and the fixed parts of a
// template), each with its line: where class lists and inline values live.
const strings = remember((text): { value: string; line: number }[] => {
  const src = code(text);
  const out: { value: string; line: number }[] = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const value = m[1] ?? m[2] ?? (m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    out.push({ value, line: lineOf(src, m.index!) });
  }
  return out;
});
// A string is a class list when every word of it could be a class: prose (a
// capital, a full stop, a comma) is not, so a sentence that names a utility is
// not a use of it.
const classList = (value: string) => { const w = value.split(/\s+/).filter(Boolean); return w.length > 0 && w.every((c) => /^[a-z0-9@!*&[-](\S*[^\s.,;?])?$/.test(c)) ? w : []; };
// Every class named in a module: the words of its class lists.
const classes = remember((text) => strings(text).flatMap((s) => classList(s.value).map((c) => ({ c, line: s.line }))));

// The opening tag around a position, wherever its lines break: where a
// component says what an element is and which classes it carries.
function tag(src: string, pos: number): string {
  let a = pos;
  do { a = src.lastIndexOf("<", a - 1); } while (a >= 0 && !(/^<[A-Za-z]/.test(src.slice(a, a + 2)) && src.slice(a, pos).split("{").length === src.slice(a, pos).split("}").length));
  if (a < 0) return "";
  let depth = 0, b = a;
  for (; b < src.length; b++) {
    if (src[b] === "{") depth++;
    else if (src[b] === "}") depth--;
    else if (src[b] === ">" && !depth && src[b - 1] !== "=") break;
  }
  return src.slice(a, b + 1);
}

// The calls of a method in a module, with their whole argument text wherever it breaks.
function calls(text: string, name: RegExp): { args: string; line: number; before: string }[] {
  const src = code(text);
  const out: { args: string; line: number; before: string }[] = [];
  for (const m of src.matchAll(new RegExp(`(${name.source})\\s*\\(`, "g"))) {
    let depth = 1, i = m.index! + m[0].length;
    const from = i;
    for (; i < src.length && depth; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
    out.push({ args: src.slice(from, i - 1), line: lineOf(src, m.index!), before: src.slice(Math.max(0, m.index! - 60), m.index!) });
  }
  return out;
}
const at = (s: Src, line: number, what: string) => `${s.file}:${line}: ${what}`;

// ---------- The checks ----------

// A text size in a stylesheet is a token, the parent's, or nothing. Three are
// set for a reason of their own: the root (the owner's text size), inputs on a
// phone (iOS zooms under 16 px) and the math faces (set by eye). A superscript
// or subscript is sized against its line.
function sheetSizes(list: Src[]): string[] {
  // (A size that moves with the width between two steps of the scale is the scale's: min(step, max(step, Nvw)).)
  const size = /^(var\(--text-[a-z]+\)|min\(var\(--text-[a-z]+\), max\(var\(--text-[a-z]+\), [\d.]+vw\)\)|inherit|0|calc\(1[67]px \* var\(--ui-scale, 1\)\)|max\(16px, 1rem\) !important|1\.08em)$/;
  const out: string[] = [];
  for (const s of list) for (const r of rules(s.text)) for (const d of r.decls) {
    if (d.prop === "font-size" && !size.test(d.value) && !(/(^|[\s>+~,])su[pb]\b/.test(r.selector) && /^[\d.]+em$/.test(d.value))) out.push(at(s, d.line, `font-size: ${d.value}`));
    if (d.prop === "font" && !/^(normal )?([1-9]00 )?var\(--text-[a-z]+\)(\/[\d.a-z]+)? var\(--font-(sans|mono)\)$/.test(d.value)) out.push(at(s, d.line, `font: ${d.value}`));
  }
  return out;
}

// A corner in a stylesheet is a step of the scale (--radius-*), a pill (999px, 50%, or as
// tall as a control: a switch's track), a hairline (1px, 2px) or none. A motion's length is a
// step of its own (--dur-*), the reduced-motion stop (1ms) or a length that waits on purpose
// (400 ms and longer).
function sheetCorners(list: Src[]): string[] {
  const corner = /^(var\(--radius-[a-z0-9]+\)|var\(--spacing-ctl-[a-z]+\)|999px|50%|0|1px|2px)$/;
  const out: string[] = [];
  for (const s of list) for (const r of rules(s.text)) for (const d of r.decls) {
    if (/^border(-[a-z]+)*-radius$/.test(d.prop) && !d.value.replace(/\s*!important$/, "").split(/\s+(?![^(]*\))/).every((v) => corner.test(v))) out.push(at(s, d.line, `${d.prop}: ${d.value}`));
    if (/^(transition|animation)(-duration)?$/.test(d.prop)) for (const m of d.value.matchAll(/(?<![\w.-])(\d+)ms\b/g)) if (Number(m[1]) > 1 && Number(m[1]) < 400) out.push(at(s, d.line, `${d.prop}: ${m[0]}`));
  }
  return out;
}

// A component's motion and its backdrop come from the tokens as well: no length of
// Tailwind's own (duration-150; a length is duration-(--dur-move), or none for quick)
// and no backdrop of black or white (bg-overlay is the theme's own).
function pageMotion(list: Src[]): string[] {
  const out: string[] = [];
  for (const s of list) for (const { c, line } of classes(s.text)) {
    const name = c.split(":").at(-1)!;
    if (/^duration-(\d+|\[)/.test(name)) out.push(at(s, line, c));
    if (/^bg-(black|white)\/\d+$/.test(name)) out.push(at(s, line, c));
  }
  return out;
}

// A class is drawn by one stylesheet: two that each write a rule of that name alone
// (outside a media query) set one element in two looks, and the later file wins
// wherever both load. (A list of classes that share a role, as the faces in
// styles.css, is not a class's own rule.)
function twiceDrawn(list: Src[]): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const s of list) for (const r of rules(s.text)) {
    if (r.within.some((w) => w.startsWith("@media") || w.startsWith("@container"))) continue;
    const name = r.selector.trim();
    if (!/^\.k-[\w-]+$/.test(name)) continue;
    const first = seen.get(name);
    if (first === undefined) seen.set(name, s.file);
    else if (first !== s.file) out.push(at(s, r.line, `${name} (also in ${first})`));
  }
  return out;
}

// A component's corner is a step of the scale by its name (rounded-sm, rounded-t-md),
// the bare rounded (the theme sets it to sm), a pill or none: no corner of
// Tailwind's own beyond the scale (3xl, 4xl) and no arbitrary one but a token.
function pageCorners(list: Src[]): string[] {
  const step = /^rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(xs|sm|md|lg|xl|2xl|full|none|\[var\(--radius-[a-z0-9]+\)\]))?$/;
  const out: string[] = [];
  for (const s of list) for (const { c, line } of classes(s.text)) {
    const name = c.split(":").at(-1)!.replace(/^!/, "");
    if (/^rounded(-|$)/.test(name) && !step.test(name)) out.push(at(s, line, c));
  }
  return out;
}

// A secondary button is .k-btn and a line to type in is .k-field: a class list
// that draws an outlined button of its own (a height, a hairline, the hover well)
// or a field with a focus colour of its own is refused. A round icon button (a
// pill) keeps its own look.
function handMade(list: Src[]): string[] {
  const out: string[] = [];
  for (const s of list) for (const v of strings(s.text)) {
    const w = classList(v.value);
    if (!w.length || w.includes("k-btn") || w.includes("k-field")) continue;
    const base = w.map((c) => c.replace(/^!/, ""));
    const has = (re: RegExp) => base.some((c) => re.test(c));
    if (has(/^h-(6|7|8|ctl-(sm|md|lg))$/) && has(/^border$/) && has(/^border-line(-strong)?$/) && has(/^hover:bg-hover$/) && !has(/^rounded-full$/)) out.push(at(s, v.line, `a button of its own: ${v.value.slice(0, 60)}`));
    // (A box that scrolls or holds a column, focusable to be read, is not a field.)
    else if (has(/^outline-none$/) && has(/^(focus|focus-visible):border-/) && has(/^border$/) && !has(/^(overflow-auto|flex-col)$/)) out.push(at(s, v.line, `a field of its own: ${v.value.slice(0, 60)}`));
  }
  // A quote's rule is .k-quote (styles.css): no left rule of its own.
  for (const s of list) for (const { c, line } of classes(s.text)) if (/^border-l-(2|\[2px\])$/.test(c.split(":").at(-1)!)) out.push(at(s, line, `a quote rule of its own: ${c}`));
  // A Select is a field already (Select.tsx): its classes give it a width, not a look. Its
  // className is read whole: strings, and the module's constants it names (cn(SELECT, "w-80")).
  for (const s of list) {
    const src = code(s.text);
    const consts = new Map([...s.text.matchAll(/^const (\w+) = "([^"]*)";/gm)].map((m) => [m[1]!, m[2]!]));
    for (const m of src.matchAll(/<Select\b/g)) {
      const t = tag(src, m.index! + 1);
      const attr = t.match(/className=("[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\})/)?.[1] ?? "";
      const cls = [...attr.matchAll(/"([^"]*)"|\b([A-Za-z_]\w*)\b/g)].map((x) => x[1] ?? consts.get(x[2]!) ?? "").join(" ");
      if (cls.split(/\s+/).some((c) => /^(h-[6-9]|border(-line(-strong)?)?|rounded(-\w+)?|bg-(raised|sunken|bg)|px-[\d.]+|k-field)$/.test(c))) out.push(at(s, lineOf(src, m.index!), `a select drawn on its own: ${cls.slice(0, 60)}`));
    }
  }
  return out;
}

// The conversation has one strong rule, the rail of work (.k-step): the owner's words are a tint,
// Keel's own lines a hairline. Code in a sentence is a tint, not a box. What the harness brings in
// (TranscriptExtras.tsx, Words.tsx) is a line, never a card: no shadow, no dashed box.
// A rule is wide when it is over 2px, by any spelling: a left or inline-start border, an inset shadow,
// a Tailwind left border. Only the step itself draws one: a selector whose last compound is .k-step,
// with or without a state (`.k-step[data-x]`, `.k-step:hover`), never `.k-step-foo` or `.k-step .x`.
const REM_PX = 16;
const KEYWORD_PX: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
// The lengths of a value in px, in their order: what a function holds (a color, a var()) is not a length.
// A calc(), min(), max() or clamp() is a length too: worked out with a var() as nothing (the widest a
// min, a max or a clamp can be is what counts).
const LEN = /(?<![\w.-])(-?\d*\.?\d+)(px|rem|em)(?![\w%.-])/g;
function worked(name: string, body: string): string {
  const px = (x: string) => x.replace(LEN, (_, n, u) => String(u === "px" ? Number(n) : Number(n) * REM_PX));
  const one = (x: string) => { const e = px(x).trim(); return /^[\d.\s+\-*/()]+$/.test(e) ? Number(new Function(`return (${e})`)()) : NaN; };
  const n = name === "calc" ? one(body) : Math.max(...body.split(",").map(one));
  return Number.isFinite(n) ? ` ${Math.abs(n)}px ` : " ";
}
function lengthsPx(v: string): number[] {
  let bare = v.replace(/var\([^()]*\)/g, "0px");
  for (let was = ""; was !== bare;) { was = bare; bare = bare.replace(/([\w-]*)\(([^()]*)\)/g, (_, name: string, body: string) => (/^(calc|min|max|clamp)$/.test(name) ? worked(name, body) : " ")); }
  const out: number[] = [];
  for (const m of bare.matchAll(/(?<![\w.-])(-?\d*\.?\d+)(px|rem|em)?(?![\w%.-])|\b(thin|medium|thick)\b/g)) {
    if (m[3]) { out.push(KEYWORD_PX[m[3]]!); continue; }
    const n = Math.abs(Number(m[1]));
    if (!m[2] && n !== 0) continue;
    out.push(m[2] === "px" ? n : n * REM_PX);
  }
  return out;
}
const lastCompound = (sel: string) => sel.trim().split(/\s*[\s>+~]\s*/).at(-1) ?? "";
const theStep = (selector: string) => selector.split(",").every((part) => /^\.k-step(?=[[:]|$)/.test(lastCompound(part)));
function wideRule(prop: string, value: string): boolean {
  if (/^border-(left|inline-start)(-width)?$/.test(prop)) return lengthsPx(value).some((n) => n > 2);
  // An inset shadow is a rule when an offset stands for it (inset 3px 0 0 ...): its offsets, not its blur.
  if (prop === "box-shadow") return value.split(/,(?![^(]*\))/).some((sh) => /\binset\b/.test(sh) && lengthsPx(sh.replace(/\binset\b/, "")).slice(0, 2).some((n) => n > 2));
  return false;
}
const twWide = (c: string) => {
  const m = /^border-(?:l|s)(?:-(\d+)|-\[([^\]]+)\])?$/.exec(c);
  if (!m) return false;
  return m[1] ? Number(m[1]) > 2 : m[2] ? lengthsPx(m[2]).some((n) => n > 2) : false;
};
function voices(sheets: Src[], page: Src[]): string[] {
  const out: string[] = [];
  for (const s of sheets) for (const r of rules(s.text)) for (const d of r.decls) {
    if (s.file === "transcript.css" && wideRule(d.prop, d.value) && !theStep(r.selector)) out.push(at(s, d.line, `${r.selector} { ${d.prop}: ${d.value} }`));
    if (/\.prose-keel :not\(pre\) > code$/.test(r.selector) && /^border(-(top|right|bottom|left))?(-(width|style))?$/.test(d.prop) && !/^(0|none)$/.test(d.value)) out.push(at(s, d.line, `${r.selector} { ${d.prop} }`));
  }
  for (const s of page) if (/^components\/(automation\/TranscriptExtras|Words)\.tsx$/.test(s.file)) for (const { c, line } of classes(s.text)) {
    const bare = c.split(":").at(-1)!;
    if (/^(shadow-[1-3]|border-dashed)$/.test(bare) || twWide(bare)) out.push(at(s, line, c));
  }
  return out;
}

// A component takes its text size from the scale: none of Tailwind's own
// sizes, no arbitrary size by any spelling, no inline size but a token (the
// text-size setting's samples show each size).
function pageSizes(list: Src[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    for (const { c, line } of classes(s.text)) {
      const name = c.split(":").at(-1)!;
      if (/^text-(xs|sm|lg|xl|[2-9]xl)$/.test(name)) out.push(at(s, line, c));
      else if (/^text-\[(length:)?[\d.]/.test(c.replace(/^([a-z-]+:)*/, "")) || /\[font-size:(?!var\(--text-[a-z]+\)\])/.test(c) || /\[font:/.test(c)) out.push(at(s, line, c));
    }
    const src = code(s.text);
    for (const m of src.matchAll(/\bfontSize\s*[:=]\s*([^,;}\n]+)/g)) {
      const value = m[1]!.trim();
      if (!/^["'`]var\(--text-[a-z]+\)["'`]$/.test(value) && s.file !== "components/Settings.tsx") out.push(at(s, lineOf(src, m.index!), `fontSize: ${value}`));
    }
  }
  return out;
}

// The instrument face is named by the role rules of styles.css (and the theme
// token that defines it) and nowhere else.
function face(list: Src[], pageList: Src[]): { roles: number; strays: string[] } {
  let roles = 0;
  const strays: string[] = [];
  for (const s of list) for (const r of rules(s.text)) for (const d of r.decls) {
    if (!/font-inst|Martian/.test(d.value)) continue;
    if (s.file === "styles.css" && d.prop === "font-family" && d.value.startsWith("var(--font-inst)")) roles++;
    else if (!(s.file === "styles.css" && d.prop === "--font-inst")) strays.push(at(s, d.line, `${d.prop}: ${d.value}`));
  }
  for (const s of pageList) {
    if (s.file === "lib/fonts.ts") continue; // it loads the face
    for (const { c, line } of classes(s.text)) if (/(^|:)font-inst$|--font-inst|^Martian/.test(c)) strays.push(at(s, line, c));
  }
  return { roles, strays };
}

// Tabs, a segmented choice and a filter are components/Seg.tsx: no other
// module draws a track or writes a tab or a radio of that kind, and the
// track's rule styles its buttons only.
function segmented(pageList: Src[], sheetList: Src[]): string[] {
  const out: string[] = [];
  for (const s of pageList) {
    if (s.file === "components/Seg.tsx") continue;
    const src = code(s.text);
    for (const { c, line } of classes(s.text)) if (c === "k-seg") out.push(at(s, line, "k-seg"));
    // An attribute of an element (not a selector in a string), written out or by an expression.
    // (A question card's options are its answer: one or several of a list, by the question.)
    if (s.file !== "components/QuestionCard.tsx") for (const m of src.matchAll(/(?<![[\w-])role=(["'](tablist|tab|radio)["']|\{[^}]*["'](tablist|tab|radio)["'][^}]*\})|<Tabs\.(List|Tab)\b/g)) out.push(at(s, lineOf(src, m.index!), m[0].slice(0, 40)));
  }
  for (const s of sheetList) for (const r of rules(s.text)) {
    if (/\.k-tabs\b/.test(r.selector) || (/\.k-seg\b/.test(r.selector) && s.file !== "styles.css" && !/\.k-seg\.k-[\w-]+ > button$/.test(r.selector))) out.push(at(s, r.line, r.selector));
    for (const part of r.selector.split(",")) if (/\.k-seg(\.[\w-]+)?(\[[^\]]*\])? > (?!button\b)/.test(part)) out.push(at(s, r.line, r.selector));
  }
  return out;
}

// The panel color is the frame (the rail, the phone dock) and nothing else.
function steel(pageList: Src[], sheetList: Src[]): string[] {
  const out: string[] = [];
  for (const s of pageList) for (const { c, line } of classes(s.text)) if (/(^|:)bg-panel(\/\d+)?$/.test(c)) out.push(at(s, line, c));
  for (const s of sheetList) for (const r of rules(s.text)) for (const d of r.decls) {
    if (d.value.includes("var(--panel)") && !/\.k-rail\b|\.k-where-pip\b|\.k-dock\b|\.k-pane-map\b/.test(r.selector) && d.prop !== "--color-panel") out.push(at(s, d.line, `${r.selector} { ${d.prop} }`));
  }
  return out;
}

// Nothing-to-show is k-empty: no module centers quiet text of its own, and no
// stylesheet keeps an empty state of its own. (A chart says it in its plot;
// the transcript's notes from the harness are centered lines, not empties.)
function empties(pageList: Src[], sheetList: Src[]): string[] {
  const out: string[] = [];
  for (const s of pageList) {
    if (s.file === "components/Chart.tsx" || s.file === "components/Transcript.tsx") continue;
    // One class list, or the lists one cn() joins.
    const lists = [...strings(s.text).map((x) => ({ words: classList(x.value), line: x.line })), ...calls(s.text, /\bcn/).map((c) => ({ words: strings(c.args).flatMap((x) => classList(x.value)), line: c.line }))];
    for (const { words, line } of lists) {
      const c = new Set(words);
      if (c.has("text-center") && (c.has("text-ui") || c.has("text-caption") || c.has("text-micro")) && (c.has("text-faint") || c.has("text-muted")) && !c.has("k-empty")) out.push(at(s, line, words.join(" ").slice(0, 60)));
    }
  }
  for (const s of sheetList) for (const r of rules(s.text)) if (/\.k-(blank|picker-empty|ledger-empty)\b/.test(r.selector)) out.push(at(s, r.line, r.selector));
  return out;
}

// A time is on the 24-hour clock. The page formats one through when() and
// clock() in lib/utils.ts and nowhere else; the daemon names the clock in
// every formatter of its own.
function pageTimes(list: Src[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (s.file === "lib/utils.ts" || !mayFormatTime(s.text)) continue;
    for (const c of calls(s.text, /\.toLocaleTimeString/)) out.push(at(s, c.line, "toLocaleTimeString"));
    for (const c of calls(s.text, /\.toLocaleString/)) if (/\b(hour|timeStyle)\b/.test(c.args) || (!c.args.trim() && /Date\([^()]*\)\s*$/.test(c.before))) out.push(at(s, c.line, "toLocaleString with a time"));
    for (const c of calls(s.text, /Intl\.DateTimeFormat/)) if (/\b(hour|minute|second|timeStyle)\b/.test(c.args)) out.push(at(s, c.line, "Intl.DateTimeFormat with a time"));
  }
  return out;
}
// Blanking comments cannot add these names. Skip the parse of sources that
// do not mention a formatter at all, especially on the daemon side.
const mayFormatTime = (text: string) => /\.toLocale(?:Time)?String|Intl\.DateTimeFormat/.test(text);
function daemonTimes(list: Src[]): string[] {
  const out: string[] = [];
  const named = (args: string) => /hourCycle:\s*["']h23["']/.test(args);
  for (const s of list) {
    if (!mayFormatTime(s.text)) continue;
    for (const c of calls(s.text, /\.toLocaleTimeString/)) if (!named(c.args)) out.push(at(s, c.line, "toLocaleTimeString without h23"));
    for (const c of calls(s.text, /\.toLocaleString|Intl\.DateTimeFormat/)) if (/\b(hour|timeStyle)\b/.test(c.args) && !named(c.args)) out.push(at(s, c.line, "a time without h23"));
  }
  return out;
}

// A stylesheet names a part by its own class. Own classes begin with k-, or
// are one of the few named here. Any other class that a component carries is
// a utility (or would be taken for one), and a selector may not lean on it; a
// class no component writes belongs to a library's markup and may be styled.
// A selector never reaches an element by its test id or by the words of its
// title or label.
const OWN = /^(k-[\w-]+|prose-keel|code-(block|head|lang|copy)|th-[a-z-]+|flash|row-cv|dark|theme-switch|math|sr-only|list-none|text-display|text-title|font-mono|animate-pulse-dot)$/;
function selectors(list: Src[], pageList: Src[] = []): string[] {
  const out: string[] = [];
  const carried = new Set(pageList.flatMap((s) => classes(s.text).map((x) => x.c.split(":").at(-1)!)));
  for (const s of list) for (const r of rules(s.text)) {
    if (r.selector.startsWith("@") || r.within.some((w) => w.startsWith("@keyframes"))) continue;
    for (const m of r.selector.matchAll(/\[(data-testid|title|aria-label)[^\]]*\]/g)) out.push(at(s, r.line, `${m[0]} in ${r.selector}`));
    for (const m of r.selector.matchAll(/(svg)?\.((?:\\.|[\w-])+)/g)) {
      const name = m[2]!.replace(/\\/g, "");
      // An icon in a state color keeps the fill: the one rule on a utility.
      if (OWN.test(name) || (m[1] && /^text-[a-z-]+$/.test(name)) || (pageList.length && !carried.has(name))) continue;
      out.push(at(s, r.line, `.${name} in ${r.selector}: name the part k-${name.replace(/[^\w-]/g, "")} (a bare class is a utility's name, or would be taken for one)`));
    }
  }
  return out;
}

// A section's label is k-label, the picked row of a list is k-picked and a
// switch is k-switch: none is drawn out again. (The rail's own rows and the
// branch tree mark the current one their own way.)
function shared(list: Src[]): string[] {
  const out: string[] = [];
  const rail = new Set(["components/Sidebar.tsx", "components/SidebarProjects.tsx", "components/Bridge.tsx", "components/BranchTree.tsx"]);
  for (const s of list) {
    const src = code(s.text);
    for (const { value, line } of strings(s.text)) {
      const c = new Set(classList(value));
      const quiet = c.has("text-faint") || c.has("text-muted"), small = c.has("text-micro") || c.has("text-caption");
      const chip = [...c].some((x) => /^(bg-|rounded)/.test(x));
      if (quiet && small && !chip && !c.has("k-label") && (c.has("uppercase") || c.has("font-medium") || c.has("font-semibold"))) out.push(at(s, line, `a label written out: ${value.slice(0, 50)}`));
      if (c.has("before:bg-accent") && [...c].some((x) => x.startsWith("before:w-"))) out.push(at(s, line, "a picked row's bar drawn by hand"));
    }
    // (A button that reads as a chip and says its state in words is pressed, not switched: it carries no thumb.)
    for (const m of src.matchAll(/(?<![[\w-])role=["']switch["']|<Switch\.Root\b/g)) { const t = tag(src, m.index! + 1); if (!/\bk-switch\b/.test(t) && !/data-testid="start-in-worktree"/.test(t)) out.push(at(s, lineOf(src, m.index!), "a switch without k-switch")); }
    if (!rail.has(s.file)) for (const m of src.matchAll(/(?<![[\w-])aria-current=/g)) if (!/\bk-picked\b/.test(tag(src, m.index!))) out.push(at(s, lineOf(src, m.index!), "a current row without k-picked"));
  }
  return out;
}

// A Settings section is made of the Settings kit (components/settings/kit.tsx), so that sections built by
// different hands read as one page: a group's box, a status and a label are the kit's. A section's module
// draws no framed box of its own (a border on the raised surface with a corner: Group or Card), no status
// tag of its own (a small tinted chip: Status), no label in capitals and no border in a style object. A box is
// any corner or border width on a surface, a tag any corner with a small tinted chip, whatever their sizes. The
// rule holds for the modules a section imports too (not the dialogs and menus that float over the page).
// The modules not moved yet are named in NOT_ON_KIT, each with what it still draws; the list only shrinks.
const NOT_ON_KIT = [
  "components/ElsewherePanel.tsx",
  "components/PhonePanel.tsx", "components/PortPanel.tsx", "components/PrReviews.tsx",
  "components/HelperPanel.tsx", "components/MemoryFacts.tsx",
  "components/MemoryUsage.tsx", "components/NewModels.tsx", "components/ProviderModels.tsx", "components/ResumeFrom.tsx", "components/TakeOver.tsx",
  "components/surfaces/PluginUnits.tsx",
  "components/ProvidersPanel.tsx", "components/SafetySettings.tsx", "components/Settings.tsx",
];
// The module each registered section shows: a lazy import's file, a component imported by name, or the file that registers it.
function sectionFiles(list: Src[]): string[] {
  const out = new Set<string>();
  const norm = (base: string, rel: string) => relative(UI, join(UI, base, "..", rel));
  for (const s of list) {
    if (!s.text.includes("settingsSections.add(")) continue;
    for (const x of sectionsIn(s.text)) {
      if (x.from) { out.add(norm(s.file, x.from)); continue; }
      const imp = x.name ? s.text.match(new RegExp(`import \\{[^}]*\\b${x.name}\\b[^}]*\\} from "([^"]+)"`)) : null;
      out.add(imp ? norm(s.file, imp[1]!) : s.file);
    }
  }
  return [...out].sort();
}
// A section's own modules: the file a section registers and every component of the page it imports, by
// the relative paths of its imports, however deep. The kit and the shared surfaces are not walked.
// (Not walked: the kit, the page's primitives and the dialogs and menus that float over a page.)
const SHARED_PARTS = new Set(["components/settings/kit.tsx", "components/ui.tsx", "components/Confirm.tsx", "components/ModelMenu.tsx", "components/AddProvider.tsx", "components/Chart.tsx"]);
function reached(list: Src[], sections: string[]): string[] {
  const by = new Map(list.map((s) => [s.file, s]));
  const out = new Set<string>(sections);
  const todo = [...sections];
  while (todo.length) {
    const f = by.get(todo.pop()!);
    if (!f) continue;
    for (const m of code(f.text).matchAll(/\b(?:import|export)\b[^;"']*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const rel = (m[1] ?? m[2])!;
      const to = relative(UI, join(UI, f.file, "..", rel.replace(/\.[tj]sx?$/, "")));
      const hit = [".tsx", ".ts"].map((e) => to + e).find((x) => by.has(x));
      if (!hit || out.has(hit) || SHARED_PARTS.has(hit) || !/^components\//.test(hit)) continue;
      out.add(hit); todo.push(hit);
    }
  }
  return [...out].sort();
}
// A corner of any kind, a border of any width and a surface (a background that is not a hover or a state).
const CORNER = /^rounded(-(?!none$)\S+)?$/, EDGE = /^border(-[xytblrse])?(-\d+)?$/, SURFACE = /^bg-(raised|sunken|surface|panel|card|elevated|bg)$/;
function offKit(list: Src[], sections: string[], waiting: string[] = NOT_ON_KIT): string[] {
  const out: string[] = [];
  const of = new Set(reached(list, sections));
  for (const s of list) {
    if (!of.has(s.file)) continue;
    const found: string[] = [];
    for (const { value, line } of strings(s.text)) {
      const c = new Set(classList(value));
      if (!c.size) continue;
      const corner = [...c].some((x) => CORNER.test(x)), edge = [...c].some((x) => EDGE.test(x));
      const surface = [...c].some((x) => SURFACE.test(x)), anyBg = [...c].some((x) => /^bg-/.test(x));
      // (A field or a control has a height of its own; a code span is mono.)
      if (c.has("font-mono") || [...c].some((x) => /^h-\d/.test(x))) continue;
      // (A surface that floats over the page, a dialog or a menu, is not a box of the page.)
      if ([...c].some((x) => /^(fixed|absolute|sticky|z-\d+|k-dialog)$/.test(x))) continue;
      // (An icon tile is a square of its own size.)
      const tile = [...c].some((x) => /^size-\d/.test(x));
      if (corner && (c.has("text-micro") || c.has("text-caption")) && anyBg && [...c].some((x) => /^px-(1|1\.5|2)$/.test(x))) found.push(at(s, line, `a status tag of its own (${value.slice(0, 40)}): use Status of components/settings/kit.tsx`));
      else if ((corner || edge) && surface && !tile) found.push(at(s, line, `a framed box of its own (${value.slice(0, 40)}): use Group or Card of components/settings/kit.tsx`));
      else if (c.has("uppercase")) found.push(at(s, line, "a label in capitals: a group's title or Status"));
    }
    // A border drawn in a style object is a second way to frame a box: the kit's classes are the only one.
    const src = code(s.text);
    for (const m of src.matchAll(/style=\{\{([^}]*)\}\}|\bstyle:\s*\{([^}]*)\}/g)) {
      if (/\bborder(?:[A-Z]\w*)?\s*:/.test(m[1] ?? m[2] ?? "")) found.push(at(s, lineOf(src, m.index!), "a border in a style object: a box is Group or Card of components/settings/kit.tsx"));
    }
    if (waiting.includes(s.file)) { if (!found.length) out.push(`${s.file}: is on the kit now; take it out of NOT_ON_KIT`); }
    else out.push(...found);
  }
  for (const f of waiting) if (!of.has(f) && list.length > 1) out.push(`${f}: in NOT_ON_KIT but no Settings section shows it`);
  return out;
}

// A state has one word, written once: in the vocabulary (src/core/state-words.ts).
// No other module of the page writes a state word, or one of the words the
// vocabulary retired, as text of its own: a label that is the word, a line
// that leads with it ("Failed: ..."), a count that ends in it ("2 running").
// A string counts anywhere on the page when it is written as a label
// (a capital in it, or more than one word, in any case: "Needs You", "NEEDS
// YOU"): a lower-case word is an identifier (a status, a kind). In the
// modules that show a session's or an agent's state, text between tags and
// the fixed parts of a template count whatever their case ("2 running",
// "offline", "asks"), and so does a phrase that says a session waits in words
// of its own ("Waiting for ...", "Waiting on ...", "is waiting for ...").
// A word that names something else's state (an MCP server, a column of
// figures) is listed here with what it is.
const STATE_TERMS = [...new Set([...Object.values(STATE_WORD), QUEUED, OFFLINE, "Waiting to resume", "Need you", "Running", "Asks you", "Ask you", "Finished", "Steer", "Idle"])];
// Said only in lower case, so only where a state is shown: the retired "asks" of an agent that needs the owner.
const LOWER_TERMS = ["asks"];
// A session that waits says so through the vocabulary ("Waiting for a timer"), on any page.
const WAITS = /^(is |are )?waiting (on|for)\b/i;
const VOCABULARY = "src/core/state-words.ts";
// Where a session's or an agent's state is shown.
const STATE_SURFACES = /^(lib\/(home|watch|rows|waiting|automation|work)\.ts|components\/(Sidebar|Bridge|HomeWatch|StartBox|ProjectPage|Palette|TurnControls|TimelinePanel|Attention|Mark|Where|Fleet|SessionHeader|SessionDock|Transcript|ToolCall|Work|QuestionCard|ApprovalCard|BlockedCards)\.tsx|components\/automation\/(SidebarExtras|BackgroundPopover|TranscriptExtras|InboxPanel|bits|AwayDigest|ActivityList|ChildApprovals)\.tsx)$/;
const OTHER_STATES: Record<string, string[]> = {
  // A verb of a tool's line ("Running bun test"), not a state.
  "lib/tools.ts": ["Running"],
  // The transcript says what a tool does in its own lines: the verb of a call ("Running bun test", "Stopped the
  // server", "Asks which color"), a step that runs now, a plan's steps ("2 of 5 done", "Not started"), a
  // summary read in parts. Where its words are a session's or a call's state it reads the vocabulary.
  "components/Transcript.tsx": ["Running", "done"],
  "components/ToolCall.tsx": ["Running", "Stopped", "Not started", "done"],
  "components/Work.tsx": ["Running"],
  "components/QuestionCard.tsx": ["Asks"],
  "lib/work.ts": ["Stopped", "running"],
  // A daemon that waits for its turns before it stops, and a saved message that waits for the daemon.
  "components/DaemonPanel.tsx": ["Failed", "Stopped", "Waiting for running turns since"],
  "components/Composer.tsx": ["Waiting for Keel"],
  // A task's own check mark, and a job of the dock that its owner stopped.
  "components/automation/TasksPanel.tsx": ["Done"],
  // Other things' states and figures: a settings group, an MCP server, a port's item, a daemon's end, a memory call, a table's column, an experiment.
  "components/Settings.tsx": ["Working"],
  "components/SessionPanel.tsx": ["Running", "Failed"],
  "components/surfaces/Mcp.tsx": ["Failed"],
  // A language server that was never started.
  "components/surfaces/LanguageServers.tsx": ["not started"],
  "components/PortPanel.tsx": ["Failed"],
  "components/MemoryFacts.tsx": ["Failed"],
  "components/UsagePanel.tsx": ["Failed"],
  "components/ResourcesPanel.tsx": ["Running"],
  "components/ExperimentsPanel.tsx": ["Stopped"],
  "components/IntegrationsPanel.tsx": ["Running"],
  // Tool calls of a turn's receipt ("2 failed: call 1").
  "components/TimelinePanel.tsx": ["failed"],
  // A step of a session's move to another machine.
  "components/Fleet.tsx": ["failed"],
  // A channel an alert did not reach ("Desktop failed").
  "components/automation/InboxPanel.tsx": ["failed"],
  // A link that ends an edit.
  "components/automation/AgentSettings.tsx": ["Done"],
};
function stateLiterals(list: Src[]): string[] {
  const out: string[] = [];
  const exact = new Set(STATE_TERMS);
  const lower = new Set([...STATE_TERMS, ...LOWER_TERMS].map((t) => t.toLowerCase()));
  const core = (t: string) => t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
  const leads = (t: string, cased: boolean) => STATE_TERMS.some((w) => new RegExp(`^${w}\\s*[:,\u00b7]`, cased ? "" : "i").test(t));
  for (const s of list) {
    const src = code(s.text);
    const ok = new Set(OTHER_STATES[s.file] ?? []);
    const hit = (text: string, at: number, cased: boolean) => {
      const c = core(text);
      // (Code between two tags, a branch of a conditional, is not text.)
      if (!c || ok.has(c) || ok.has(text.trim()) || [...ok].some((o) => o.includes(" ") && text.trim().startsWith(o)) || /^\s*[:?]|&&|\|\||=>|===|!==|\?\s*$/.test(text)) return;
      if ((cased ? exact.has(c) : lower.has(c.toLowerCase())) || leads(c, cased) || WAITS.test(text.trim())) out.push(`${s.file}:${lineOf(src, at)}: "${text.trim().slice(0, 60)}" is a state word: read it from ${VOCABULARY}`);
    };
    // (A lower-case word alone is an identifier; anything written as a label is matched in any case.)
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) { const t = m[1] ?? m[2] ?? ""; hit(t, m.index!, !/[A-Z]|\S\s+\S/.test(t)); }
    const any = STATE_SURFACES.test(s.file);
    for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g)) for (const part of m[1]!.split(/\$\{[^}]*\}/)) hit(part, m.index!, !any);
    if (s.file.endsWith(".tsx")) for (const m of src.matchAll(/[>}]([^<>{}=;()`"']*[A-Za-z]{2}[^<>{}=;()`"']*)(?=[<{])/g)) { if (!/^[\s,]*\w+:\s*$/.test(m[1]!)) hit(m[1]!, m.index!, !any); } // (a key of an object literal is not text)
  }
  return out;
}

// A state word is set in sentence case: no rule of a class that shows one turns it to capitals.
const STATE_CLASSES = ["k-row-state", "k-row-class", "k-row-queued", "k-station-word", "k-sum-word", "k-kids-word", "k-kids-new", "k-child-state", "k-rail-card-word", "k-where-reach", "k-home-recent-word", "k-pane-empty-word", "k-look-state", "k-dock-need", "k-marks-head", "k-face-state", "k-line-state"];
// (A class that is also the instrument face's state role and shows something else says so here.)
const NOT_STATES = ["k-stuck-head", "k-aim", "k-ask-count"];
function shoutedStates(list: Src[]): string[] {
  const out: string[] = [];
  const names = (sel: string) => [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]!);
  for (const s of list) for (const r of rules(s.text)) {
    const d = r.decls.find((x) => x.prop === "text-transform" && /uppercase|capitalize/.test(x.value));
    if (!d) continue;
    for (const sel of r.selector.split(",")) {
      const cs = names(sel);
      const hit = cs.find((c) => STATE_CLASSES.includes(c));
      if (hit && !cs.some((c) => NOT_STATES.includes(c))) out.push(`${s.file}:${d.line}: .${hit} shows a state word: it is set in sentence case, as ${VOCABULARY} writes it`);
    }
  }
  return out;
}

// A control's test id is its name for the e2e specs and for the record of what the owner presses
// (lib/press-batch.ts masks only runs of digits and hex, so a name or a title in an id would be kept
// as it is). A template literal in a test id may interpolate only what is a fixed set: a kind, a
// key, a state, an id of something the code lists. These are the ones reviewed, by file and by the
// expression, none of them user data. A new one is a decision: name it here, with the reason in the
// commit, or put the data in an attribute (data-name, data-value) and keep the id fixed.
const TEST_ID_PARTS: Record<string, string[]> = {
  "components/AcpAgentsPanel.tsx": ["a.id"], "components/ArtifactsPanel.tsx": ["f", "v"],
  "components/automation/ActivityList.tsx": ["k"], "components/automation/AlertSettings.tsx": ["c.id", "g.id", "k"],
  "components/automation/Lane.tsx": ["l.key"], "components/ElsewherePanel.tsx": ["g.id"],
  "components/ExperimentsPanel.tsx": ["m"], "components/HeavyPool.tsx": ["r.state"], "components/Pictures.tsx": ["side"],
  "components/HomeWatch.tsx": ["p.w"], "components/ImportSheet.tsx": ["h.harness"],
  "components/ListArrange.tsx": ["g", "s.v"], "components/LogsSettings.tsx": ["id"],
  "components/NewModels.tsx": ["k", "r"], "components/ObservabilityPanel.tsx": ["g.metric"], "components/Panes.tsx": ["n"],
  "components/PermissionMenu.tsx": ["m.id", "p.id"], "components/ProviderModels.tsx": ["k"], "components/QuestionCard.tsx": ["s.scope"],
  "components/ResumeFrom.tsx": ["v"], "components/SessionHeader.tsx": ["a.id"],
  "components/SessionPanel.tsx": ["x.id"], "components/SessionUsage.tsx": ["k"],
  "components/Settings.tsx": ["Math.round(v * 100)"], "components/Sidebar.tsx": ["w"],
  "components/SidePanel.tsx": ["p.id"], "components/surfaces/kit.tsx": ["a.id", "kind", "v"],
  "components/surfaces/PluginUnits.tsx": ["testid"], "components/TerminalPanel.tsx": ["f"],
  "components/TimelinePanel.tsx": ['v || "all"'], "components/Transcript.tsx": ["a.id"],
  "components/TurnControls.tsx": ["z.key"], "components/UsagePanel.tsx": ["key"],
  "components/UsagePast.tsx": ["label"], "components/UsageViews.tsx": ["label"],
};
// What a test id's value holds: the template literals written after `data-testid=` or `testid:` /
// `testid=` (a prop that is handed to one), up to the end of that value.
function testIdTemplates(text: string): { exprs: string[]; line: number }[] {
  const src = code(text);
  const out: { exprs: string[]; line: number }[] = [];
  for (const m of src.matchAll(/(?<![\w-])(?:data-)?testid\s*(=\s*\{|:)/g)) {
    let depth = 0, i = m.index! + m[0].length;
    const found: string[] = [];
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === "`") {
        let j = i + 1, braces = 0;
        for (; j < src.length && (src[j] !== "`" || braces); j++) {
          if (src[j] === "\\") j++;
          else if (src[j] === "$" && src[j + 1] === "{") { braces++; j++; }
          else if (braces && src[j] === "}") braces--;
        }
        for (const e of src.slice(i + 1, j).matchAll(/\$\{([^}]*)\}/g)) found.push(e[1]!.trim());
        i = j;
      } else if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1; }
      else if ("({[".includes(c)) depth++;
      else if (")}]".includes(c)) { if (--depth < 0) break; }
      else if ((c === "," || c === ";" || c === "\n") && depth === 0) break;
    }
    if (found.length) out.push({ exprs: found, line: lineOf(src, m.index!) });
  }
  return out;
}
function testIds(list: Src[], allowed: Record<string, string[]> = TEST_ID_PARTS): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const s of list) {
    for (const t of testIdTemplates(s.text)) {
      for (const e of t.exprs) {
        used.add(`${s.file}\n${e}`);
        if (!allowed[s.file]?.includes(e)) out.push(at(s, t.line, `a test id holds \${${e}}: it is recorded as a control's name, so it may hold only a fixed set (a kind, a key, a state). Keep the id fixed and put the data in an attribute, or name the expression in TEST_ID_PARTS`));
      }
    }
  }
  const gone = Object.entries(allowed).flatMap(([f, es]) => es.filter((e) => !used.has(`${f}\n${e}`)).map((e) => `${f}: no test id holds \${${e}} now: take it off TEST_ID_PARTS`));
  return list === page ? [...out, ...gone] : out;
}

// ---------- Over the tree ----------

// What the page does on a beat runs on its one clock (lib/clock.ts), which
// stops while the page is hidden. The files that still keep a timer of their
// own are named here, to be moved to the clock; a file not named keeps none.
const OWN_TIMERS = new Set(["lib/clock.ts", "lib/drafts.ts", "lib/hotui.ts",
  ...["ApprovalCard", "Attention", "DaemonPanel", "ElsewherePanel", "ExperimentsPanel", "HomeWatch", "ImportSheet", "LogsSettings", "ObservabilityPanel", "PhonePanel", "PlanCard",
    "PreviewPanel", "ProvidersPanel", "ResourcesPanel", "ResumeFrom", "surfaces/Mcp", "surfaces/Plugins", "TimelinePanel", "TracesPanel", "UsagePanel", "UsagePast", "UsageViews"].map((n) => `components/${n}.tsx`)]);
// (window.setInterval is the same timer. A file named here that no longer keeps one is said too, so the
// list only shrinks.)
const TIMER = /(?<![\w$])(?:(?:window|globalThis|self)\.)?setInterval/;
function ownTimers(list: Src[]): string[] {
  const app = list.filter((s) => !/\.test\.tsx?$/.test(s.file));
  const kept = app.filter((s) => !OWN_TIMERS.has(s.file)).flatMap((s) => calls(s.text, TIMER).map((c) => at(s, c.line, "a timer of its own: use every() of lib/clock.ts")));
  const gone = [...OWN_TIMERS].filter((f) => f !== "lib/clock.ts" && !app.some((s) => s.file === f && calls(s.text, TIMER).length)).map((f) => `${f}: keeps no timer now: take it off OWN_TIMERS`);
  return [...kept, ...gone];
}

test("the type scale has eight sizes, written once", () => {
  const theme = rules(sheets.find((s) => s.file === "styles.css")!.text).flatMap((r) => r.decls).filter((d) => /^--text-[a-z]+$/.test(d.prop));
  expect(theme.map((d) => d.prop.slice(7))).toEqual(["micro", "caption", "ui", "base", "read", "head", "title", "display"]);
  expect(theme.every((d) => /^[\d.]+rem$/.test(d.value))).toBe(true);
});

test("no stylesheet writes a text size of its own", () => expect(sheetSizes(sheets)).toEqual([]));
test("no component writes a text size of its own", () => expect(pageSizes(page)).toEqual([]));
test("no stylesheet writes a corner or a motion length of its own", () => expect(sheetCorners(sheets)).toEqual([]));
test("no component writes a motion length or a backdrop of its own", () => expect(pageMotion(page)).toEqual([]));
test("a class is drawn by one stylesheet", () => expect(twiceDrawn(sheets)).toEqual([]));
test("the conversation has one strong rule, and Keel's voice no card", () => expect(voices(sheets, page)).toEqual([]));
test("a button, a field, a select and a quote are the shared ones", () => expect(handMade(page)).toEqual([]));
test("no component writes a corner of its own", () => {
  expect(pageCorners(page)).toEqual([]);
  expect(rules(sheets.find((s) => s.file === "styles.css")!.text).flatMap((r) => r.decls).find((d) => d.prop === "--radius")?.value).toBe("var(--radius-sm)");
});
test("the instrument face is named by its two roles and nowhere else", () => expect(face(sheets, page)).toEqual({ roles: 2, strays: [] }));
test("a choice of a few is the one segmented control", () => expect(segmented(page, sheets)).toEqual([]));
test("steel is the frame and nothing else", () => expect(steel(page, sheets)).toEqual([]));
test("nothing to show is said one way", () => expect(empties(page, sheets)).toEqual([]));
test("a beat of the page runs on its one clock", () => expect(ownTimers(page)).toEqual([]));
test("every time is on the 24-hour clock", () => {
  expect(pageTimes(page)).toEqual([]);
  expect(daemonTimes(daemon)).toEqual([]);
});
test("the look is set by components and tokens, not by test ids or utility names", () => expect(selectors(sheets, page)).toEqual([]));
test("a label, a picked row and a switch are their shared class", () => expect(shared(page)).toEqual([]));
test("each state's colors are the hue of its dot, in both themes", () => expect(stateHues(sheets.find((x) => x.file === "styles.css")!.text)).toEqual([]));
test("no component or stylesheet writes a color of its own", () => expect(ownColors(page, sheets)).toEqual([]));
test("a state word is written once, in the vocabulary", () => expect(stateLiterals(page)).toEqual([]));
test("a test id interpolates only a reviewed, fixed set of names", () => expect(testIds(page)).toEqual([]));
test("a state word is set in sentence case", () => expect(shoutedStates(sheets)).toEqual([]));
test("a Settings section is made of the Settings kit", () => expect(offKit(page, sectionFiles(page))).toEqual([]));

// One palette for a state. A state's color is the hue of its dot, wherever it shows: the tokens (--st-need, --st-work,
// --st-fail, and their -ink words) resolve, in each theme, to a hue within 15 degrees of --dot-X (--st-done is the quiet grey,
// with no chroma), and no
// component or stylesheet but styles.css writes a color of its own (black and white for a mask or a shadow, and the
// browser's theme-color, are not colors of a state).
const STATE_DOT = { need: "dot-need", work: "dot-work", fail: "dot-fail", done: "dot-done" } as const;
function resolveOklch(vars: Map<string, string>, name: string, seen = new Set<string>()): { l: number; c: number; h: number } | undefined {
  if (seen.has(name)) return undefined;
  const v = vars.get(name);
  if (!v) return undefined;
  const ref = /^var\(--([\w-]+)\)$/.exec(v.trim());
  if (ref) return resolveOklch(vars, ref[1]!, new Set([...seen, name]));
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v.trim());
  return m ? { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) } : undefined;
}
function stateHues(styles: string): string[] {
  const out: string[] = [];
  const all = rules(styles);
  const own = (sel: string) => new Map(all.filter((r) => r.selector === sel && !r.within.length).flatMap((r) => r.decls).map((d) => [d.prop.replace(/^--/, ""), d.value] as const));
  const light = own(":root");
  const night = new Map([...light, ...own(".dark")]);
  for (const [theme, vars] of [["light", light], ["dark", night]] as const) {
    for (const [state, dot] of Object.entries(STATE_DOT)) {
      const want = resolveOklch(vars, dot);
      if (!want) { out.push(`${theme}: --${dot} is not a color`); continue; }
      for (const token of [`st-${state}`, `st-${state}-ink`, ...(state === "need" ? ["st-need-fill"] : [])]) {
        const got = resolveOklch(vars, token);
        if (!got) { out.push(`${theme}: --${token} is not a color`); continue; }
        // Done's mark is its dot's green; its word stays the quiet ink (a list of Done words is not a wall of green).
        if (token === "st-done-ink") { if (got.c >= 0.04) out.push(`${theme}: --${token} is a colour (chroma ${got.c}), done's word is quiet`); continue; }
        const d = Math.abs(got.h - want.h) % 360;
        if (Math.min(d, 360 - d) >= 15 || got.c < 0.04) out.push(`${theme}: --${token} is hue ${got.h} (chroma ${got.c}), its dot ${want.h}`);
      }
    }
    const wait = resolveOklch(vars, "st-wait"), work = resolveOklch(vars, "st-work");
    if (!wait || !work || wait.h !== work.h) out.push(`${theme}: waiting is the dot of work, half filled: one blue`);
  }
  return out;
}
const COLOR_WORD = /oklch\(|oklab\(|#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|divide|accent|caret|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;
function ownColors(pageList: Src[], sheetList: Src[]): string[] {
  const out: string[] = [];
  for (const s of [...pageList, ...sheetList]) {
    if (s.file === "styles.css" || s.file === "lib/ui.ts") continue;
    const text = code(s.text, s.file.endsWith(".css"));
    for (const m of text.matchAll(COLOR_WORD)) {
      const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + 8);
      if (/^#(000|fff)(000|fff)?$/i.test(m[0]) || (m[0] === "oklch(" && /^\s*0\s+0\s+0\b/.test(tail))) continue;
      out.push(at(s, lineOf(text, m.index!), m[0]));
    }
  }
  return out;
}

// ---------- The checks themselves ----------

const css = (text: string, file = "bridge.css"): Src[] => [{ file, text }];
const tsx = (text: string, file = "components/Thing.tsx"): Src[] => [{ file, text }];

test("each check refuses what it is for", () => {
  expect(sheetSizes(css(".k-thing { font-size: 0.9rem; }"))).toHaveLength(1);
  expect(sheetSizes(css(".k-thing {\n  color: red;\n  font:\n    bold 0.9rem/1 var(--font-sans);\n}"))).toEqual(["bridge.css:3: font: bold 0.9rem/1 var(--font-sans)"]);
  expect(sheetSizes(css(".k-thing { font-size: 0.75em; }"))).toHaveLength(1);
  expect(sheetCorners(css(".k-thing { border-radius: 0.25rem; }\n.k-other { border-radius: 0 0 0.3125rem var(--radius-md); }"))).toHaveLength(2);
  expect(sheetCorners(css(".k-thing { transition: opacity 120ms var(--ease-out), transform 160ms; }"))).toHaveLength(2);
  expect(pageSizes(tsx('<p className="text-[1.1rem] font-semibold" />'))).toHaveLength(1);
  expect(pageMotion(tsx('<div className="transition-opacity duration-150 data-open:duration-[90ms]" />'))).toHaveLength(2);
  expect(handMade(tsx('<button className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover" /><input className="h-8 rounded-md border border-line bg-bg outline-none focus:border-accent" /><button className="k-btn k-btn-lg" /><button className="grid h-8 rounded-full border border-line hover:bg-hover" /><Select value={v} onChange={(e) => set(e.target.value)} className="h-8 w-40 rounded-md border" /><Select value={v} className="w-28" /><div className="border-l-2 border-line pl-3" />'))).toHaveLength(4);
  expect(handMade(tsx('const SEL = "h-8 rounded-md border px-2";\nconst W = "w-40";\nexport const A = () => <><Select value={v} className={cn(SEL, "w-80")} /><Select value={v} className={cn(W, on && "max-w-full")} /></>;'))).toHaveLength(1);
  expect(pageCorners(tsx('<div className="rounded rounded-t-md rounded-3xl md:rounded-[0.4rem] rounded-[var(--radius-xl)]" />'))).toHaveLength(2);
  expect(voices([...css(".k-owner-words { border-left: 0.1875rem solid var(--fg); }\n.k-step { border-left: 0.1875rem solid red; }\n.k-told-words { border-left: 1px solid var(--line); }", "transcript.css"), ...css(".prose-keel :not(pre) > code { border: 1px solid var(--line); }", "styles.css")], tsx('<div className="rounded-lg border border-line shadow-1" />', "components/automation/TranscriptExtras.tsx"))).toHaveLength(3);
  // Every spelling of a wide rule is refused, and a hairline or the step's own is not.
  expect(voices(css([
    ".k-a { border-inline-start: 3px solid red; }", ".k-b { box-shadow: inset 0.25rem 0 0 var(--fg); }", ".k-c { border-left-width: medium; }",
    ".k-step-head { border-left: 3px solid red; }", ".k-step .k-x { border-left: 4px solid red; }", ".k-step, .k-y { border-left: 4px solid red; }",
    ".k-d { border-left: 2px solid red; }", ".k-e { box-shadow: inset 0 0 0 1px var(--line), 0 4px 14px red; }", ".k-f { border-left: 0.125rem solid red; }",
    ".k-g .k-step { border-left: 3px solid red; }", ".k-step[data-state=fail] { border-left-width: 0.1875rem; }", ".k-step:hover { box-shadow: inset 3px 0 0 red; }",
    ".k-h { border-left: calc(1px + 0.125rem) solid red; }", ".k-i { border-left-width: max(1px, 0.25rem); }", ".k-j { border-left: calc(var(--w) + 1px) solid oklch(0.5 0.1 27); }",
  ].join("\n"), "transcript.css"), tsx('<div className="border-l-[3px] border-l-4 md:border-s-[0.25rem] border-l-2 border-l border-l-[1px] border-l-[calc(1px+0.25rem)]" />', "components/Words.tsx"))).toHaveLength(12);
  expect(twiceDrawn([...css(".k-dock { display: none; }"), ...css(".k-dock { display: flex; }\n.k-dock, .k-other { gap: 0; }\n@media (max-width: 767px) { .k-dock { gap: 0; } }", "styles.css")])).toEqual(["styles.css:1: .k-dock (also in bridge.css)"]);
  expect(pageMotion(tsx('<div className="fixed inset-0 bg-black/20 duration-(--dur-move) bg-white" />'))).toHaveLength(1);
  expect(pageSizes(tsx('<p className="[font-size:1.1rem] font-semibold" />'))).toHaveLength(1);
  expect(pageSizes(tsx('<p className="text-[length:1.1rem]" />'))).toHaveLength(1);
  expect(pageSizes(tsx('<p className={cn("md:text-sm", on && "hover:text-lg")} />'))).toHaveLength(2);
  expect(pageSizes(tsx('const st = {fontSize:"13px"};'))).toHaveLength(1);
  expect(face(css(".k-thing { font-family: var(--font-inst); }"), []).strays).toHaveLength(1);
  expect(face([], tsx('<b className="font-inst" />')).strays).toHaveLength(1);
  expect(segmented(tsx('<div role="tablist" className="flex gap-1 bg-sunken p-0.5" />'), [])).toHaveLength(1);
  expect(segmented(tsx('<Tabs.List\n  className="k-seg">'), [])).toHaveLength(2);
  expect(segmented([], css(".k-seg > * { height: 1rem; }", "styles.css"))).toHaveLength(1);
  expect(steel(tsx('<div className="hover:bg-panel/60" />'), css(".k-thing { background: var(--panel); }"))).toHaveLength(2);
  expect(empties(tsx('<p className="py-10 text-center text-ui text-faint">Nothing.</p>'), [])).toHaveLength(1);
  expect(pageTimes(tsx("const t = new Date().toLocaleTimeString();"))).toHaveLength(1);
  expect(pageTimes(tsx('const t = new Date(ts).toLocaleString(undefined, {\n  hour: "2-digit",\n});'))).toHaveLength(1);
  expect(pageTimes(tsx("const t = new Date(ts).toLocaleString();"))).toHaveLength(1);
  expect(pageTimes(tsx('const t = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date());'))).toHaveLength(1);
  expect(daemonTimes(tsx("const t = new Date(ms).toLocaleTimeString();", "fleet/resume.ts"))).toHaveLength(1);
  expect(selectors(css('[data-testid="composer"] { color: red; }'))).toHaveLength(1);
  expect(selectors(css('.k-thing button[title*="Copy"] { color: red; }'))).toHaveLength(1);
  expect(selectors(css(".k-plan .bg-accent { color: red; }\n.k-new .md\\:mt-\\[18vh\\] { margin: 0; }\n.k-user > .rounded-xl { margin: 0; }"))).toHaveLength(3);
  // What the line-by-line reader let through.
  expect(segmented(tsx('<div role={tabs ? "tablist" : "group"} />'), [])).toHaveLength(1);
  expect(segmented([], css(".k-thing .k-seg > button { height: 1rem; }"))).toHaveLength(1);
  expect(segmented([], css(".k-seg > [role=tab] { height: 1rem; }", "styles.css"))).toHaveLength(1);
  expect(pageSizes(tsx('el.style.fontSize = "13px";'))).toHaveLength(1);
  expect(empties(tsx('<p className="py-6 text-center text-micro text-faint">Nothing.</p>\n<p className={cn("text-center text-ui", quiet && "text-faint")}>Nothing.</p>'), [])).toHaveLength(2);
  expect(pageSizes(tsx('const rx = /a\\/\\//; const st = { fontSize: "13px" };'))).toHaveLength(1);
  expect(shared(tsx('<h3 className="mt-2 text-micro font-medium uppercase tracking-wide text-faint">Tools</h3>'))).toHaveLength(1);
  expect(shared(tsx('<button role="switch" aria-checked={on} className="relative h-5 w-9 rounded-full" />'))).toHaveLength(1);
  expect(shared(tsx('<button aria-current={on ? "true" : undefined} className={cn("flex", on && "bg-hover")} />'))).toHaveLength(1);
  // A state word written out: a label, a line that leads with one, a retired word, a count in a state surface.
  expect(stateLiterals(tsx('const LABEL = { running: "Running", waiting: "Waiting" };'))).toHaveLength(2);
  expect(stateLiterals(tsx('<span>Asks you</span>\n<b title="Needs you" />\nconst t = `Failed: ${why}`;'))).toHaveLength(3);
  expect(stateLiterals(tsx('<span>· {n} running</span>\nconst t = `${n} waiting`;', "components/automation/SidebarExtras.tsx"))).toHaveLength(2);
  // Idle is no state's word; a session that waits says so through the vocabulary; "asks" and "offline" are retired spellings where a state is shown.
  expect(stateLiterals(tsx('const STATE = { idle: { word: "Idle" } };\nconst what = approving ? "Waiting for your approval" : "";\n<b>{agent} is waiting for your answer</b>'))).toHaveLength(3);
  expect(stateLiterals(tsx('<span>{agent} asks</span>\n<span data-offline>offline</span>', "components/Sidebar.tsx"))).toHaveLength(2);
  // A label in another case is the same word: an attribute's string, a word that leads a sentence.
  expect(stateLiterals(tsx('<span title="Needs You" />\nconst a = "NEEDS YOU";\nconst b = "needs you";\n<i aria-label="Needs you, under a look" />'))).toHaveLength(4);
  // A section that draws its own box, tag or capitals; one named as waiting that no longer does.
  expect(offKit(tsx('<section className="rounded-lg border border-line bg-raised p-4" />\n<span className="rounded-xs bg-sunken px-1.5 text-micro text-muted">archived</span>\n<h3 className="text-micro uppercase">Tools</h3>'), ["components/Thing.tsx"], [])).toHaveLength(3);
  // Any corner or border width on a surface, a chip of any shape, a border in a style object, and what a section imports.
  expect(offKit(tsx('<div className="rounded-2xl border-2 border-line bg-raised p-4" />\n<span className="rounded-full bg-sunken px-2 text-micro" />\n<div style={{ border: "1px solid red" }} />\n<div style={{ borderColor: c }} />\n<div className="rounded-sm bg-sunken p-2" />'), ["components/Thing.tsx"], [])).toHaveLength(5);
  const two = [...tsx('import { Part } from "./Part.tsx";\nimport { Pop } from "./ui.tsx";\nexport const Thing = () => <Part />;', "components/Thing.tsx"), ...tsx('<div className="rounded-lg border bg-raised" />', "components/Part.tsx"), ...tsx('<div className="rounded-lg border bg-raised" />', "components/ui.tsx"), ...tsx('<div className="rounded-lg border bg-raised" />', "components/Other.tsx")];
  expect(offKit(two, ["components/Thing.tsx"], [])).toHaveLength(1);
  expect(offKit(two, ["components/Thing.tsx"], ["components/Part.tsx"])).toEqual([]);
  expect(offKit(tsx('<Group title="Tools"><Status>archived</Status></Group>'), ["components/Thing.tsx"], ["components/Thing.tsx"])).toHaveLength(1);
  // And no rule turns one to capitals.
  expect(shoutedStates(css(".k-row-state { font-weight: 700; text-transform: uppercase; }\n.k-rail .k-sum-word, .k-other { text-transform: uppercase; }"))).toHaveLength(2);
});

test("a test id may not carry data", () => {
  // The review's case: a name in an id would be recorded as it is.
  const bad = testIds(tsx("<button data-testid={`branch-${name}`} />"), {});
  expect(bad).toHaveLength(1);
  expect(bad[0]).toContain("components/Thing.tsx:1: a test id holds ${name}");
  // A prop, an object field, a ternary and a second interpolation are read too.
  expect(testIds(tsx("<Row testid={`row-${a.title}-${b}`} />"), {})).toHaveLength(2);
  expect(testIds(tsx("const o = { value: v, testid: `seg-${v}` };\nconst p = { testid: on ? `a-${t}` : 'b' };"), {})).toHaveLength(2);
  // An expression named for that file passes; the same one in another file does not.
  expect(testIds(tsx("<b data-testid={`lane-${l.key}`} />"), { "components/Thing.tsx": ["l.key"] })).toEqual([]);
  expect(testIds(tsx("<b data-testid={`lane-${l.key}`} />", "components/Other.tsx"), { "components/Thing.tsx": ["l.key"] })).toHaveLength(1);
});

test("a test id that holds no data is let through", () => {
  expect(testIds(tsx('<b data-testid="where" data-x={`a-${b}`} />\n<i data-testid={on ? "a" : "b"} className={`k-${kind}`} />'), {})).toEqual([]);
  expect(testIds(tsx("// data-testid={`x-${y}`}\nconst t = { testid: string };\nconst q = `[data-testid=\"${testid}\"]`;"), {})).toEqual([]);
});

test("each check lets ordinary edits through", () => {
  // A status is an identifier, a sentence may use the word, the vocabulary itself writes it, and another thing's state is listed.
  expect(stateLiterals(tsx('const live = a.status === "running" || a.status === "waiting";\nconst hint = "Running sessions are listed once the agent view is set.";\n<span>{STATE_WORD.work}</span>\nconst STATE = {\n  waiting: { word: STATE_WORD.wait },\n};'))).toEqual([]);
  expect(stateLiterals(tsx('const said = "Waiting until it is idle";\nconst live = m.state === "offline";'))).toEqual([]);
  expect(stateLiterals(tsx('const SERVER = { error: "Failed" };', "components/surfaces/Mcp.tsx"))).toEqual([]);
  expect(shoutedStates(css(".k-stuck-head { text-transform: uppercase; }\n.k-station-identity .k-station-word { text-transform: none; }\n.k-aim.k-face-state { text-transform: uppercase; }"))).toEqual([]);
  expect(stateLiterals(tsx('<span>{n} failed</span>', "components/CodeCall.tsx"))).toEqual([]);
  expect(sheetCorners(css(".k-pill { border-radius: 999px; }\n.k-tab { border-radius: var(--radius-sm) var(--radius-sm) 0 0; }\n.k-flip { transition: opacity var(--dur-quick) var(--ease-out); }\n.k-wait { animation: fade 480ms; }"))).toEqual([]);
  expect(sheetSizes(css(".k-thing { font-size: var(--text-caption); height: var(--spacing-ctl-md); }\n.prose-keel sup { font-size: 0.75em; }\n/* font-size: 3rem */"))).toEqual([]);
  expect(pageSizes(tsx('// Tailwind text-sm is not used here.\n/* nor text-[1.1rem] */\nconst tick = { fontSize: "var(--text-micro)" };\n<p className="text-ui text-[color:var(--x)] text-[var(--c)]" />'))).toEqual([]);
  expect(segmented(tsx('<Seg kind="tabs" label="View" value={v} onChange={set} options={o} />\n// role="tablist" is the Seg component\'s'), [])).toEqual([]);
  expect(empties(tsx('<p className="text-caption text-muted">No further approval is asked for this folder.</p>'), [])).toEqual([]);
  // The kit's parts, a box that is not a section's, and a section not moved yet are let through.
  expect(offKit(tsx('<Group title="Tools" pad><Status tone="ok">Well</Status><Empty>None.</Empty></Group>\n<span className="size-5 rounded-full bg-sunken" />\n<div className="fixed rounded-xl border-2 border-line bg-raised" />'), ["components/Thing.tsx"], [])).toEqual([]);
  expect(offKit(tsx('<div className="rounded-lg border border-line bg-raised" />'), [], [])).toEqual([]);
  expect(offKit(tsx('<div className="rounded-lg border border-line bg-raised" />'), ["components/Thing.tsx"], ["components/Thing.tsx"])).toEqual([]);
  expect(pageTimes(tsx('const n = (1234567).toLocaleString();\nconst m = total.toLocaleString("en-US");\nconst d = new Date(ts).toLocaleDateString();'))).toEqual([]);
  expect(daemonTimes(tsx('const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", {\n  hour: "2-digit",\n  minute: "2-digit",\n  hourCycle: "h23",\n});\nconst zone = Intl.DateTimeFormat().resolvedOptions().timeZone;', "fleet/resume.ts"))).toEqual([]);
  expect(selectors(css(".k-thing[data-open] > .k-part:hover, .dark .k-thing { color: red; }\nsvg.text-warn { color: var(--warn); }\n@keyframes k-x { from { opacity: 0; } }\n@media (max-width: 767px) { .k-thing { color: red; } }"))).toEqual([]);
  // An own class is named k-: a bare .grid would be the utility of that name.
  expect(selectors(css(".k-chart .k-grid line { stroke: var(--line); }"))).toEqual([]);
  expect(selectors(css(".k-chart .grid line { stroke: var(--line); }"))).toEqual(["bridge.css:1: .grid in .k-chart .grid line: name the part k-grid (a bare class is a utility's name, or would be taken for one)"]);
  // A library's own markup may be styled: no component of ours writes its class.
  expect(selectors(css(".katex-display { margin: 0; }\n.k-plan .bg-accent { color: red; }"), tsx('<i className="bg-accent" />'))).toHaveLength(1);
  // A sentence that names a utility is not a use of it, in a string or in JSX text after an apostrophe.
  expect(pageSizes(tsx('const hint = "Tailwind\'s text-sm is not used here.";\nconst el = <p>the session\'s size {/* "text-lg" */}</p>;'))).toEqual([]);
  expect(pageTimes(tsx("const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;\nconst rx = /^https?:\\/\\//; const after = new Date(ts).toLocaleDateString();"))).toEqual([]);
  expect(segmented(tsx('const first = el.querySelector(\'[role="radio"]\');'), [])).toEqual([]);
  expect(shared(tsx('<Switch.Root\n  checked={on}\n  className="k-switch"><Switch.Thumb className="k-switch-thumb" /></Switch.Root>\n<h3 className="k-label mt-2">Tools</h3>\n<span className="rounded-xs bg-sunken px-1 text-micro font-medium text-muted">tag</span>'))).toEqual([]);
  // A state's token that leaves its dot's hue is refused, one that follows it is let through; a color written in a component is refused, a mask's black is not.
  const palette = (need: string, ink: string) => `:root { --dot-need: oklch(0.8 0.17 88); --dot-need-edge: oklch(0.55 0.12 80); --dot-work: oklch(0.56 0.19 255); --dot-fail: oklch(0.55 0.2 27); --dot-done: oklch(0.5 0.13 150); --st-need: ${need}; --st-need-ink: ${ink}; --st-need-fill: var(--dot-need); --st-work: var(--dot-work); --st-work-ink: oklch(0.47 0.15 255); --st-wait: var(--st-work); --st-fail: var(--dot-fail); --st-fail-ink: var(--dot-fail); --st-done: var(--dot-done); --st-done-ink: oklch(0.4 0.02 258); }`;
  expect(stateHues(palette("var(--dot-need-edge)", "oklch(0.46 0.1 82)"))).toEqual([]);
  expect(stateHues(palette("var(--dot-need-edge)", "oklch(0.46 0.2 295)"))).toHaveLength(2);
  expect(ownColors(tsx('<i style={{ color: "oklch(0.5 0.2 295)" }} className="text-violet-500" />'), css(".k-a { color: #7c3aed; background: rgb(1 2 3); mask-image: linear-gradient(#000, transparent); box-shadow: 0 1px oklch(0 0 0 / 0.2); }"))).toHaveLength(4);
});
