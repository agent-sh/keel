// One word per act and thing, in everything the page says to the owner.
// The page's strings are read from its source (string literals, template
// text and the text between tags) and none may use a word this file retired:
//
//   folder, not workspace   where a session works
//   pane, not station       a session's place on the screen
//   resume, not continue    making a stopped or cut session go on
//
// Resume is that one act. The acts that used to share the word have their own:
//
//   take over               ending a session in another tool and going on with it here
//   turn on, turn off       a loop, which is a schedule and has no cut work to go on with
//                           (the daemon's notes already say "turned off")
//   end the snooze          alerts held for a while
//
// A goal is still resumed: a paused goal goes on by its session's turns, the same act.
//
// Code keeps its own names (a `workspace` field, a `k-station` class, the
// `workspace-write` sandbox id): identifiers, class names, test ids, paths and
// a command's search words are not what the owner reads.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WATCH_LABEL } from "../../../src/core/watch.ts";
import { MODES } from "../../../src/safety/policy.ts";

type Found = { file: string; line: number; text: string };

// Comments out, with strings and templates kept whole.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!, d = src[i + 1];
    if (c === "/" && d === "/" && src[i - 1] !== ":") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; else if (c !== "`" && src[j] === "\n") break; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function uiStrings(dir: string): Found[] {
  const found: Found[] = [];
  for (const rel of new Bun.Glob("**/*.{ts,tsx}").scanSync(dir)) {
    if (rel.endsWith(".test.ts") || rel.endsWith(".d.ts")) continue;
    const src = stripComments(readFileSync(join(dir, rel), "utf8"));
    const line = (at: number) => src.slice(0, at).split("\n").length;
    // String literals and template text.
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      // A placeholder is a mark that is not a space, so an id built by a template (`station.to.${n}`) stays one word.
      const text = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, "…");
      const before = src.slice(Math.max(0, m.index - 24), m.index);
      // A palette command's search words are synonyms on purpose; a class list is styling; an id is not read by anyone.
      if (/\b(words|id):\s*$/.test(before) || /className=\{?\s*$/.test(before) || /\b(cn|clsx)\(\s*$/.test(before)) continue;
      found.push({ file: rel, line: line(m.index), text });
    }
    // Text between tags in a .tsx file.
    if (rel.endsWith(".tsx")) for (const m of src.matchAll(/[>}]([^<>{}=;()`"']*[A-Za-z]{2}[^<>{}=;()`"']*)(?=[<{])/g)) found.push({ file: rel, line: line(m.index), text: m[1]! });
  }
  return found;
}

// What the owner reads: words in a sentence or a label. Not a path, an
// address, an identifier or a kebab id.
const owned = (t: string) => {
  const s = t.trim();
  if (!s || /^[./@~]|^https?:|\/api\//.test(s)) return false;
  if (!/\s/.test(s) && !/^[A-Z][a-z]/.test(s)) return false;
  // Code between two strings (a quote inside text upsets the pairing): not a string.
  if (/&&|\|\||=>|===|!==|\s\?\s/.test(s)) return false;
  return true;
};

const RETIRED: { word: string; use: string; re: RegExp; only?: RegExp }[] = [
  { word: "workspace", use: "folder", re: /(?<![\w.$/-])workspaces?(?![\w-])/i },
  { word: "station", use: "pane", re: /(?<![\w.$/-])stations?(?![\w-])/i },
  // Nothing else on the page is "continued" either: a turn goes on, a reply is from a branch, a session is taken to another tool.
  { word: "continue", use: "resume", re: /(?<![\w.$/-])continu(e|es|ed|ing)(?![\w-])/i },
  // Where the act is another one, "resume" is the retired word.
  { word: "resume", use: "take over", re: /(?<![\w.$/-])resum(e|es|ed|ing)(?![\w-])/i, only: /^components\/(ResumeFrom|ImportSheet)\.tsx$/ },
  { word: "resume", use: "turn on", re: /(?<![\w.$/-])resum(e|es|ed|ing)(?![\w-])/i, only: /^components\/automation\/(LoopsPanel|BackgroundPopover)\.tsx$/ },
  { word: "resume", use: "end the snooze", re: /(?<![\w.$/-])resum(e|es|ed|ing)(?![\w-])/i, only: /^components\/automation\/Snooze\.tsx$/ },
];

// The form a string takes once reworded, for the ones known to be on their way
// from other work: the failure names it.
const SAY: [RegExp, string][] = [
  [/continues by itself at/i, "Resumes by itself at"],
  [/continue now/i, "Resume now"],
];
const reworded = (text: string) => SAY.find(([re]) => re.test(text))?.[1];

test("the page says folder, pane and resume: one word per act and thing", () => {
  // An id built by a template is not a sentence; a sentence with a placeholder in it is.
  expect(owned("station.to.…")).toBe(false);
  expect(owned("… stations open")).toBe(true);
  const bad: string[] = [];
  for (const s of uiStrings(join(import.meta.dir, ".."))) {
    if (!owned(s.text)) continue;
    for (const r of RETIRED) if ((!r.only || r.only.test(s.file)) && r.re.test(s.text)) bad.push(`${s.file}:${s.line}: "${s.text.trim().replace(/\s+/g, " ").slice(0, 120)}" says ${r.word}; ${reworded(s.text) ? `say "${reworded(s.text)}"` : `the word is ${r.use}`}`);
  }
  // Labels the daemon hands the page as they are: the permission modes and the state words.
  for (const m of MODES) for (const text of [m.name, m.summary, m.description]) for (const r of RETIRED) if (!r.only && r.re.test(text)) bad.push(`mode ${m.id}: "${text}" says ${r.word}; the word is ${r.use}`);
  for (const text of Object.values(WATCH_LABEL)) for (const r of RETIRED) if (!r.only && r.re.test(text)) bad.push(`state: "${text}" says ${r.word}; the word is ${r.use}`);
  expect(bad).toEqual([]);
});
