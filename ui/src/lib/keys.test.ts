// A rule over the UI's source, not a test of one function: every text field
// whose key handler acts on Enter asks composing() first. The Enter that
// confirms an input method's word is not the field's, and a field that forgets
// it saves or sends a half-written word. The rule reads each component and
// names the fields that break it.
//
// What it reads: a key handler (down, up, press, their capture forms) written
// on an input, a textarea, a component (any capitalized tag: it may hand the
// handler to a field), in place or as a function of the same file, with the
// functions of that file it calls. A handler it cannot read (one that comes
// from props or another file) is named too, to be looked at by hand.
//
// What it does not see, so a review still has to:
// - a handler on a plain element around a field (a div, a form) that acts on
//   the field's Enter;
// - Enter spelled some other way than "Enter", "NumpadEnter" or key code 13
//   (a table of keys, a helper that matches a shortcut);
// - composing() asked on another branch than the one Enter takes;
// - props spread onto a field, and handlers attached outside JSX (.ts files).
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

// A function named in place of written: the statement of the same file that declares it
// (to its semicolon, or for `function name() {}` to the brace that closes it).
function declared(s: string, name: string): string {
  const m = s.match(new RegExp(`\\b(const|let|function)\\s+${name}\\b`));
  if (!m) return "";
  let depth = 0;
  for (let i = m.index!; i < s.length; i++) {
    if ("{([".includes(s[i]!)) depth++;
    else if ("})]".includes(s[i]!)) { if (--depth === 0 && m[1] === "function" && s[i] === "}") return s.slice(m.index!, i + 1); }
    else if (depth === 0 && s[i] === ";") return s.slice(m.index!, i);
  }
  return s.slice(m.index!);
}

const ENTER = /["'](?:Numpad)?Enter["']|keyCode\s*===?\s*13\b/;
const WORDS = new Set(["if", "for", "while", "switch", "return", "function", "catch", "typeof", "composing"]);

export function unguarded(path: string, source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bonKey(?:Down|Up|Press)(?:Capture)?=\{/g)) {
    const tag = tagOf(source, m.index);
    if (tag !== "input" && tag !== "textarea" && !/^[A-Z]/.test(tag)) continue;
    const at = `${path}:${source.slice(0, m.index).split("\n").length}`;
    const value = balanced(source, m.index + m[0].length - 1);
    const name = value.slice(1, -1).trim();
    let text = value;
    if (/^[\w.]+$/.test(name)) {
      text = declared(source, name);
      if (!text) { out.push(`${at} (its handler ${name} is not in this file: read it by hand)`); continue; }
    }
    // The functions of this file the handler calls: one that only passes the key on is read through.
    for (const call of text.matchAll(/(?<![.\w])([A-Za-z_]\w*)\(/g)) if (!WORDS.has(call[1]!)) text += declared(source, call[1]!);
    if (ENTER.test(text) && !text.includes("composing(")) out.push(at);
  }
  return out;
}

test("the rule finds a field that acts on Enter without asking, and passes one that asks", () => {
  expect(unguarded("a.tsx", `const A = () => <input onKeyDown={(e) => e.key === "Enter" && save()} />;`)).toEqual(["a.tsx:1"]);
  expect(unguarded("a.tsx", `const keys = (e) => { if (e.key === "Enter") save(); };\nconst A = () => <textarea onKeyDown={keys} />;`)).toEqual(["a.tsx:2"]);
  expect(unguarded("a.tsx", `const A = () => <input onKeyDown={(e) => e.key === "Enter" && !composing(e) && save()} />;`)).toEqual([]);
  // A row or a button is not a text field: no word is composed there.
  expect(unguarded("a.tsx", `const A = () => <div onKeyDown={(e) => e.key === "Enter" && open()} />;`)).toEqual([]);
  // A component may hand its handler to a field; the other key events and spellings of Enter count.
  expect(unguarded("a.tsx", `const A = () => <Field onKeyDown={(e) => e.key === "Enter" && save()} />;`)).toEqual(["a.tsx:1"]);
  expect(unguarded("a.tsx", `const A = () => <input onKeyUp={(e) => e.keyCode === 13 && save()} />;`)).toEqual(["a.tsx:1"]);
  expect(unguarded("a.tsx", `const A = () => <input onKeyDownCapture={(e) => e.code === "NumpadEnter" && save()} />;`)).toEqual(["a.tsx:1"]);
  // A handler whose body is on the next line, a function declaration, and an arrow that passes the key on.
  expect(unguarded("a.tsx", `const keys = (e) =>\n  e.key === "Enter" && save();\nconst A = () => <input onKeyDown={keys} />;`)).toEqual(["a.tsx:3"]);
  expect(unguarded("a.tsx", `function keys(e) {\n  if (e.key === "Enter") save();\n}\nconst A = () => <input onKeyDown={(e) => keys(e)} />;`)).toEqual(["a.tsx:4"]);
  expect(unguarded("a.tsx", `function keys(e) {\n  if (composing(e)) return;\n  if (e.key === "Enter") save();\n}\nconst A = () => <input onKeyDown={(e) => keys(e)} />;`)).toEqual([]);
  // A handler that is not in the file cannot be read: it is named.
  expect(unguarded("a.tsx", `const A = ({ onKeys }) => <input onKeyDown={onKeys} />;`)).toEqual(["a.tsx:1 (its handler onKeys is not in this file: read it by hand)"]);
  expect(unguarded("a.tsx", `const A = (props) => <textarea onKeyDown={props.keys} />;`)).toEqual(["a.tsx:1 (its handler props.keys is not in this file: read it by hand)"]);
});

test("every field that acts on Enter asks composing() first", () => {
  const found: string[] = [];
  for (const f of new Bun.Glob("**/*.tsx").scanSync(root)) found.push(...unguarded(relative(join(root, ".."), join(root, f)), readFileSync(join(root, f), "utf8")));
  expect(found.sort()).toEqual([]);
});
