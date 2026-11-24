import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

// Owed for a file that has since left the conflict, with every file now in it
// told before: there is nothing new to tell, and no note says "no file".
test("a conflict owed whose files were all told before writes no note", async () => {
  const { repo, store, ov, a } = setup();
  await ov.scan(repo);
  ov.noteFor(a)!.settle();
  store.db.run("UPDATE overlap_told SET owed = 'conflict' WHERE session_id = ?", [a]);
  expect(ov.noteFor(a)).toBeUndefined();
});

// A branch made on a newer base holds the base's new commits: merged with a
// branch made before them, it meets that branch wherever the base does. Those
// files are the older branch's conflict with the base (its own pair says so),
// not a meeting of the two branches.
test("a branch on a newer base does not conflict with an older one where only the base meets it", async () => {
  const { repo, store, ov, a, b } = setup();
  g(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "notes.md"), readFileSync(join(repo, "notes.md"), "utf8").replace("line 3\n", "line 3 on main\n"));
  g(repo, "commit", "-qam", "main moves");
  g(repo, "checkout", "-q", "-B", "keel/c", "main");
  writeFileSync(join(repo, "c.txt"), "c\n");
  g(repo, "add", "c.txt");
  g(repo, "commit", "-qm", "c");
  g(repo, "checkout", "-q", "main");
  const c = store.createSession({ model: "scripted:stand-in", workspace: repo, title: "C" });
  ov.committed(repo, "keel/c", c.id);
  await ov.scan(repo);
  // The two older branches still meet each other, and each meets the base; keel/c meets nobody.
  expect(ov.view(c.id).pairs.map((p) => [p.a, p.b]).sort()).toEqual([["keel/a", "keel/b"], ["keel/a", "main"], ["keel/b", "main"]]);
  expect(ov.noteFor(c.id)).toBeUndefined();
  expect(ov.noteFor(a)?.text).not.toContain("keel/c");
  expect(ov.noteFor(b)?.text).not.toContain("keel/c");
});

// A repository whose base holds f.txt of twenty lines, and two branches each held by a session.
function pairOf(made: (repo: string, br: (b: string, from: string, fn: () => void) => void) => void) {
  const dir = join(root, `case-${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  const br = (b: string, from: string, fn: () => void) => { g(repo, "checkout", "-q", "-B", b, from); fn(); g(repo, "add", "-A"); g(repo, "commit", "-qm", b); g(repo, "checkout", "-q", "main"); };
  made(repo, br);
  const store = new Store(join(dir, "state"));
  const teller = { changed: () => {}, failed: (e: unknown) => { throw e; } } as any;
  const ov = new Overlaps(store, teller);
  const ids = ["keel/a", "keel/b"].map((b) => { const s = store.createSession({ model: "scripted:stand-in", workspace: repo, title: b }); ov.committed(repo, b, s.id); return s.id; });
  const pair = () => ov.view(ids[0]!).pairs.find((p) => p.a === "keel/a" && p.b === "keel/b");
  return { repo, store, ov, teller, pair, id: ids[0]! };
}
const edit = (repo: string, f: string, from: string, to: string) => writeFileSync(join(repo, f), readFileSync(join(repo, f), "utf8").replace(`${from}\n`, `${to}\n`));

// git names a rename's conflict at the new path, which the other branch never changed by that name.
test("two branches that meet in a renamed file conflict, whatever the bases", async () => {
  const cases: [string, (repo: string, br: (b: string, from: string, fn: () => void) => void) => void, string[]][] = [
    ["a rename and an edit of the old path", (repo, br) => {
      br("keel/a", "main", () => { g(repo, "mv", "f.txt", "g.txt"); edit(repo, "g.txt", "line 3", "A3"); });
      br("keel/b", "main", () => edit(repo, "f.txt", "line 3", "B3"));
    }, ["g.txt"]],
    ["two renames of one file", (repo, br) => {
      br("keel/a", "main", () => g(repo, "mv", "f.txt", "g.txt"));
      br("keel/b", "main", () => g(repo, "mv", "f.txt", "h.txt"));
    }, ["f.txt", "g.txt", "h.txt"]],
    ["a rename and a delete", (repo, br) => {
      br("keel/a", "main", () => g(repo, "mv", "f.txt", "g.txt"));
      br("keel/b", "main", () => unlinkSync(join(repo, "f.txt")));
    }, ["g.txt"]],
    ["an edit on the old base and one on a base that renamed the file", (repo, br) => {
      br("keel/a", "main", () => edit(repo, "f.txt", "line 3", "A3"));
      g(repo, "mv", "f.txt", "g.txt");
      g(repo, "commit", "-qm", "main renames");
      br("keel/b", "main", () => edit(repo, "g.txt", "line 3", "B3"));
    }, ["g.txt"]],
  ];
  for (const [what, made, files] of cases) {
    const { repo, ov, pair } = pairOf(made);
    await ov.scan(repo);
    expect([what, pair()?.conflict, pair()?.files.map((f) => f.path).sort()]).toEqual([what, true, files]);
  }
});

// A branch pair judged clean because the base met the older branch is judged again when the base moves:
// moved back, the base no longer meets it, and the two branches do.
test("a branch pair is judged again when the base moves, back included", async () => {
  let O = "";
  const { repo, store, ov, teller, pair, id } = pairOf((repo, br) => {
    O = g(repo, "rev-parse", "HEAD");
    br("keel/a", "main", () => edit(repo, "f.txt", "line 3", "A3"));
    edit(repo, "f.txt", "line 3", "N3");
    g(repo, "commit", "-qam", "N");
    br("keel/b", "main", () => writeFileSync(join(repo, "b.txt"), "b\n"));
  });
  await ov.scan(repo);
  expect(pair()).toBeUndefined(); // (the view lists the pairs that conflict)
  g(repo, "reset", "-q", "--hard", O);
  await ov.scan(repo);
  expect([pair()?.conflict, pair()?.files.map((f) => f.path)]).toEqual([true, ["f.txt"]]);
  // A later start reads the same, and keeps every pair it judged (two with the base, one of the branches).
  const again = new Overlaps(store, teller);
  await again.scan(repo);
  expect([again.view(id).last?.reused, pair()?.conflict]).toEqual([3, true]);
});

// A row an earlier build wrote (no merge kept with it) is merged once, then kept across starts.
test("a branch pair from an earlier build is merged again once", async () => {
  const { repo, store, ov, teller, pair, id } = pairOf((repo, br) => {
    br("keel/a", "main", () => edit(repo, "f.txt", "line 3", "A3"));
    br("keel/b", "main", () => edit(repo, "f.txt", "line 3", "B3"));
  });
  await ov.scan(repo);
  store.db.run("UPDATE overlap_pairs SET raw = NULL, conflict = 0, files = '[]' WHERE base = 0");
  const next = new Overlaps(store, teller);
  await next.scan(repo);
  expect(pair()?.conflict).toBe(true);
  expect(next.view(id).last?.reused).toBe(2);
  const third = new Overlaps(store, teller);
  await third.scan(repo);
  expect(third.view(id).last?.reused).toBe(3);
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

// A branch that conflicts with the base is told once to rebase; its conflicts
// with other branches wait until it did, and are told then if still real.
test("a branch that conflicts with the base is told to rebase; its pair conflicts wait for the rebase", async () => {
  const dir = join(root, `case-${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  const file = join(repo, "notes.md");
  writeFileSync(file, Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  const edit = (branch: string, from: string, lines: Record<number, string>) => {
    g(repo, "checkout", "-q", "-B", branch, from);
    let text = readFileSync(file, "utf8");
    for (const [n, to] of Object.entries(lines)) text = text.replace(`line ${n}\n`, `${to}\n`);
    writeFileSync(file, text);
    g(repo, "commit", "-qam", branch);
  };
  edit("keel/x", "main", { 3: "x three", 5: "x five", 7: "x seven" });
  edit("keel/y", "main", { 3: "y three" });
  edit("keel/z", "main", { 7: "z seven" });
  g(repo, "checkout", "-q", "main");
  writeFileSync(file, readFileSync(file, "utf8").replace("line 5\n", "main five\n"));
  g(repo, "commit", "-qam", "main moves");
  const store = new Store(join(dir, "state"));
  const ov = new Overlaps(store, { changed: () => {}, failed: (e: unknown) => { throw e; } });
  const ids: Record<string, string> = {};
  for (const b of ["x", "y", "z"]) { ids[b] = store.createSession({ model: "scripted:stand-in", workspace: repo, title: b }).id; ov.committed(repo, `keel/${b}`, ids[b]!); }
  await ov.scan(repo);
  expect(ov.noteFor(ids.y!)).toBeUndefined();
  expect(ov.noteFor(ids.z!)).toBeUndefined();
  const x = ov.noteFor(ids.x!)!;
  expect(x.text).toContain("Your branch keel/x would conflict with the base main: notes.md (rebase onto it first: its conflicts with 2 other branches wait until then).");
  expect(x.text).not.toContain("keel/y");
  x.settle();
  expect(ov.noteFor(ids.x!)).toBeUndefined();
  expect(ov.view(ids.y!).pairs.filter((p) => !p.base).map((p) => [p.a, p.b, p.waits])).toEqual([["keel/x", "keel/y", true], ["keel/x", "keel/z", true]]);
  // A pass that changes nothing tells nothing.
  await ov.scan(repo);
  expect(ov.noteFor(ids.y!)).toBeUndefined();
  // X rebases onto the base, keeping the base's line 5: its conflicts with Y and Z are real, and told now.
  g(repo, "checkout", "-q", "keel/x");
  g(repo, "rebase", "-q", "-X", "ours", "main");
  g(repo, "checkout", "-q", "main");
  await ov.scan(repo);
  expect(ov.noteFor(ids.y!)?.text).toContain("Your branch keel/y would conflict with keel/x");
  expect(ov.noteFor(ids.z!)?.text).toContain("Your branch keel/z would conflict with keel/x");
  const after = ov.noteFor(ids.x!)!.text;
  expect(after).toContain("would conflict with keel/y");
  expect(after).toContain("No longer conflicting: keel/x with the base main.");
});

// The panel said no session held a branch while a builder's worktree held uncommitted files: a worktree whose
// holder is not live is listed with what it holds (commits, uncommitted files, why it is not live).
test("a worktree no live session holds is listed with its commits and uncommitted files", async () => {
  const { repo, store, ov, a } = setup();
  store.db.run("CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, snapshot_ref TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)");
  const path = join(repo, "..", "builder");
  g(repo, "worktree", "add", "-q", "-b", "keel/builder", path, "main");
  writeFileSync(join(path, "new.ts"), "export {};\n");
  writeFileSync(join(path, "notes.md"), "changed\n");
  const holder = store.createSession({ model: "scripted:stand-in", workspace: path, title: "Builder" });
  store.db.run("INSERT INTO worktrees VALUES (?, ?, ?, 'keel/builder', 'main', '', 'active', NULL, 1, 1)", [holder.id, repo, path]);
  // Held by a live session: a live branch, not listed.
  expect(await ov.unheld(a)).toEqual([]);
  store.db.run("UPDATE sessions SET archived = 1 WHERE id = ?", [holder.id]);
  expect(await ov.unheld(a)).toEqual([{ branch: "keel/builder", session_id: holder.id, title: "Builder", why: "archived", commits: 0, uncommitted: 2 }]);
});
