// The stylesheets hold no sibling rule (+ or ~) with a side that has nothing
// to key on (no class, id or attribute: a bare tag or *). The browser applies
// such a rule to every element: each one removed anywhere makes it restyle
// the whole subtree of its parent, which for a transcript is every row
// (measured: ".k-card + *" alone cost a recalculation of 2,700 elements four
// times a turn and one of 7,400).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The selectors of a sheet: the text before each "{", without comments, at-rule heads and declarations.
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") { const head = text.slice(at, i).trim(); if (head && !head.startsWith("@")) out.push(...head.split(",").map((s) => s.trim())); at = i + 1; }
    else if (c === "}" || c === ";") at = i + 1;
  }
  return out;
}

// The compounds on both sides of each top-level + or ~ of a selector.
function besideSibling(sel: string): string[] {
  const out: string[] = [];
  const edge = (c: string) => c === " " || c === ">" || c === "+" || c === "~";
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (c === "+" || c === "~")) {
      let end = i;
      while (end > 0 && sel[end - 1] === " ") end--;
      let from = end;
      for (let d = 0; from > 0; from--) {
        const p = sel[from - 1]!;
        if (p === ")" || p === "]") d++;
        else if (p === "(" || p === "[") d--;
        else if (d === 0 && edge(p)) break;
      }
      let start = i + 1;
      while (start < sel.length && sel[start] === " ") start++;
      let to = start;
      for (let d = 0; to < sel.length; to++) {
        const p = sel[to]!;
        if (p === "(" || p === "[") d++;
        else if (p === ")" || p === "]") d--;
        else if (d === 0 && edge(p)) break;
      }
      out.push(sel.slice(from, end), sel.slice(start, to));
    }
  }
  return out;
}

test("no sibling rule has a side without a class, id or attribute", () => {
  const dir = join(import.meta.dir);
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".css"))) {
    for (const sel of selectors(readFileSync(join(dir, f), "utf8"))) {
      if (besideSibling(sel).some((side) => !/[.#\[]/.test(side))) bad.push(`${f}: ${sel}`);
    }
  }
  expect(bad).toEqual([]);
});

test("the check finds what it is for", () => {
  expect(besideSibling(".a > * + *")).toEqual(["*", "*"]);
  expect(besideSibling(".a li + li")).toEqual(["li", "li"]);
  expect(besideSibling(".k-card + *")).toEqual([".k-card", "*"]);
  expect(besideSibling(".k-card + .k-card")).toEqual([".k-card", ".k-card"]);
  expect(besideSibling(".k-rail[data-open] + .k-scroll")).toEqual([".k-rail[data-open]", ".k-scroll"]);
  expect(besideSibling(".a:has(+ .b)")).toEqual([]);
  expect(besideSibling(".k-find ~ div .k-src")).toEqual([".k-find", "div"]);
  expect(selectors("/* x + y */ .a + .b, i + b { c: calc(1px + 2px); } @media (x) { .c { d: e } }")).toEqual([".a + .b", "i + b", ".c"]);
});
