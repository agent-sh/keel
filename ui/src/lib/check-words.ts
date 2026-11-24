// The checks a branch's head was read on, in words: the one wording the work board's card and the tree
// review share, so a check that did not run is named in both (src/board/board.ts keeps the facts).
export type NamedChecks = { passed: string[]; failed: string[]; notRun: string[] };

export function checksWords(c: NamedChecks): string {
  if (c.failed.length) return `check failed: ${c.failed.join(", ")}`;
  if (c.notRun.length && !c.passed.length) return `not run: ${c.notRun.join(", ")}`;
  return `passed: ${c.passed.join(", ")}${c.notRun.length ? `; not run: ${c.notRun.join(", ")}` : ""}`;
}
