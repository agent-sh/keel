// The checkpoint store leaves out what the owner's own git excludes name: the repository's .git/info/exclude
// and the global excludes file. Without that a file the owner hid from git is captured in every snapshot.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `shadow-excl-${process.pid}`);
const { Shadow } = await import("./shadow.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a snapshot leaves out what .git/info/exclude and the global excludes file name", async () => {
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const init = spawnSync("git", ["init", "-q", ws]);
  expect(init.status).toBe(0);
  mkdirSync(join(ws, ".git", "info"), { recursive: true });
  writeFileSync(join(ws, ".git", "info", "exclude"), "local-notes/\n");
  writeFileSync(join(root, "global-ignore"), "*.secret\n");
  writeFileSync(join(root, "gitconfig"), `[core]\n\texcludesFile = ${join(root, "global-ignore")}\n`);
  writeFileSync(join(ws, "code.txt"), "one\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  try {
    const sh = new Shadow(join(root, "state", "checkpoints"), ws);
    await sh.snapshot();
    writeFileSync(join(ws, "code.txt"), "two\n");
    mkdirSync(join(ws, "local-notes"));
    writeFileSync(join(ws, "local-notes", "a.txt"), "note\n");
    writeFileSync(join(ws, "k.secret"), "key\n");
    const tree = await sh.snapshot();
    const names = (await sh.git(["ls-tree", "-r", "--name-only", tree])).trim().split("\n");
    expect(names).toEqual(["code.txt"]);
    const byPath = await sh.snapshot(["code.txt", "local-notes/a.txt", "k.secret"]);
    expect((await sh.git(["ls-tree", "-r", "--name-only", byPath])).trim().split("\n")).toEqual(["code.txt"]);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before;
  }
});

test("a linked worktree takes the shared repository's .git/info/exclude", async () => {
  const main = join(root, "main"), ws = join(root, "linked");
  mkdirSync(main, { recursive: true });
  const run = (cwd: string, ...a: string[]) => expect(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).status).toBe(0);
  run(main, "init", "-q");
  writeFileSync(join(main, "code.txt"), "one\n");
  run(main, "add", "."); run(main, "commit", "-qm", "x");
  run(main, "worktree", "add", "-q", ws);
  mkdirSync(join(main, ".git", "info"), { recursive: true });
  writeFileSync(join(main, ".git", "info", "exclude"), "local-notes/\n");
  const sh = new Shadow(join(root, "state2", "checkpoints"), ws);
  await sh.snapshot();
  mkdirSync(join(ws, "local-notes"));
  writeFileSync(join(ws, "local-notes", "a.txt"), "note\n");
  writeFileSync(join(ws, "code.txt"), "two\n");
  const tree = await sh.snapshot();
  expect((await sh.git(["ls-tree", "-r", "--name-only", tree])).trim().split("\n")).toEqual(["code.txt"]);
});
