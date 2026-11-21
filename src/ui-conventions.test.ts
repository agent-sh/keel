// The look is one system: what the stylesheets and components may write is
// checked over the UI source, so a second scale or a fifth face cannot come
// back. The checks read the source the way it is built: comments are not
// code, a rule is its selector and its declarations wherever its lines break,
// a class list is its classes, a call is its arguments. Each check is a
// function of file texts, run over the tree and over small fixtures of what
// it must refuse and what it must let through.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Src = { file: string; text: string };
const UI = join(import.meta.dir, "../ui/src");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const read = (dir: string, ext: RegExp): Src[] => files(dir, ext).map((f) => ({ file: relative(dir, f), text: readFileSync(f, "utf8") }));
const sheets = read(UI, /\.css$/);
const page = read(UI, /\.tsx?$/);
const daemon = read(import.meta.dir, /\.ts$/);

// ---------- Reading the source ----------

// The text with its comments blanked (line and block, in CSS, TypeScript and
// JSX), every other character and every line break in its place. Strings and
// templates are kept: a `//` inside one is not a comment.
function code(text: string, css = false): string {
  const out = text.split("");
  let i = 0, quote = "";
  const blank = (to: number) => { for (; i < to; i++) if (out[i] !== "\n") out[i] = " "; };
  while (i < text.length) {
    const c = text[i]!, two = text.slice(i, i + 2);
    if (quote) {
      if (c === "\\") i += 2;
      else { if (c === quote) quote = ""; i++; }
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(end < 0 ? text.length : end + 2);
    } else if (!css && two === "//" && text[i - 1] !== ":") {
      const end = text.indexOf("\n", i);
      blank(end < 0 ? text.length : end);
    } else {
      if (c === '"' || c === "'" || (!css && c === "`")) quote = c;
      i++;
    }
  }
  return out.join("");
}
const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

// A stylesheet as its rules: the selector (or the at-rule, for one that holds
// declarations itself, as @theme does), the at-rules around it, and its
// declarations, each with the line it starts on.
type Rule = { selector: string; line: number; within: string[]; decls: { prop: string; value: string; line: number }[] };
function rules(text: string): Rule[] {
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
}

// The string literals of a module (quoted, and the fixed parts of a
// template), each with its line: where class lists and inline values live.
function strings(text: string): { value: string; line: number }[] {
  const src = code(text);
  const out: { value: string; line: number }[] = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const value = m[1] ?? m[2] ?? (m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    out.push({ value, line: lineOf(src, m.index!) });
  }
  return out;
}
// Every class named in a module: the words of its string literals.
const classes = (text: string) => strings(text).flatMap((s) => s.value.split(/\s+/).filter(Boolean).map((c) => ({ c, line: s.line })));

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
  const size = /^(var\(--text-[a-z]+\)|inherit|0|calc\(17px \* var\(--ui-scale, 1\)\)|max\(16px, 1rem\) !important|1\.08em)$/;
  const out: string[] = [];
  for (const s of list) for (const r of rules(s.text)) for (const d of r.decls) {
    if (d.prop === "font-size" && !size.test(d.value) && !(/(^|[\s>+~,])su[pb]\b/.test(r.selector) && /^[\d.]+em$/.test(d.value))) out.push(at(s, d.line, `font-size: ${d.value}`));
    if (d.prop === "font" && !/^(normal )?([1-9]00 )?var\(--text-[a-z]+\)(\/[\d.a-z]+)? var\(--font-(sans|mono)\)$/.test(d.value)) out.push(at(s, d.line, `font: ${d.value}`));
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
    for (const m of src.matchAll(/\bfontSize\s*:\s*([^,}\n]+)/g)) {
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
    for (const m of src.matchAll(/role=\{?["'](tablist|tab|radio)["']\}?|<Tabs\.(List|Tab)\b/g)) out.push(at(s, lineOf(src, m.index!), m[0]));
  }
  for (const s of sheetList) for (const r of rules(s.text)) {
    if (/^\.k-seg$|\.k-tabs\b/.test(r.selector) && s.file !== "styles.css") out.push(at(s, r.line, r.selector));
    if (/\.k-seg(\[[^\]]*\])? > (\*|:)/.test(r.selector)) out.push(at(s, r.line, r.selector));
  }
  return out;
}

// The panel color is the frame (the rail, the phone dock) and nothing else.
function steel(pageList: Src[], sheetList: Src[]): string[] {
  const out: string[] = [];
  for (const s of pageList) for (const { c, line } of classes(s.text)) if (/(^|:)bg-panel(\/\d+)?$/.test(c)) out.push(at(s, line, c));
  for (const s of sheetList) for (const r of rules(s.text)) for (const d of r.decls) {
    if (d.value.includes("var(--panel)") && !/\.k-rail\b|\.k-where-pip\b|\.k-dock\b/.test(r.selector) && d.prop !== "--color-panel") out.push(at(s, d.line, `${r.selector} { ${d.prop} }`));
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
    for (const { value, line } of strings(s.text)) {
      const c = new Set(value.split(/\s+/));
      if (c.has("text-center") && (c.has("text-ui") || c.has("text-caption")) && (c.has("text-faint") || c.has("text-muted")) && !c.has("k-empty")) out.push(at(s, line, value.slice(0, 60)));
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
    if (s.file === "lib/utils.ts") continue;
    for (const c of calls(s.text, /\.toLocaleTimeString/)) out.push(at(s, c.line, "toLocaleTimeString"));
    for (const c of calls(s.text, /\.toLocaleString/)) if (/\b(hour|timeStyle)\b/.test(c.args) || (!c.args.trim() && /Date\([^()]*\)\s*$/.test(c.before))) out.push(at(s, c.line, "toLocaleString with a time"));
    for (const c of calls(s.text, /Intl\.DateTimeFormat/)) out.push(at(s, c.line, "Intl.DateTimeFormat"));
  }
  return out;
}
function daemonTimes(list: Src[]): string[] {
  const out: string[] = [];
  const named = (args: string) => /hourCycle:\s*["']h23["']/.test(args);
  for (const s of list) {
    for (const c of calls(s.text, /\.toLocaleTimeString/)) if (!named(c.args)) out.push(at(s, c.line, "toLocaleTimeString without h23"));
    for (const c of calls(s.text, /\.toLocaleString|Intl\.DateTimeFormat/)) if (/\b(hour|timeStyle)\b/.test(c.args) && !named(c.args)) out.push(at(s, c.line, "a time without h23"));
  }
  return out;
}

// A stylesheet names a part by its own class. Own classes begin with k-, or
// are one of the few named here; any other class in a selector is a utility a
// component happens to carry (or would collide with one). It never reaches an
// element by its test id or by the words of its title or label.
const OWN = /^(k-[\w-]+|prose-keel|code-(block|head|lang|copy)|th-[a-z-]+|flash|row-cv|dark|theme-switch|math|sr-only|list-none|text-display|text-title|font-mono|animate-pulse-dot)$/;
function selectors(list: Src[]): string[] {
  const out: string[] = [];
  for (const s of list) for (const r of rules(s.text)) {
    if (r.selector.startsWith("@") || r.within.some((w) => w.startsWith("@keyframes"))) continue;
    for (const m of r.selector.matchAll(/\[(data-testid|title|aria-label)[^\]]*\]/g)) out.push(at(s, r.line, `${m[0]} in ${r.selector}`));
    for (const m of r.selector.matchAll(/(svg)?\.((?:\\.|[\w-])+)/g)) {
      const name = m[2]!.replace(/\\/g, "");
      // An icon in a state color keeps the fill: the one rule on a utility.
      if (!OWN.test(name) && !(m[1] && /^text-[a-z-]+$/.test(name))) out.push(at(s, r.line, `.${name} in ${r.selector}`));
    }
  }
  return out;
}

// ---------- Over the tree ----------

test("the type scale has eight sizes, written once", () => {
  const theme = rules(sheets.find((s) => s.file === "styles.css")!.text).flatMap((r) => r.decls).filter((d) => /^--text-[a-z]+$/.test(d.prop));
  expect(theme.map((d) => d.prop.slice(7))).toEqual(["micro", "caption", "ui", "base", "read", "head", "title", "display"]);
  expect(theme.every((d) => /^[\d.]+rem$/.test(d.value))).toBe(true);
});

test("no stylesheet writes a text size of its own", () => expect(sheetSizes(sheets)).toEqual([]));
test("no component writes a text size of its own", () => expect(pageSizes(page)).toEqual([]));
test("the instrument face is named by its five roles and nowhere else", () => expect(face(sheets, page)).toEqual({ roles: 5, strays: [] }));
test("a choice of a few is the one segmented control", () => expect(segmented(page, sheets)).toEqual([]));
test("steel is the frame and nothing else", () => expect(steel(page, sheets)).toEqual([]));
test("nothing to show is said one way", () => expect(empties(page, sheets)).toEqual([]));
test("every time is on the 24-hour clock", () => {
  expect(pageTimes(page)).toEqual([]);
  expect(daemonTimes(daemon)).toEqual([]);
});
test("the look is set by components and tokens, not by test ids or utility names", () => expect(selectors(sheets)).toEqual([]));

// ---------- The checks themselves ----------

const css = (text: string, file = "bridge.css"): Src[] => [{ file, text }];
const tsx = (text: string, file = "components/Thing.tsx"): Src[] => [{ file, text }];

test("each check refuses what it is for", () => {
  expect(sheetSizes(css(".k-thing { font-size: 0.9rem; }"))).toHaveLength(1);
  expect(sheetSizes(css(".k-thing {\n  color: red;\n  font:\n    bold 0.9rem/1 var(--font-sans);\n}"))).toEqual(["bridge.css:3: font: bold 0.9rem/1 var(--font-sans)"]);
  expect(sheetSizes(css(".k-thing { font-size: 0.75em; }"))).toHaveLength(1);
  expect(pageSizes(tsx('<p className="text-[1.1rem] font-semibold" />'))).toHaveLength(1);
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
});

test("each check lets ordinary edits through", () => {
  expect(sheetSizes(css(".k-thing { font-size: var(--text-caption); height: var(--spacing-ctl-md); }\n.prose-keel sup { font-size: 0.75em; }\n/* font-size: 3rem */"))).toEqual([]);
  expect(pageSizes(tsx('// Tailwind text-sm is not used here.\n/* nor text-[1.1rem] */\nconst tick = { fontSize: "var(--text-micro)" };\n<p className="text-ui text-[color:var(--x)] text-[var(--c)]" />'))).toEqual([]);
  expect(segmented(tsx('<Seg kind="tabs" label="View" value={v} onChange={set} options={o} />\n// role="tablist" is the Seg component\'s'), [])).toEqual([]);
  expect(empties(tsx('<p className="text-caption text-muted">No further approval is asked for this folder.</p>'), [])).toEqual([]);
  expect(pageTimes(tsx('const n = (1234567).toLocaleString();\nconst m = total.toLocaleString("en-US");\nconst d = new Date(ts).toLocaleDateString();'))).toEqual([]);
  expect(daemonTimes(tsx('const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", {\n  hour: "2-digit",\n  minute: "2-digit",\n  hourCycle: "h23",\n});\nconst zone = Intl.DateTimeFormat().resolvedOptions().timeZone;', "fleet/resume.ts"))).toEqual([]);
  expect(selectors(css(".k-thing[data-open] > .k-part:hover, .dark .k-thing { color: red; }\nsvg.text-warn { color: var(--warn); }\n@keyframes k-x { from { opacity: 0; } }\n@media (max-width: 767px) { .k-thing { color: red; } }"))).toEqual([]);
  // An own class is named k-: a bare .grid would be the utility of that name.
  expect(selectors(css(".k-chart .k-grid line { stroke: var(--line); }"))).toEqual([]);
  expect(selectors(css(".k-chart .grid line { stroke: var(--line); }"))).toEqual(["bridge.css:1: .grid in .k-chart .grid line"]);
});
