// A rule over the UI's source, not a test of one function: every text field
// whose key handler acts on Enter asks composing() first. The Enter that
// confirms an input method's word is not the field's, and a field that forgets
// it saves or sends a half-written word. The rule reads each component and
// names the fields that break it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
const root = join(import.meta.dir, "..");

// From an opening bracket to the one that closes it.
function balanced(s: string, from: number): string {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if ("{([".includes(s[i]!)) depth++;
    else if ("})]".includes(s[i]!) && --depth === 0) return s.slice(from, i + 1);
  }
  return s.slice(from);
}

// The element an attribute belongs to: the nearest tag before it that is not inside braces
// (an element written inside an earlier attribute's value is).
function tagOf(s: string, at: number): string {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (s[i] === "}") depth++;
    else if (s[i] === "{") depth--;
    else if (s[i] === "<" && depth === 0 && /[A-Za-z]/.test(s[i + 1] ?? "")) return s.slice(i + 1).match(/^[\w.]+/)![0];
  }
  return "";
}

// A handler named in place of written: the statement of the same file that declares it.
function declared(s: string, name: string): string {
  const at = s.search(new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`));
  if (at < 0) return "";
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if ("{([".includes(s[i]!)) depth++;
    else if ("})]".includes(s[i]!)) depth--;
    else if (depth === 0 && (s[i] === ";" || s[i] === "\n")) return s.slice(at, i);
  }
  return s.slice(at);
}

export function unguarded(path: string, source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bonKeyDown=\{/g)) {
    const tag = tagOf(source, m.index);
    if (tag !== "input" && tag !== "textarea" && !tag.endsWith(".Input")) continue;
    const value = balanced(source, m.index + m[0].length - 1);
    const name = value.slice(1, -1).trim();
    const text = /^\w+$/.test(name) ? declared(source, name) : value;
    if (/["']Enter["']/.test(text) && !text.includes("composing(")) out.push(`${path}:${source.slice(0, m.index).split("\n").length}`);
  }
  return out;
}

test("the rule finds a field that acts on Enter without asking, and passes one that asks", () => {
  expect(unguarded("a.tsx", `const A = () => <input onKeyDown={(e) => e.key === "Enter" && save()} />;`)).toEqual(["a.tsx:1"]);
  expect(unguarded("a.tsx", `const keys = (e) => { if (e.key === "Enter") save(); };\nconst A = () => <textarea onKeyDown={keys} />;`)).toEqual(["a.tsx:2"]);
  expect(unguarded("a.tsx", `const A = () => <input onKeyDown={(e) => e.key === "Enter" && !composing(e) && save()} />;`)).toEqual([]);
  // A row or a button is not a text field: no word is composed there.
  expect(unguarded("a.tsx", `const A = () => <div onKeyDown={(e) => e.key === "Enter" && open()} />;`)).toEqual([]);
});

test("every field that acts on Enter asks composing() first", () => {
  const found: string[] = [];
  for (const f of new Bun.Glob("**/*.tsx").scanSync(root)) found.push(...unguarded(relative(join(root, ".."), join(root, f)), readFileSync(join(root, f), "utf8")));
  expect(found.sort()).toEqual([]);
});
