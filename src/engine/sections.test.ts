import { expect, test } from "bun:test";
import { Carried, linesOf, sectionsOf } from "./sections.ts";
import { blockDiff } from "./prompt-note.ts";

const long = (tag: string) => Array.from({ length: 6 }, (_, i) => `- ${tag} ${i}: a rule long enough to be worth a line of its own.`).join("\n");

test("sections: blank lines and headings part them, a heading is its own, a fence is one with its blank lines", () => {
  const t = "# Title\nintro\n\n- a\n- b\n\n```\ncode\n# not a heading\n\nmore\n```\n## Next\nbody";
  expect(sectionsOf(t).map((s) => [s.key, s.heading, s.under])).toEqual([
    ["# Title", true, ""], ["intro", false, "# Title"], ["- a\n- b", false, "# Title"], ["```\ncode\n# not a heading\n\nmore\n```", false, "# Title"],
    ["## Next", true, ""], ["body", false, "# Title\n## Next"],
  ]);
  expect(sectionsOf("## Alone\n\nbody").map((s) => s.heading)).toEqual([true, false]);
});

test("a section the chain carries is left out with one line; a new rule keeps its heading; a short run stays", () => {
  const c = new Carried();
  c.add(`# Shared\n\n${long("A")}\n\n## Tests\n\n${long("T")}\n\nok`, "/shared.md");
  const text = `<!-- copy -->\n# Shared\n\n${long("A")}\n\n## Tests\n\n${long("T")}\n\n## Mine\n\n${long("M")}\n\nok\n`;
  const r = c.fresh("/copy.md", text);
  expect(r.left).toBe(1);
  // "# Shared" stays: "## Mine" is under it.
  expect(r.text).toBe(`<!-- copy -->\n# Shared\n\n(Left out here: 2 sections under "# Shared", "## Tests" the same as in /shared.md, above.)\n\n## Mine\n\n${long("M")}\n\nok\n`);
  // Its new sections are carried from then on, from this file.
  expect(c.fresh("/third.md", `# Shared\n\n## Mine\n\n${long("M")}`).text).toBe(`(Left out here: a section under "## Mine" the same as in /copy.md, above.)`);
  // Each kept line still names its line on disk.
  const mine = r.text.indexOf("## Mine");
  expect(r.lines.find((x) => x.at === mine)).toEqual({ at: mine, path: "/copy.md", line: text.split("\n").indexOf("## Mine") + 1 });
  expect(linesOf("a\nb", "/x").map((x) => x.at)).toEqual([0, 2]);
});

test("a block's note does not tell again what only moved to another file", () => {
  const before = `# /u/.codex/AGENTS.md\n\n${long("S")}\n\n# /r/AGENTS.md\n\n${long("R")}\n`;
  const after = `# /u/.codex/AGENTS.md\n\n(Left out here: a section the same as in /shared.md, above.)\n\n# /u/.claude/CLAUDE.md\n\n${long("S")}\n\n# /r/AGENTS.md\n\n${long("R")}\n\n- NEW rule\n`;
  const d = blockDiff(before, after, () => true);
  expect(d).not.toContain("S 0:");
  expect(d).toContain("+- NEW rule");
  expect(d).toContain("New: /u/.claude/CLAUDE.md.");
  // A file whose heading went that is still on disk is not called deleted.
  const gone = blockDiff(before, `# /r/AGENTS.md\n\n${long("R")}\n`, () => true);
  expect(gone).toContain("No longer read on its own: /u/.codex/AGENTS.md.");
  expect(gone).not.toContain("Deleted");
  expect(blockDiff(before, `# /r/AGENTS.md\n\n${long("R")}\n`, () => false)).toContain("Deleted (or no longer found where it was read): /u/.codex/AGENTS.md.");
});

test("the same words under another heading are another rule: each probe keeps its text", () => {
  const X = "- Run the full test suite before every push; a red suite never lands, whatever the reason given for it.";
  const later = (first: string, then: string) => { const c = new Carried(); c.add(first, "/root/AGENTS.md"); return c.fresh("/root/pkg/AGENTS.md", then).text; };
  // A scope line: what Codex is told under its own heading is not Claude's.
  expect(later("## Claude Code only\n\n" + X, "## Codex only\n\n" + X)).toBe("## Codex only\n\n" + X);
  // A rule a package says again under its own heading, beside its own rules.
  for (const [first, then] of [
    ["# Root\n\n" + X, "## Pkg rules\n\n" + X + "\n\n- Pkg only: never import from ../server."],
    ["# Root\n\n" + X, "# Pkg\n\n- Use pnpm here.\n\n" + X + "\n\nThe rule above applies here to the e2e suite too, not only unit tests."],
    ["## Rules\n\n" + X + "\n\n- b", "## Rules here\n\n- a: pkg first.\n\n" + X + "\n\n- c"],
  ]) expect(later(first!, then!)).toBe(then!);
  // Under the same heading it is carried, and a heading goes only when all under it does.
  const c = new Carried();
  c.add(`## Tests\n\n${long("T")}`, "/a.md");
  expect(c.fresh("/b.md", `## Tests\n\n${long("T")}\n\n- own: kept.\n`).text).toBe(`## Tests\n\n(Left out here: a section under "## Tests" the same as in /a.md, above.)\n\n- own: kept.\n`);
  // The chain's own path lines are no file's heading: the bare text is still the key.
  expect(sectionsOf("# /u/AGENTS.md\n\nbody").map((x) => x.scoped)).toEqual(["# /u/AGENTS.md", "\nbody"]);
});

test("a text recorded as far as it is kept: what a cut left out is carried by no file", () => {
  const c = new Carried();
  const text = `${long("A")}\n\n${long("B")}\n`;
  const r = c.fresh("/a.md", text, undefined, { record: false });
  r.commit(text.indexOf("- B 0"));
  expect(c.fresh("/b.md", `${long("A")}\n\n${long("B")}\n`).text).toBe(`(Left out here: a section the same as in /a.md, above.)\n\n${long("B")}\n`);
});

const X = "- Run the full test suite before every push; a red suite never lands, whatever the reason given for it.";
const Y = "- Style: keep each line under one hundred characters, and wrap prose at the sentence, never mid clause.";

test("nested headings: a section is told by every heading above it, and a parent stays while any of its own does", () => {
  const c = new Carried();
  c.add("# Claude Code only\n\n## Tests\n\n" + X + "\n", "/home/.claude/CLAUDE.md");
  // The same sub-heading under another parent is another scope: the Codex-only rules keep their parent.
  const codex = "# Codex only\n\n## Tests\n\n" + X + "\n\n## Style\n\n" + Y + "\n";
  expect(c.fresh("/home/.codex/AGENTS.md", codex).text).toBe(codex);
  // Under the same parent the carried sub-section goes; the parent and its other child stay.
  const d = new Carried();
  d.add("# Shared\n\n## Tests\n\n" + X + "\n", "/a.md");
  expect(d.fresh("/b.md", "# Shared\n\n## Tests\n\n" + X + "\n\n## Style\n\n" + Y + "\n").text)
    .toBe(`# Shared\n\n(Left out here: a section under "## Tests" the same as in /a.md, above.)\n\n## Style\n\n${Y}\n`);
});

test("a heading with its first line glued under it is a heading of its own", () => {
  const later = (first: string, then: string) => { const c = new Carried(); c.add(first, "/root/AGENTS.md"); return c.fresh("/root/pkg/AGENTS.md", then).text; };
  // The scope a glued line opens is its own heading, not the one before it.
  const scope = "# Root\n\n## Codex only\n- Codex reads this first.\n\n" + X;
  expect(later("# Root\n\n## Claude Code only\n- Claude reads this first.\n\n" + X, scope)).toBe(scope);
  // A glued copy under the same headings is carried.
  const body = "## Testing\n" + X + "\n- and one more line of the same rule block here.";
  expect(later("# Shared\n\n" + body, "# Shared\n\n" + body)).toBe(`(Left out here: a section under "## Testing" the same as in /root/AGENTS.md, above.)`);
  expect(sectionsOf("## Codex only\n- a\n\n- b").map((s) => [s.key, s.heading, s.under])).toEqual([["## Codex only", true, ""], ["- a", false, "## Codex only"], ["- b", false, "## Codex only"]]);
});
