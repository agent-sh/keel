// A skill's pin covers what its links run: retargeting a link inside the skill
// unpins it, and a link out of the skill keeps it from loading.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { hashing, SKILL_SCAN, skillDigest, Trust } from "./trust.ts";
import { loadSkill, skillFilter } from "../tools/skills.ts";

test("a skill's link is pinned by where it lands; a link out of the skill does not load", () => {
  const repo = mkdtempSync(join(tmpdir(), "keel-trust-"));
  mkdirSync(join(repo, ".git"));
  const dir = join(repo, ".agents/skills/s");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: s\n---\nRun run.sh\n");
  writeFileSync(join(dir, "one.sh"), "echo one\n");
  writeFileSync(join(dir, "two.sh"), "echo two\n");
  symlinkSync("one.sh", join(dir, "run.sh"));
  const t = new Trust(new Store(mkdtempSync(join(tmpdir(), "keel-trust-state-"))));
  expect(t.skillAllowed(dir)).toBe(true); // pinned on first sight
  rmSync(join(dir, "run.sh"));
  symlinkSync("two.sh", join(dir, "run.sh"));
  expect(t.skillAllowed(dir)).toBe(false);
  expect(t.files(repo).find((f) => f.path === dir)!.state).toBe("changed");
  const out = join(mkdtempSync(join(tmpdir(), "keel-out-")), "x.sh");
  writeFileSync(out, "echo x\n");
  rmSync(join(dir, "run.sh"));
  symlinkSync(out, join(dir, "run.sh"));
  const f = t.files(repo).find((x) => x.path === dir)!;
  t.trust(repo, dir, f.sha256!);
  expect(t.skillAllowed(dir)).toBe(false);
  expect(t.files(repo).find((x) => x.path === dir)!.outside).toEqual(["run.sh"]);
});

test("a skill's files are hashed again only when they changed", () => {
  const repo = mkdtempSync(join(tmpdir(), "keel-trust-cache-"));
  mkdirSync(join(repo, ".git"));
  const dir = join(repo, ".agents/skills/s");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.sh`), `echo ${i}\n`);
  writeFileSync(join(dir, "SKILL.md"), "---\nname: s\n---\nBody\n");
  const t = new Trust(new Store(mkdtempSync(join(tmpdir(), "keel-trust-cache-state-"))));
  const racy = hashing.racyMs;
  hashing.racyMs = 0;
  try {
    t.skillOwnerTrusted(dir);
    const n = hashing.reads;
    for (let i = 0; i < 10; i++) t.skillOwnerTrusted(dir);
    expect(hashing.reads).toBe(n);
    // An edit of the same size is still seen, even one in the same tick of the
    // file system's clock as the write before it (same inode, size and times):
    // a file changed within the window is never kept.
    hashing.racyMs = racy;
    writeFileSync(join(dir, "f3.sh"), "echo X\n");
    const f = t.files(repo).find((x) => x.path === dir)!;
    t.trust(repo, dir, f.sha256!);
    expect(t.skillOwnerTrusted(dir)).toBe(true);
    writeFileSync(join(dir, "f3.sh"), "echo Y\n");
    expect(t.skillOwnerTrusted(dir)).toBe(false);
  } finally {
    hashing.racyMs = racy;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a skill folder past what the scan reads is not trusted, with the reason, and a hook script past the cap cannot change under a pin", async () => {
  const repo = mkdtempSync(join(tmpdir(), "keel-trust-"));
  mkdirSync(join(repo, ".git"));
  const dir = join(repo, ".agents/skills/big");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: big\n---\nRun ${CLAUDE_SKILL_DIR}/zz/hook.sh\n");
  // One folder of many files, and the hook script in a folder the walk reaches after the cap.
  for (let i = 0; i < SKILL_SCAN.files + 200; i++) writeFileSync(join(dir, "data", `f${i}.txt`), `${i}\n`);
  mkdirSync(join(dir, "zz"));
  writeFileSync(join(dir, "zz/hook.sh"), "echo safe\n");
  const t = new Trust(new Store(mkdtempSync(join(tmpdir(), "keel-trust-state-"))));
  expect(t.skillAllowed(dir)).toBe(false);
  const f = t.files(repo).find((x) => x.path === dir)!;
  expect([f.state, f.refused]).toEqual(["new", `This skill cannot be trusted: it holds more than ${SKILL_SCAN.files} files, more than Keel reads to pin a skill. Move what it does not need out of its folder.`]);
  expect(() => t.trust(repo, dir, f.sha256!)).toThrow(f.refused!);
  // Its hooks run only while it is trusted as it is now: there is no digest to hold them by.
  expect(skillDigest(dir)).toBeNull();
  writeFileSync(join(dir, "zz/hook.sh"), "echo changed\n");
  expect(t.skillAllowed(dir)).toBe(false);
  // The model that asks for it is told why it does not load, not that there is no such skill.
  const was = { ...skillFilter };
  try {
    Object.assign(skillFilter, { allow: (d: string) => t.skillAllowed(d), held: (d: string) => t.skillHeld(d) });
    const out = JSON.stringify(await loadSkill("big", "", { cwd: repo, sessionId: "s1" } as any));
    expect(out).toContain(`The skill \\"big\\" is this repository's and does not load: ${f.refused}`);
  } finally {
    for (const k of Object.keys(skillFilter) as (keyof typeof skillFilter)[]) delete skillFilter[k];
    Object.assign(skillFilter, was);
  }
  // Within the cap it is pinned again, and the hook script is in its digest.
  rmSync(join(dir, "data"), { recursive: true });
  expect(t.skillAllowed(dir)).toBe(true);
  writeFileSync(join(dir, "zz/hook.sh"), "echo changed again\n");
  expect(t.skillAllowed(dir)).toBe(false);
});
