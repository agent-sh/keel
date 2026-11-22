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
import { OFFLINE, QUEUED, STATE_WORD } from "./core/state-words.ts";

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
// JSX), every other character and every line break in its place. Strings,
// templates and regular expressions are kept: a `//` inside one is not a
// comment. A quote opens a string only when it closes on its line, so an
// apostrophe in JSX text does not swallow what follows it.
function code(text: string, css = false): string {
  const out = text.split("");
  let i = 0;
  const blank = (to: number) => { for (; i < to; i++) if (out[i] !== "\n") out[i] = " "; };
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
    const before = text.slice(0, from).trimEnd();
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
  while (i < text.length) {
    const c = text[i]!, two = text.slice(i, i + 2);
    let end = -1;
    if (two === "/*") {
      end = text.indexOf("*/", i + 2);
      blank(end < 0 ? text.length : end + 2);
    } else if (!css && two === "//" && text[i - 1] !== ":") {
      end = text.indexOf("\n", i);
      blank(end < 0 ? text.length : end);
    } else if ((c === '"' || c === "'") && (end = closes(i, c, css)) > 0) i = end + 1;
    else if (!css && c === "`" && (end = closes(i, c, true)) > 0) i = end + 1;
    else if (!css && c === "/" && (end = regex(i)) > 0) i = end + 1;
    else i++;
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
// A string is a class list when every word of it could be a class: prose (a
// capital, a full stop, a comma) is not, so a sentence that names a utility is
// not a use of it.
const classList = (value: string) => { const w = value.split(/\s+/).filter(Boolean); return w.length > 0 && w.every((c) => /^[a-z0-9@!*&[-](\S*[^\s.,;?])?$/.test(c)) ? w : []; };
// Every class named in a module: the words of its class lists.
const classes = (text: string) => strings(text).flatMap((s) => classList(s.value).map((c) => ({ c, line: s.line })));

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
    if (s.file === "lib/utils.ts") continue;
    for (const c of calls(s.text, /\.toLocaleTimeString/)) out.push(at(s, c.line, "toLocaleTimeString"));
    for (const c of calls(s.text, /\.toLocaleString/)) if (/\b(hour|timeStyle)\b/.test(c.args) || (!c.args.trim() && /Date\([^()]*\)\s*$/.test(c.before))) out.push(at(s, c.line, "toLocaleString with a time"));
    for (const c of calls(s.text, /Intl\.DateTimeFormat/)) if (/\b(hour|minute|second|timeStyle)\b/.test(c.args)) out.push(at(s, c.line, "Intl.DateTimeFormat with a time"));
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
const STATE_SURFACES = /^(lib\/(home|watch|rows|waiting|automation)\.ts|components\/(Sidebar|Bridge|HomeWatch|StartBox|ProjectPage|Palette|TurnControls|TimelinePanel|Attention|Mark|Where|Fleet|SessionHeader|SessionDock)\.tsx|components\/automation\/(SidebarExtras|BackgroundPopover|TranscriptExtras|InboxPanel|bits|AwayDigest|ActivityList|ChildApprovals)\.tsx)$/;
const OTHER_STATES: Record<string, string[]> = {
  // A verb of a tool's line ("Running bun test"), not a state.
  "lib/tools.ts": ["Running"],
  // The transcript's own lines are another lane's to move here (the file is skipped whole, below).
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
// The transcript's own lines ("Waiting for your approval", "Running ...", a turn's end) are being
// reworked by its own lane: its strings and their vocabulary forms are handed to it, and it is not read here.
const TRANSCRIPT = "components/Transcript.tsx";
function stateLiterals(list: Src[]): string[] {
  const out: string[] = [];
  const exact = new Set(STATE_TERMS);
  const lower = new Set([...STATE_TERMS, ...LOWER_TERMS].map((t) => t.toLowerCase()));
  const core = (t: string) => t.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
  const leads = (t: string, cased: boolean) => STATE_TERMS.some((w) => new RegExp(`^${w}\\s*[:,\u00b7]`, cased ? "" : "i").test(t));
  for (const s of list) {
    if (s.file === TRANSCRIPT) continue;
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
const STATE_CLASSES = ["k-row-state", "k-row-class", "k-row-queued", "k-station-word", "k-sum-word", "k-kids-word", "k-kids-new", "k-child-state", "k-rail-card-word", "k-where-reach", "k-home-recent-word", "k-pane-empty-word", "k-look-state", "k-dock-need", "k-marks-head", "k-face-state"];
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
test("the look is set by components and tokens, not by test ids or utility names", () => expect(selectors(sheets, page)).toEqual([]));
test("a label, a picked row and a switch are their shared class", () => expect(shared(page)).toEqual([]));
test("a state word is written once, in the vocabulary", () => expect(stateLiterals(page)).toEqual([]));
test("a state word is set in sentence case", () => expect(shoutedStates(sheets)).toEqual([]));

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
  // And no rule turns one to capitals.
  expect(shoutedStates(css(".k-row-state { font-weight: 700; text-transform: uppercase; }\n.k-rail .k-sum-word, .k-other { text-transform: uppercase; }"))).toHaveLength(2);
});

test("each check lets ordinary edits through", () => {
  // A status is an identifier, a sentence may use the word, the vocabulary itself writes it, and another thing's state is listed.
  expect(stateLiterals(tsx('const live = a.status === "running" || a.status === "waiting";\nconst hint = "Running sessions are listed once the agent view is set.";\n<span>{STATE_WORD.work}</span>\nconst STATE = {\n  waiting: { word: STATE_WORD.wait },\n};'))).toEqual([]);
  expect(stateLiterals(tsx('const said = "Waiting until it is idle";\nconst live = m.state === "offline";'))).toEqual([]);
  expect(stateLiterals(tsx('const SERVER = { error: "Failed" };', "components/surfaces/Mcp.tsx"))).toEqual([]);
  expect(shoutedStates(css(".k-stuck-head { text-transform: uppercase; }\n.k-station-identity .k-station-word { text-transform: none; }\n.k-aim.k-face-state { text-transform: uppercase; }"))).toEqual([]);
  expect(stateLiterals(tsx('<span>{n} failed</span>', "components/CodeCall.tsx"))).toEqual([]);
  expect(sheetSizes(css(".k-thing { font-size: var(--text-caption); height: var(--spacing-ctl-md); }\n.prose-keel sup { font-size: 0.75em; }\n/* font-size: 3rem */"))).toEqual([]);
  expect(pageSizes(tsx('// Tailwind text-sm is not used here.\n/* nor text-[1.1rem] */\nconst tick = { fontSize: "var(--text-micro)" };\n<p className="text-ui text-[color:var(--x)] text-[var(--c)]" />'))).toEqual([]);
  expect(segmented(tsx('<Seg kind="tabs" label="View" value={v} onChange={set} options={o} />\n// role="tablist" is the Seg component\'s'), [])).toEqual([]);
  expect(empties(tsx('<p className="text-caption text-muted">No further approval is asked for this folder.</p>'), [])).toEqual([]);
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
});
