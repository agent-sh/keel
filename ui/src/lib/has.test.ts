// A `:has()` rule tells the engine where to look again when something changes: the element the
// rule looks from, and which of its descendants the rule can restyle. A rule that ends in "any
// descendant" names all of them, and engines keep one such list for every `:has()` rule of the
// page: with one such rule, every row a reply adds restyles the whole pane it is in (in an older
// Chromium also the rows out of view, which were skipped until then). The utility framework's
// `group-has-*` and `peer-has-*` variants write exactly that rule, so the page does not use them:
// a rule of its own stylesheet that ends in a class does the same, or the state is held in script.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const files = (pattern: string) => [...new Glob(pattern).scanSync(root)].filter((f) => !f.endsWith(".test.ts")).map((f) => ({ f, text: readFileSync(join(root, f), "utf8") }));

test("no class of the page is a group-has or peer-has variant", () => {
  const found = files("**/*.{ts,tsx}").flatMap(({ f, text }) => text.split("\n").flatMap((line, i) => (/\b(group|peer)-has-/.test(line) ? [`${f}:${i + 1}`] : [])));
  expect(found).toEqual([]);
});

test("no :has() rule of the page's stylesheets ends in any descendant", () => {
  // After the `:has(...)`, a combinator and then `*`, or nothing but a pseudo-class: any element.
  const any = /:has\((?:[^()]|\([^()]*\))*\)[^,{]*[\s>~+](?:\*|:(?!:)[a-z-]+(?:\([^)]*\))?)\s*(?:[,{]|$)/;
  const found = files("**/*.css").flatMap(({ f, text }) => text.split("\n").flatMap((line, i) => (any.test(line.split("{")[0] ?? "") ? [`${f}:${i + 1}`] : [])));
  expect(found).toEqual([]);
  expect(any.test(":where(.group):has(.k-allow:focus) * {")).toBe(true);
  expect(any.test(".k-card:has(.x) :hover {")).toBe(true);
  expect(any.test(".k-approval:has(.k-allow:focus) .k-hint[data-live] {")).toBe(false);
  expect(any.test(".k-station:has(> .k-aim) .k-band::after {")).toBe(false);
});
