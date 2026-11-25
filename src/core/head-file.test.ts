// A revision is never read as a file name: a repository with a top-level file named HEAD answers the board's
// uncommitted count, the checkpoint log and the language servers' staged files as one without it does.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkBoard } from "../board/board.ts";
import { repoDiffers, repoHead } from "../lsp/manager.ts";
import { Store } from "./store.ts";
import { Worktrees } from "../worktree/manager.ts";

setDefaultTimeout(30_000);
const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `head-file-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const make = (name: string, withHead: boolean) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  if (withHead) writeFileSync(join(dir, "HEAD"), "a file\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "first");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  g(dir, "add", "b.txt");
  return dir;
};

test("a file named HEAD changes no answer of the board, the checkpoint log or the language servers", async () => {
  const plain = make("plain", false), odd = make("odd", true);
  const board = new WorkBoard(new Store(join(root, "state")), {} as any) as any;
  const stat = async (dir: string) => (await board.changes(dir, dir, null, g(dir, "rev-parse", "HEAD"), undefined, Infinity))?.uncommitted;
  expect(await stat(odd)).toEqual(await stat(plain));
  expect((await stat(odd))?.files).toBeGreaterThan(0);

  for (const dir of [plain, odd]) expect(await repoDiffers(dir, (await repoHead(dir)).head)).toContain("b.txt");

  const wts = new Worktrees(new Store(join(root, "state2")), join(root, "wts"));
  const tree = (dir: string) => g(dir, "rev-parse", "HEAD^{tree}");
  const log = async (dir: string) => wts.committedAs({ workspace: dir } as any, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", tree(dir));
  expect(await log(odd)).toBe(g(odd, "rev-parse", "HEAD"));
  expect(await log(plain)).toBe(g(plain, "rev-parse", "HEAD"));
});
