import { expect, test } from "bun:test";
import { DESCRIPTION_CAP, fitListing } from "./skills.ts";

// Past the budget every name stays; the descriptions kept are those of the skills loaded most.
test("the skill listing keeps every name and the used skills' descriptions", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: `does thing ${i} `.repeat(20), uses: i === 39 ? 9 : i === 38 ? 3 : 0 }));
  const { lines, nameOnly } = fitListing(entries, 2_000);
  expect(lines.map((l) => l.split(":")[0]!.slice(2))).toEqual(entries.map((e) => e.name));
  expect(lines[39]).toContain("does thing 39");
  expect(lines[38]).toContain("does thing 38");
  expect(lines.join("\n").length).toBeLessThanOrEqual(2_000);
  expect(nameOnly.length).toBeGreaterThan(0);
  expect(nameOnly).not.toContain("skill-39");
  // One description is cut at the cap, as Claude Code cuts it.
  const one = fitListing([{ name: "long", description: "x".repeat(5_000), uses: 0 }], 100_000).lines[0]!;
  expect(one.length).toBe("- long: ".length + DESCRIPTION_CAP);
  expect(fitListing([{ name: "a", description: "fits", uses: 0 }]).nameOnly).toEqual([]);
});

// The budget is a share of the model's window (Claude Code: 1% at 4 characters a token), with a floor.
test("the skill listing's budget follows the model's context window", async () => {
  const { listingBudget, LISTING_FLOOR } = await import("./skills.ts");
  expect(listingBudget(200_000)).toBe(8_000);
  expect(listingBudget(1_000_000)).toBe(40_000);
  expect(listingBudget()).toBe(8_000);
  expect(listingBudget(16_000)).toBe(LISTING_FLOOR);
  const entries = Array.from({ length: 60 }, (_, i) => ({ name: `skill-${i}`, description: `does thing ${i} `.repeat(20), uses: 0 }));
  expect(fitListing(entries, listingBudget(200_000)).nameOnly.length).toBeGreaterThan(0);
  expect(fitListing(entries, listingBudget(1_000_000)).nameOnly).toEqual([]);
});

// A listing past its budget keeps the descriptions of the skills loaded most,
// so loading one changes its text. That is no change of the skills: the kept
// prompt's block must compare the same, and only a change of a skill makes
// the prompt again.
test("loading a skill does not change the listing block a kept prompt is compared by", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { allHooks } = await import("../engine/hooks.ts");
  const { blocksOf } = await import("../engine/prompt-store.ts");
  const { setSkillUsage } = await import("./skills.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "skills-cut-"));
  mkdirSync(join(dir, ".git"));
  const skill = (n: number, description = `does thing ${n} `.repeat(20)) => {
    mkdirSync(join(dir, ".claude/skills", `cut-${n}`), { recursive: true });
    writeFileSync(join(dir, ".claude/skills", `cut-${n}`, "SKILL.md"), `---\nname: cut-${n}\ndescription: ${description}\n---\nbody\n`);
  };
  for (let n = 0; n < 30; n++) skill(n);
  const uses = new Map<string, number>();
  const was = setSkillUsage({ uses: () => uses, record: () => {} });
  const hook = allHooks().find((h) => h.system && (h.system({ workspace: dir } as any) as any)?.name?.startsWith("Skills you can load"))!;
  // A small window: the floor of the budget, so most descriptions are cut.
  const render = async () => {
    const b = (await hook.system!({ workspace: dir } as any, { id: "m", context: 16_000 } as any)) as { name: string; text: string; data: string; same?: string };
    return { text: b.text, block: blocksOf([b])[0]! };
  };
  try {
    const first = await render();
    expect(first.text).toContain("listed by name only");
    uses.set("cut-17", 4);
    const loaded = await render();
    expect(loaded.text).not.toBe(first.text);
    expect(loaded.text).toContain("does thing 17");
    // A kept prompt is compared by the block's hash and data (prompt-store.ts changedBlocks, ownChanges); its size is the sent text's own.
    const kept = (b: typeof first.block) => ({ name: b.name, hash: b.hash, data: b.data });
    expect(kept(loaded.block)).toEqual(kept(first.block));
    // A skill added is a change, of the block and of the owner's side of it.
    skill(30);
    const added = (await render()).block;
    expect(added.hash).not.toBe(first.block.hash);
    expect(added.data).not.toBe(first.block.data);
  } finally {
    setSkillUsage(was);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A plugin's copy of a skill the owner keeps in a folder too is the same file under another name: the model is
// offered it once, and the second name still loads.
test("a second copy of a skill file is not listed, and still loads by its name", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { discoverSkills, listable } = await import("./skills.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "skills-same-"));
  mkdirSync(join(dir, ".git"));
  const put = (root: string, folder: string, text: string) => {
    mkdirSync(join(dir, root, folder), { recursive: true });
    writeFileSync(join(dir, root, folder, "SKILL.md"), text);
  };
  const text = "---\ndescription: Plans a release\n---\nSteps\n";
  try {
    put(".claude/skills", "release", text);
    put(".agents/skills", "release-copy", text);
    put(".agents/skills", "release-other", text.replace("Steps", "Other steps"));
    const found = discoverSkills(dir).filter((s) => s.scope === "project");
    expect(found.map((s) => [s.name, s.same])).toEqual([["release", undefined], ["release-copy", "release"], ["release-other", undefined]]);
    expect(listable(found).map((s) => s.name)).toEqual(["release", "release-other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
