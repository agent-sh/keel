// A class has its own rule in one stylesheet. Two sheets that each open a
// rule for the same class name restyle each other's elements: a new class
// named like the rail's actions drew the rail's buttons as small squares.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// The classes a sheet gives a rule of their own: `.k-name {`, alone as the selector (also inside a media query).
export function ownRules(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((sel) => /^\.k-[a-z0-9-]+$/.test(sel)).map((sel) => sel.slice(1));
}

test("a class's own rule is read as the selector alone", () => {
  expect(ownRules(".k-a { x: 1 }\n.k-a:hover { x: 2 }\n.k-b,\n.k-c { x: 3 }\n@media (hover: none) { .k-f { x: 4 } }\n/* .k-d { } */\n.k-e\n{ x: 5 }\n.k-g .k-h { x: 6 }")).toEqual(["k-a", "k-f", "k-e"]);
});

// Collisions that stand today, each owed to the lane that owns the sheet. A name leaves this list
// with its fix: the test fails for a name listed here that no longer collides, and for any new one.
//   .k-chip: toolkit.css rules it for the surfaces' chips (a height, a weight, no ground) and
//   transcript.css for a call's chips (a sunken ground, another radius). Each sheet's rule reaches
//   the other's chips: a language server's chip gets the transcript's ground, a call's chip the
//   toolkit's height and weight.
const KNOWN = [".k-chip in toolkit.css and transcript.css"];

test("no class has a rule of its own in two stylesheets", () => {
  const where = new Map<string, Set<string>>();
  for (const f of new Bun.Glob("*.css").scanSync(root)) {
    for (const name of ownRules(readFileSync(join(root, f), "utf8"))) (where.get(name) ?? where.set(name, new Set()).get(name)!).add(f);
  }
  expect([...where].filter(([, files]) => files.size > 1).map(([name, files]) => `.${name} in ${[...files].sort().join(" and ")}`).sort()).toEqual(KNOWN);
  expect(where.size).toBeGreaterThan(100);
});
