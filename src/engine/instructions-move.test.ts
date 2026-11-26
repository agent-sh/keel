// A session moved (or cloned) to another folder is told that folder's instruction files as a fresh
// start there loads them on its window, less what its prompt carries already.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instructionFilter, instructionsMade, instructionsMoved } from "./turn.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? `${process.env.HOME}/.cache/tmp`, "inst-move-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const shared = `# Rules\n\n${Array.from({ length: 30 }, (_, i) => `- shared rule ${i}: the same in both checkouts.`).join("\n")}\n`;
// Two checkouts side by side under one folder with a file of its own: the same rules, one changed, and a long tail.
function checkouts(name: string) {
  const top = join(root, name), one = join(top, "one"), two = join(top, "two");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  writeFileSync(join(top, "AGENTS.md"), "PARENT-RULE: said once, above both.\n");
  writeFileSync(join(one, "AGENTS.md"), `${shared}\n## Local\n\n- LOCAL-OLD: the rule before.\n`);
  const tail = Array.from({ length: 1300 }, (_, i) => `- filler line ${i} of the long file, to pass a small window.`).join("\n");
  writeFileSync(join(two, "AGENTS.md"), `${shared}\n## Local\n\n- LOCAL-NEW: the changed rule.\n\n## Long\n\n${tail}\n\nEND-RULE: the last line.\n`);
  return { top, one, two };
}

test("a move carries what a fresh start loads, less what the prompt holds, sized by the window", () => {
  const { one, two } = checkouts("move");
  const big = instructionsMoved(two, one, 1_000_000);
  // The folder above both is in the prompt already.
  expect(big.text).not.toContain("PARENT-RULE");
  expect(big.files.find((f) => f.path.endsWith("move/AGENTS.md"))?.state).toBe("had");
  // The rules both checkouts say are carried once (in the prompt), the changed one is here.
  expect(big.text).not.toContain("shared rule 7:");
  expect(big.text).toContain("Left out here");
  expect(big.text).toContain("LOCAL-NEW");
  // A large window takes the whole file, as a fresh start there does.
  expect(big.text).toContain("END-RULE");
  expect(instructionsMade(two, 1_000_000).text).toContain("END-RULE");
  // A small one cuts it, and says where the rest is.
  const small = instructionsMoved(two, one, 32_000);
  expect(small.text).not.toContain("END-RULE");
  expect(small.text).toContain("(Cut here:");
  expect(small.text).toMatch(new RegExp(`Read ${join(two, "AGENTS.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from line \\d+`));
  expect(small.files.find((f) => f.path === join(two, "AGENTS.md"))?.state).toBe("cut");
});

test("a sibling checkout's identical file is named, not carried again", () => {
  const { one, two } = checkouts("same");
  writeFileSync(join(two, "AGENTS.md"), readFileSync(join(one, "AGENTS.md")));
  const m = instructionsMoved(two, one, 200_000);
  expect(m.text).not.toContain("LOCAL-OLD");
  expect(m.text).toContain(`(The same as ${join(one, "AGENTS.md")}, above.)`);
});

test("a move carries the version the owner trusted, never an untrusted edit", () => {
  const { one, two } = checkouts("trust");
  const file = join(two, "AGENTS.md");
  const was = instructionFilter.file;
  instructionFilter.file = (p, t) => (p === file ? "# Local\n\n- TRUSTED-RULE: the version last trusted.\n" : t);
  try {
    const m = instructionsMoved(two, one, 200_000);
    expect(m.text).toContain("TRUSTED-RULE");
    expect(m.text).not.toContain("LOCAL-NEW");
    expect(m.files.find((f) => f.path === file)?.trust).toBe("as_trusted");
  } finally {
    instructionFilter.file = was;
  }
});

// This repository's own AGENTS.md, as a move into a folder that holds it gives it on a 200K window and
// on a larger one: whole, or cut with the line that says where its rest is, never cut silently.
test("this repository's AGENTS.md is never cut silently on a move", () => {
  const here = readFileSync(join(import.meta.dir, "../../AGENTS.md"), "utf8");
  const from = join(root, "repo", "a"), to = join(root, "repo", "b");
  mkdirSync(from, { recursive: true });
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, "AGENTS.md"), here);
  for (const window of [200_000, 400_000, 1_000_000]) {
    const m = instructionsMoved(to, from, window);
    const f = m.files.find((x) => x.path === join(to, "AGENTS.md"))!;
    if (f.state === "whole") expect(m.text).toContain(here.trimEnd().split("\n").at(-1)!);
    else {
      expect(f.state).toBe("cut");
      expect(m.text).toContain(`Read ${join(to, "AGENTS.md")} from line`);
    }
  }
});

// A file is named after another only when the model holds that other's text as it is on disk.
test("a file the same as one held back or loaded as last trusted is carried itself", () => {
  const was = instructionFilter.file;
  for (const [name, f] of [["held", () => null], ["old", () => "# Rules\n\n- OLDRULE: the version last trusted.\n"]] as const) {
    const { top, one, two } = checkouts(`same-${name}`);
    writeFileSync(join(two, "AGENTS.md"), readFileSync(join(one, "AGENTS.md")));
    const F = join(one, "AGENTS.md");
    instructionFilter.file = (p, t) => (p === F ? f() : t);
    try {
      // On a move: the old folder's file never reached the model as it reads.
      const m = instructionsMoved(two, one, 200_000);
      expect(m.text).toContain("LOCAL-OLD");
      expect(m.text).not.toContain("(The same as");
      // Within one chain: a folder above holds the held file, the folder below the same text.
      writeFileSync(join(top, "AGENTS.md"), readFileSync(F));
      instructionFilter.file = (p, t) => (p === join(top, "AGENTS.md") ? f() : t);
      const c = instructionsMade(one, 200_000);
      expect(c.text).toContain("LOCAL-OLD");
      expect(c.files.find((x) => x.path === F)?.state).toBe("whole");
    } finally {
      instructionFilter.file = was;
    }
  }
});
