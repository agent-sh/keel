// The manager with real child processes (the stand-in server) and real
// repositories: what it ends, and that asking a repository what changed runs
// nothing the repository names.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager, repoBetween, repoDiffers, repoHead, type Perm } from "./manager.ts";

const standin = join(import.meta.dir, "../../test/e2e/fixtures/lsp-standin.ts");
const server = (ext: string) => ({ command: [process.execPath, standin, "plain"], extensions: { [ext]: "plaintext" } });
const perm: Perm = { mode: "full-auto", sandbox: "off", network: true };
const manager = (more: Partial<ConstructorParameters<typeof LspManager>[0]> = {}) => new LspManager({
  overrides: () => ({ one: server(".one"), two: server(".two") }), trusted: () => false,
  confine: (argv) => ({ argv }), env: () => ({ PATH: process.env.PATH ?? "" }), ...more,
});
// One edit of a new file, through the manager: its server starts and answers.
async function edit(m: LspManager, ws: string, name: string, id: string) {
  const path = join(ws, name);
  await m.before({ id: "s1", workspace: ws }, perm, id, [path]);
  writeFileSync(path, "an ERROR\n");
  return m.after({ id: "s1", workspace: ws }, id, 5000);
}
const running = (m: LspManager, ws: string, id: string) => m.list(ws).find((s) => s.id === id)!.running;
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await Bun.sleep(50); return f(); };

test("the servers together hold no more than the daemon gives them: the least recently used ends first", async () => {
  const ws = mkdtempSync(join(tmpdir(), "keel-lsp-total-"));
  let budget = 100_000;
  const m = manager({ maxMemoryMb: () => budget });
  try {
    expect((await edit(m, ws, "a.one", "c1"))!.files[0]!.diff.added).toHaveLength(1);
    await Bun.sleep(20);
    expect((await edit(m, ws, "a.two", "c2"))!.files[0]!.diff.added).toHaveLength(1);
    const t = m.totals();
    expect(t.alive).toBe(2);
    expect(t.rss_mb).toBeGreaterThan(10); // two real processes, measured
    // Within the budget nothing ends.
    m.sweep();
    expect(m.totals().alive).toBe(2);
    // Room for one of them, not for both.
    budget = Math.ceil(t.rss_mb * 0.7);
    m.sweep();
    expect(await until(() => m.totals().alive === 1)).toBe(true);
    expect(running(m, ws, "one")[0]).toMatchObject({ state: "stopped" });
    expect(running(m, ws, "one")[0]!.error).toMatch(/the language servers held \d+ MB together, over \d+ MB/);
    expect(running(m, ws, "two")[0]).toMatchObject({ state: "running" });
    // It starts again at the next edit of its file.
    expect((await edit(m, ws, "b.one", "c3"))!.files[0]!.diff.added).toHaveLength(1);
  } finally {
    m.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a server whose folder is gone (a removed worktree) is ended at the next sweep, and none starts for it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "keel-lsp-gone-"));
  const m = manager();
  try {
    await edit(m, ws, "a.one", "c1");
    expect(m.totals().alive).toBe(1);
    const pid = running(m, ws, "one")[0]!.pid!;
    rmSync(ws, { recursive: true, force: true });
    m.sweep();
    expect(await until(() => m.totals().alive === 0)).toBe(true);
    expect(await until(() => !existsSync(`/proc/${pid}`))).toBe(true);
    // An edit named in the folder that is gone starts nothing.
    await m.before({ id: "s1", workspace: ws }, perm, "c2", [join(ws, "b.one")]);
    expect(m.totals().alive).toBe(0);
  } finally {
    m.dispose();
  }
});

test("asking a repository what changed runs no program it names: a monitor, a hooks folder, a filter", async () => {
  const top = mkdtempSync(join(tmpdir(), "keel-lsp-git-"));
  const repo = join(top, "repo");
  const marker = join(top, "RAN");
  mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src/b.ts"), "export const b = 1;\n");
  writeFileSync(join(repo, "src/c.ts"), "export const c = 1;\n");
  git("add", "-A"); git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD").toString().trim();
  writeFileSync(join(repo, "src/c.ts"), "export const c = 2;\n");
  git("add", "-A"); git("commit", "-qm", "two");
  // What a session could plant: programs named by the repository's own config and attributes.
  const script = join(top, "planted.sh");
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> ${marker}\ncat 2>/dev/null\n`);
  chmodSync(script, 0o755);
  mkdirSync(join(top, "hooks"));
  for (const h of ["post-index-change", "pre-commit", "post-checkout", "reference-transaction"]) { writeFileSync(join(top, "hooks", h), `#!/bin/sh\necho hook ${h} >> ${marker}\n`); chmodSync(join(top, "hooks", h), 0o755); }
  writeFileSync(join(repo, ".gitattributes"), "*.ts filter=planted diff=planted\n");
  git("config", "core.fsmonitor", script);
  git("config", "core.hooksPath", join(top, "hooks"));
  git("config", "filter.planted.clean", script);
  git("config", "filter.planted.smudge", script);
  git("config", "diff.planted.textconv", script);
  git("config", "diff.external", script);
  // A file changed on disk (its size and time differ from the index), one moved with its name staged, one untracked.
  writeFileSync(join(repo, "src/a.ts"), "export const a = 'changed and longer';\n");
  renameSync(join(repo, "src/b.ts"), join(repo, "src/b2.ts"));
  execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "update-index", "--force-remove", "src/b.ts"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "src/new.ts"), "export const n = 1;\n");
  rmSync(marker, { force: true });

  const at = await repoHead(repo);
  expect(at.repo).toBe(true);
  expect(at.head).toMatch(/^[0-9a-f]{40}$/);
  expect((await repoDiffers(repo, at.head))!.sort()).toEqual([".gitattributes", "src/a.ts", "src/b.ts", "src/b2.ts", "src/new.ts"]);
  expect(await repoBetween(repo, first, at.head)).toEqual(["src/c.ts"]);
  // Under a folder of the repository the names are that folder's.
  expect((await repoDiffers(join(repo, "src"), at.head))!.sort()).toEqual(["a.ts", "b.ts", "b2.ts", "new.ts"]);
  expect(existsSync(marker)).toBe(false);
  // The plant is live: git run plainly in that folder does run it.
  execFileSync("git", ["ls-files", "-m"], { cwd: repo, stdio: "pipe" });
  expect(existsSync(marker)).toBe(true);
  // A folder that is no repository says so, and nothing is listed for it.
  expect(await repoHead(top)).toEqual({ repo: false, head: "" });
  rmSync(top, { recursive: true, force: true });
});
