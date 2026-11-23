import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { keepMark, lastMark, Overlaps } from "./overlap-scan.ts";

// Each test runs git a dozen times; a busy disk makes one call take half a second.
setDefaultTimeout(30_000);

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `overlap-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A global git config of this file's own, with a merge driver that leaves a mark when it runs.
const marker = join(root, "DRIVER_RAN");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "gitconfig"), `[user]\n\tname = t\n\temail = t@t\n[merge "mark"]\n\tname = leaves a mark\n\tdriver = touch ${marker}; cp %B %A; true\n[core]\n\tattributesFile = ${join(root, "global-attributes")}\n`);
// (The owner's attributes file names the driver only in the tests of attributes.)
writeFileSync(join(root, "global-attributes"), "");
ownEnv({ GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
let n = 0;
// A repository with two branches that change line 3, each held by a session.
function setup() {
  const dir = join(root, `case-${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  const edit = (branch: string, to: string) => {
    g(repo, "checkout", "-q", "-B", branch, "main");
    writeFileSync(join(repo, "notes.md"), readFileSync(join(repo, "notes.md"), "utf8").replace("line 3\n", `${to}\n`));
    g(repo, "commit", "-qam", branch);
  };
  edit("keel/a", "line three");
  edit("keel/b", "line 3, as b has it");
  g(repo, "checkout", "-q", "main");
  const store = new Store(join(dir, "state"));
  const a = store.createSession({ model: "scripted:stand-in", workspace: repo, title: "A" });
  const b = store.createSession({ model: "scripted:stand-in", workspace: repo, title: "B" });
  // A teller with the old hooks too: a pass that steered into a running turn would call them.
  const steered: string[] = [];
  const teller = { changed: () => {}, failed: (e: unknown) => { throw e; }, running: () => true, steer: (id: string) => (steered.push(id), true) } as any;
  const ov = new Overlaps(store, teller);
  ov.committed(repo, "keel/a", a.id);
  ov.committed(repo, "keel/b", b.id);
  return { repo, store, ov, a: a.id, b: b.id, steered };
}

// The note is never sent to a session from a pass: not while its turn runs
// (it would stay queued past the turn's last step and start a turn of its own,
// waking an agent after its final answer), not after. It is written into a
// turn's model request (noteFor), once.
test("a pass while both sessions' turns run queues nothing; each turn's next request carries the note once", async () => {
  const { repo, store, ov, a, b, steered } = setup();
  await ov.scan(repo);
  expect(steered).toEqual([]);
  expect(store.queue(a)).toEqual([]);
  expect(store.queue(b)).toEqual([]);
  const na = ov.noteFor(a)!;
  expect(na.text).toContain("Your branch keel/a would conflict with keel/b");
  expect(na.text).toContain("): notes.md.");
  expect(na.text).not.toContain("line 3");
  na.settle();
  expect(ov.noteFor(a)).toBeUndefined();
  // B's was not settled by A's note.
  expect(ov.noteFor(b)?.text).toContain("Your branch keel/b would conflict with keel/a");
  // A rebase clears it: the one who was told hears it is gone, the one who was not hears nothing.
  g(repo, "checkout", "-q", "keel/b");
  g(repo, "rebase", "-q", "-X", "theirs", "keel/a");
  g(repo, "checkout", "-q", "main");
  await ov.scan(repo);
  expect(steered).toEqual([]);
  expect(ov.noteFor(a)?.text).toContain("No longer conflicting: keel/a with keel/b.");
  ov.noteFor(a)!.settle();
  expect(ov.noteFor(a)).toBeUndefined();
  expect(ov.noteFor(b)).toBeUndefined();
});

// An agent that ended no longer holds its branch: its pairs go, with what was
// owed of them, and nobody hears of it again (a coordinator's ended agents'
// branches were forecast against every other branch, every pass).
test("an ended agent's branch is not forecast", async () => {
  const { repo, store, ov, a, b } = setup();
  const lead = store.createSession({ model: "scripted:stand-in", workspace: repo, title: "Lead" });
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  store.db.run("UPDATE sessions SET parent_id = ? WHERE id IN (?, ?)", [lead.id, a, b]);
  store.db.run("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, status TEXT, created INTEGER, ended INTEGER)");
  store.db.run("INSERT INTO agents VALUES ('ag-a', ?, ?, 'running', 1, NULL), ('ag-b', ?, ?, 'running', 1, NULL)", [lead.id, a, lead.id, b]);
  await ov.scan(repo);
  const told = ov.noteFor(lead.id)!;
  expect(told.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  expect(ov.view(a).pairs).toHaveLength(1);
  store.db.run("UPDATE agents SET status = 'done', ended = 2 WHERE id = 'ag-b'");
  await ov.scan(repo);
  expect(ov.view(a).pairs).toEqual([]);
  expect(ov.noteFor(a)).toBeUndefined();
  expect(ov.noteFor(b)).toBeUndefined();
  expect(ov.noteFor(lead.id)).toBeUndefined();
});

// A branch landed by cherry-pick has commits of its own by id, none by patch:
// it is not forecast against the others (it would conflict with each of them
// the way the base does).
test("a branch whose commits the base holds as patches is not forecast", async () => {
  const { repo, ov, b } = setup();
  g(repo, "checkout", "-q", "main");
  // (main moves first, so the pick is a commit of its own, not the branch's.)
  writeFileSync(join(repo, "other.txt"), "x\n");
  g(repo, "add", "other.txt");
  g(repo, "commit", "-qm", "other");
  g(repo, "cherry-pick", "keel/a");
  await ov.scan(repo);
  const pairs = ov.view(b).pairs;
  expect(pairs.map((p) => [p.a, p.b, p.base])).toEqual([["keel/b", "main", true]]);
});

// The base took the change and then reverted it: landing the branch brings it
// back, so the branch has something to land again.
test("a branch whose change the base took and reverted is forecast again", async () => {
  const { repo, ov, b } = setup();
  g(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "other.txt"), "x\n");
  g(repo, "add", "other.txt");
  g(repo, "commit", "-qm", "other");
  g(repo, "cherry-pick", "keel/a");
  g(repo, "revert", "--no-edit", "HEAD");
  await ov.scan(repo);
  expect(ov.view(b).pairs.filter((p) => !p.base).map((p) => [p.a, p.b])).toEqual([["keel/a", "keel/b"]]);
});

// Attributes a session can write name a driver of the owner's config, or a
// union merge that hides the conflict: the merge reads none of them.
const plain = (repo: string) => { try { g(repo, "merge-tree", "--write-tree", "keel/a", "keel/b"); return 0; } catch (e: any) { return e.status as number; } };
for (const [what, attrs] of [["a driver of the owner's config", "* merge=mark\n"], ["a union merge", "notes.md merge=union\n"]] as const) {
  test(`no attribute of the checkout, a branch or the owner's attributes file reaches the merge: ${what}`, async () => {
    const { repo, ov, a } = setup();
    // Committed on one branch, untracked in the main checkout, and the global attributes file (*.md merge=mark).
    g(repo, "checkout", "-q", "keel/a");
    writeFileSync(join(repo, ".gitattributes"), attrs);
    g(repo, "add", ".gitattributes");
    g(repo, "commit", "-qm", "attributes");
    g(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, ".gitattributes"), attrs);
    writeFileSync(join(root, "global-attributes"), "*.md merge=mark\n");
    rmSync(marker, { force: true });
    try {
      await ov.scan(repo);
    } finally {
      writeFileSync(join(root, "global-attributes"), "");
    }
    expect(existsSync(marker)).toBe(false);
    const pair = ov.view(a).pairs.find((p) => !p.base);
    expect(pair?.conflict).toBe(true);
    expect(pair?.files.map((f) => f.path)).toEqual(["notes.md"]);
    // The repository's own git, for comparison, runs the driver, or hides the conflict.
    writeFileSync(join(root, "global-attributes"), attrs.includes("mark") ? "*.md merge=mark\n" : "");
    const code = plain(repo);
    writeFileSync(join(root, "global-attributes"), "");
    if (attrs.includes("mark")) expect(existsSync(marker)).toBe(true);
    else expect(code).toBe(0);
  });
}

test("a session's last mark is kept with it", () => {
  const { store, a, repo } = setup();
  expect(lastMark(store, a)).toBeUndefined();
  keepMark(store, a, { repo, branch: "keel/a", tip: "abc" });
  expect(lastMark(store, a)).toEqual({ repo, branch: "keel/a", tip: "abc" });
  keepMark(store, a, { repo, branch: "keel/a", tip: "def", base: "123" });
  expect(lastMark(store, a)).toEqual({ repo, branch: "keel/a", tip: "def", base: "123" });
});
