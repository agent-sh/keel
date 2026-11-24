// The checkpoint engine on a real shadow repository and store: the cases an
// e2e cannot stage (a git step that fails, retention, an edit landing between
// two tool calls of one turn, a restore cut before its result was recorded).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `ckpt-${process.pid}`);
process.env.KEEL_CHECKPOINT_KEEP = "4";
process.env.KEEL_CHECKPOINT_FILE_MB = String(100 / 1024 / 1024); // 100 bytes
const { Store } = await import("../core/store.ts");
const { Bus } = await import("../core/bus.ts");
const { ErrorTracker } = await import("../core/errors.ts");
const { Checkpoints } = await import("./checkpoints.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function setup(files: Record<string, string>) {
  const dir = join(root, `case-${++n}`);
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(ws, p, ".."), { recursive: true }); writeFileSync(join(ws, p), t); }
  const store = new Store(join(dir, "state"));
  const bus = new Bus();
  const c = new Checkpoints(store, bus, new ErrorTracker(store, bus), join(dir, "state", "checkpoints"));
  const s = store.createSession({ model: "m", workspace: ws });
  const call = { id: "c", tool: { name: "Bash", readOnly: false, kind: "shell" }, input: { command: "x" }, ctx: { cwd: ws } } as any;
  // One turn: each step is the workspace change a tool call makes, or (a
  // ["gap", f] pair) a change someone else makes between two of its calls.
  const turn = async (...steps: ((() => void) | ["gap", () => void])[]) => {
    store.append(s.id, "user", { text: `turn ${n}` });
    store.append(s.id, "turn_start", {});
    for (const step of steps) {
      if (Array.isArray(step)) { step[1](); continue; }
      await c.before(s, call); step(); await c.after(s, call);
    }
    await c.end(s);
    return Math.max(...c.list(s.id).map((x) => x.turn));
  };
  const read = (p: string) => readFileSync(join(ws, p), "utf8");
  const write = (p: string, t: string) => writeFileSync(join(ws, p), t);
  return { ws, store, c, s, turn, read, write };
}

test("a restore that fails before writing leaves every file; a write that fails is named", async () => {
  const t = setup({ "old.txt": "old\n", "d/b.txt": "b\n" });
  const t1 = await t.turn(() => { t.write("old.txt", "edit\n"); t.write("new.txt", "new\n"); t.write("d/b.txt", "b2\n"); });
  const sh = t.c.shadow(t.ws);
  const git = sh.git.bind(sh);
  sh.git = (args, o) => (args[0] === "read-tree" && o?.index?.includes("keel-restore") ? Promise.reject(new Error("no index")) : git(args, o));
  await expect(t.c.rewind(t.s, { turn: t1 })).rejects.toThrow(/nothing was restored/);
  expect(existsSync(join(t.ws, "new.txt"))).toBe(true);
  expect(t.read("old.txt")).toBe("edit\n");
  sh.git = git;
  chmodSync(join(t.ws, "d"), 0o555);
  try {
    const r = await t.c.rewind(t.s, { turn: t1 });
    expect(r.failed.map((f) => f.path)).toEqual(["d/b.txt"]);
    expect(r.files.sort()).toEqual(["new.txt", "old.txt"]);
    expect(t.read("old.txt")).toBe("old\n");
  } finally { chmodSync(join(t.ws, "d"), 0o755); }
  // The model hears which files changed under it.
  const note = t.store.events(t.s.id).findLast((e) => e.kind === "note");
  expect(note?.data.model).toBe(true);
  expect(note?.data.text).toContain("Could not be restored: d/b.txt");
});

test("an expired start snapshot is refused, not replaced by the next turn's", async () => {
  const t = setup({ "a.txt": "0\n" });
  const t1 = await t.turn(() => t.write("a.txt", "1\n"));
  const t2 = await t.turn(() => t.write("a.txt", "2\n"));
  await t.turn(() => t.write("a.txt", "3\n")); // six rows, four kept: turn 1's start and end go
  await t.c.maintain();
  await expect(t.c.rewind(t.s, { turn: t1, preview: true })).rejects.toThrow(/let go by retention/);
  expect((await t.c.rewind(t.s, { turn: t2, preview: true })).files).toEqual(["a.txt"]);
});

test("an edit between two calls of a turn is outside work, as after the turn", async () => {
  for (const late of [false, true]) {
    const t = setup({ "A": "0\n", "B": "0\n" });
    const t1 = await t.turn(() => t.write("A", "1\n"), ...(late ? [] : [["gap", () => t.write("B", "1\n")] as ["gap", () => void], () => {}]));
    if (late) t.write("B", "1\n");
    const p = await t.c.rewind(t.s, { turn: t1, preview: true });
    expect(p.files).toEqual(["A"]);
    expect(p.skipped).toEqual(["B"]);
  }
});

test("an edit landing while a file edit tool runs is outside work; while a shell command runs it is the session's", async () => {
  for (const shell of [false, true]) {
    const t = setup({ "A": "0\n", "B": "0\n" });
    t.store.append(t.s.id, "user", { text: "edit A" });
    t.store.append(t.s.id, "turn_start", {});
    const call = shell ? { id: "sh", tool: { name: "Bash", readOnly: false, kind: "shell" }, input: { command: "x" }, ctx: { cwd: t.ws } } as any
      : { id: "ed", tool: { name: "Edit", readOnly: false, kind: "edit" }, input: { file_path: join(t.ws, "A") }, ctx: { cwd: t.ws } } as any;
    await t.c.before(t.s, call);
    t.write("A", "1\n");
    t.write("B", "1\n"); // the owner's editor saves while the call runs
    await t.c.after(t.s, call);
    await t.c.end(t.s);
    const p = await t.c.rewind(t.s, { turn: Math.max(...t.c.list(t.s.id).map((x) => x.turn)), preview: true });
    expect([p.files, p.skipped]).toEqual(shell ? [["A", "B"], []] : [["A"], ["B"]]);
  }
});

test("written-only checkpoints keep a file's executable bit and follow a write through a link", async () => {
  const t = setup({ "tool.sh": "echo a\n", "real.txt": "a\n" });
  chmodSync(join(t.ws, "tool.sh"), 0o755);
  symlinkSync(join(t.ws, "real.txt"), join(t.ws, "alias.txt"));
  t.c.shadow(t.ws).mode = "written";
  t.store.append(t.s.id, "user", { text: "edit" });
  t.store.append(t.s.id, "turn_start", {});
  for (const f of ["tool.sh", "alias.txt"]) {
    const call = { id: f, tool: { name: "Edit", readOnly: false, kind: "edit" }, input: { file_path: join(t.ws, f) }, ctx: { cwd: t.ws } } as any;
    await t.c.before(t.s, call);
    t.write(f, "changed\n");
    await t.c.after(t.s, call);
  }
  await t.c.end(t.s);
  const turn = Math.max(...t.c.list(t.s.id).map((x) => x.turn));
  expect((await t.c.rewind(t.s, { turn, preview: true })).files.sort()).toEqual(["real.txt", "tool.sh"]);
  await t.c.rewind(t.s, { turn });
  expect([t.read("tool.sh"), t.read("real.txt"), statSync(join(t.ws, "tool.sh")).mode & 0o111]).toEqual(["echo a\n", "a\n", 0o111]);
});

test("a confirmed restore takes only what the preview showed, at the version it showed", async () => {
  const t = setup({ "turn.txt": "0\n", "A": "0\n", "B": "0\n", "deleted.txt": "0\n" });
  const t1 = await t.turn(() => { t.write("turn.txt", "1\n"); rmSync(join(t.ws, "deleted.txt")); });
  t.write("A", "owner\n");
  const p = await t.c.rewind(t.s, { turn: t1, preview: true });
  expect(p.skipped).toEqual(["A"]);
  t.write("B", "owner\n");
  const confirm = { paths: [...p.files, ...p.skipped], versions: p.versions };
  const r = await t.c.rewind(t.s, { turn: t1, includeOutside: true, confirm });
  expect(r.files.sort()).toEqual(["A", "deleted.txt", "turn.txt"]);
  expect(t.read("deleted.txt")).toBe("0\n");
  expect(t.read("B")).toBe("owner\n");
  // A file edited again after its preview is not written from the old one.
  t.write("A", "again\n");
  const p2 = await t.c.rewind(t.s, { turn: t1, preview: true, includeOutside: true });
  t.write("A", "and again\n");
  await expect(t.c.rewind(t.s, { turn: t1, includeOutside: true, confirm: { paths: p2.files, versions: p2.versions } })).rejects.toThrow(/changed since the preview/);
  expect(t.read("A")).toBe("and again\n");
  // Git records a change to executable status even when the bytes stay put.
  const a = join(t.ws, "A");
  chmodSync(a, 0o644);
  const p3 = await t.c.rewind(t.s, { turn: t1, preview: true, includeOutside: true });
  chmodSync(a, 0o755);
  await expect(t.c.rewind(t.s, { turn: t1, includeOutside: true, confirm: { paths: p3.files, versions: p3.versions } }))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed since the preview: A") });
  expect(t.read("A")).toBe("and again\n");
  expect(statSync(a).mode & 0o777).toBe(0o755);
});

test("a file too large to capture is kept, not removed", async () => {
  const t = setup({ "notes.txt": "x".repeat(200), "small.txt": "s\n", "deleted.txt": "old\n" });
  const deleted = join(t.ws, "deleted.txt"), created = join(t.ws, "created.txt");
  const t1 = await t.turn(() => {
    t.write("notes.txt", "short"); t.write("small.txt", "t\n");
    rmSync(deleted); t.write("created.txt", "new\n");
  });
  const opts = { turn: t1, includeOutside: true };
  const p = await t.c.rewind(t.s, { ...opts, preview: true });
  expect(p.uncaptured).toEqual(["notes.txt"]);
  expect(p.files.sort()).toEqual(["created.txt", "deleted.txt", "small.txt"]);
  // Recreated since the preview, but still missing from Git's tree.
  t.write("deleted.txt", "outside\n");
  truncateSync(deleted, 1024 * 1024);
  // A captured addition can grow beyond the cap and disappear from both trees.
  truncateSync(created, 1024 * 1024);
  await expect(t.c.rewind(t.s, { ...opts, confirm: { paths: p.files, versions: p.versions } }))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed since the preview:") });
  expect(t.read("small.txt")).toBe("t\n");

  const fresh = await t.c.rewind(t.s, { ...opts, preview: true });
  expect(fresh.files).toEqual(["small.txt"]);
  expect(fresh.uncaptured.sort()).toEqual(["created.txt", "deleted.txt", "notes.txt"]);
  expect(fresh.removes).toEqual([]);
  expect(Object.keys(fresh.versions)).toEqual(["small.txt"]);
  const r = await t.c.rewind(t.s, opts);
  expect(r.files).toEqual(["small.txt"]);
  expect(r.uncaptured.sort()).toEqual(["created.txt", "deleted.txt", "notes.txt"]);
  expect(statSync(created).size).toBe(1024 * 1024);
  expect(statSync(deleted).size).toBe(1024 * 1024);
  expect(t.read("notes.txt")).toBe("short");
  expect(t.read("small.txt")).toBe("s\n");

  const s = setup({ a: "old\n", "b/child": "old\n", "a-side": "old\n", "peer/small": "old\n" });
  const turn = await s.turn(() => {
    rmSync(join(s.ws, "a"));
    rmSync(join(s.ws, "b"), { recursive: true });
    s.write("a-side", "new\n"); s.write("peer/small", "new\n");
  });
  const scoped = { turn, includeOutside: true, paths: ["a", "b/child", "a-side", "peer/small"] };
  const old = await s.c.rewind(s.s, { ...scoped, preview: true });
  expect(old.files.sort()).toEqual([...scoped.paths].sort());
  mkdirSync(join(s.ws, "a"));
  const tooLarge = ["a/large.bin", "b", "peer/large.bin"];
  for (const path of tooLarge) {
    s.write(path, "outside\n");
    truncateSync(join(s.ws, path), 1024 * 1024);
  }
  await expect(s.c.rewind(s.s, { ...scoped, confirm: { paths: old.files, versions: old.versions } }))
    .rejects.toMatchObject({ status: 409, message: expect.stringContaining("a, b/child") });
  const safe = await s.c.rewind(s.s, { ...scoped, preview: true });
  expect(safe.files.sort()).toEqual(["a-side", "peer/small"]);
  expect(safe.uncaptured.sort()).toEqual(["a/large.bin", "b"]);
  expect(safe.blocked).toEqual([{ path: "a", uncaptured: "a/large.bin" }, { path: "b/child", uncaptured: "b" }]);
  const result = await s.c.rewind(s.s, { ...scoped, confirm: { paths: safe.files, versions: safe.versions } });
  expect(result.files.sort()).toEqual(["a-side", "peer/small"]);
  for (const path of tooLarge) expect(statSync(join(s.ws, path)).size).toBe(1024 * 1024);
  expect([s.read("a-side"), s.read("peer/small")]).toEqual(["old\n", "old\n"]);
});

test("an undo point whose result was never recorded restores nothing unasked", async () => {
  const t = setup({ "a": "0\n", "b": "0\n" });
  const t1 = await t.turn(() => { t.write("a", "1\n"); t.write("b", "1\n"); });
  const r = await t.c.rewind(t.s, { turn: t1 });
  t.store.db.query("DELETE FROM checkpoints WHERE of_id = ?").run(r.undo);
  t.write("c", "new\n");
  const p = await t.c.rewind(t.s, { checkpoint: r.undo!, preview: true });
  expect(p.incomplete).toBe(true);
  expect(p.files).toEqual([]);
  // Each one is the owner's pick, the new file c too (it would be removed).
  expect(p.skipped.sort()).toEqual(["a", "b", "c"]);
  expect(p.removes).toEqual(["c"]);
});

test("a hunk revert checks the hunk's lines, not only its header", async () => {
  const t = setup({ "note.txt": "alpha\n" });
  const t1 = await t.turn(() => t.write("note.txt", "beta\n"));
  const d = await t.c.diff(t.s, { from: t1 });
  const header = d.diff.split("\n").find((l) => l.startsWith("@@"))!;
  const body = d.diff.slice(d.diff.indexOf(header) + header.length + 1);
  t.write("note.txt", "charlie\n");
  await expect(t.c.revertHunk(t.s, { from: t1, path: "note.txt", index: 0, header, body })).rejects.toThrow(/no longer as shown/);
  expect(t.read("note.txt")).toBe("charlie\n");
  t.write("note.txt", "beta\n");
  await t.c.revertHunk(t.s, { from: t1, path: "note.txt", index: 0, header, body });
  expect(t.read("note.txt")).toBe("alpha\n");
});

test("history stays readable after the session moves to another folder and back", async () => {
  const t = setup({ "note.txt": "alpha\n" });
  const a = t.ws;
  const t1 = await t.turn(() => t.write("note.txt", "beta\n"));
  const b = join(a, "..", "b");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "note.txt"), "beta\n");
  const move = (ws: string) => Object.assign(t.s, t.store.updateSession(t.s.id, { workspace: ws }));
  move(b);
  const call = { id: "c", tool: { name: "Bash", readOnly: false, kind: "shell" }, input: { command: "x" }, ctx: { cwd: b } } as any;
  t.store.append(t.s.id, "turn_start", {});
  await t.c.before(t.s, call);
  writeFileSync(join(b, "note.txt"), "gamma\n");
  await t.c.after(t.s, call);
  await t.c.end(t.s);
  await t.c.maintain();
  for (const ws of [b, a]) {
    move(ws);
    const { turns } = await t.c.turns(t.s);
    expect(turns.map((x) => [x.files.map((f) => f.path), x.elsewhere ?? null])).toEqual([[["note.txt"], ws === a ? null : a], [["note.txt"], ws === b ? null : b]]);
    expect((await t.c.diff(t.s, { turn: t1 })).diff).toContain("+beta");
  }
  move(b);
  await expect(t.c.rewind(t.s, { turn: t1, preview: true })).rejects.toThrow(/cannot be put back here/);
  expect(readFileSync(join(a, "note.txt"), "utf8")).toBe("beta\n");
});

test("undoing a turn takes back its change around a later edit, and names an overlap", async () => {
  const lines = (first: string, last = "5") => `${first}\n2\n3\n4\n${last}\n`;
  const t = setup({ "A": lines("1"), "B": lines("1") });
  const t1 = await t.turn(() => { t.write("A", lines("turn")); t.write("B", lines("turn")); });
  t.write("A", lines("turn", "owner")); // another hunk of A
  t.write("B", lines("owner"));         // the same hunk of B
  t.write("C", "new\n");
  const p = await t.c.rewind(t.s, { turn: t1, preview: true });
  expect([p.files, p.merged, p.conflicts, p.skipped.sort()]).toEqual([[], ["A"], ["B"], ["B", "C"]]);
  const r = await t.c.rewind(t.s, { turn: t1, confirm: { paths: [...p.files, ...p.merged], versions: p.versions } });
  expect(r.merged).toEqual(["A"]);
  expect(t.read("A")).toBe(lines("1", "owner"));
  expect(t.read("B")).toBe(lines("owner"));
  expect(t.read("C")).toBe("new\n");
});

// A snapshot of a workspace where nothing differs from the last one is that
// one's tree, found with one git process (the listing of what differs).
// Before, each snapshot ran six, and a turn takes three or more.
test("a snapshot of an unchanged workspace runs one git process and gives the last tree; any change is seen", async () => {
  const { Shadow } = await import("./shadow.ts");
  const dir = join(root, `case-${++n}`);
  const ws = join(dir, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "a.txt"), "one\n");
  writeFileSync(join(ws, "src/b.txt"), "two\n");
  writeFileSync(join(ws, ".gitignore"), "*.log\n");
  const sh = new Shadow(join(dir, "state", "checkpoints"), ws);
  let runs: string[] = [];
  const git = sh.git.bind(sh);
  sh.git = (args, opts) => { runs.push(args[0]!); return git(args, opts); };
  // (The listing of what differs is read as it comes, through its own call.)
  const list = sh.listEach.bind(sh);
  sh.listEach = (args, opts, each) => { runs.push(args[0]!); return list(args, opts, each); };
  // What a store that has never seen the workspace makes of it: the whole work, every time.
  let k = 0;
  const whole = () => new Shadow(join(dir, `other-${++k}`, "checkpoints"), ws).snapshot();
  const snap = async () => { runs = []; const tree = await sh.snapshot(); return { tree, runs: runs.length }; };

  const first = await snap();
  expect(first.runs).toBeGreaterThan(3);
  expect(first.tree).toBe(await whole());
  // Nothing changed: the same tree, for one process. A file git ignores changes nothing either.
  expect(await snap()).toEqual({ tree: first.tree, runs: 1 });
  writeFileSync(join(ws, "debug.log"), "ignored\n");
  expect(await snap()).toEqual({ tree: first.tree, runs: 1 });
  // Each kind of change is seen, and the tree is the one the whole work gives.
  const changes: (() => void)[] = [
    () => writeFileSync(join(ws, "a.txt"), "one, changed\n"),
    () => writeFileSync(join(ws, "src/new.txt"), "new\n"),
    () => rmSync(join(ws, "src/b.txt")),
    () => chmodSync(join(ws, "a.txt"), 0o755),
    () => writeFileSync(join(ws, ".gitignore"), "*.tmp\n"),
    () => writeFileSync(join(ws, "a.txt"), "eno, changed\n"), // the same size as before
  ];
  let before = first.tree;
  for (const change of changes) {
    change();
    const now = await snap();
    expect(now.tree).not.toBe(before);
    expect(now.tree).toBe(await whole());
    expect(await snap()).toEqual({ tree: now.tree, runs: 1 });
    before = now.tree;
  }
});

// What a snapshot leaves out stays listed as new for good: a file over the
// per-file cap, an inner repository with no commit yet. A workspace that
// holds one ran the whole work at every snapshot (seven processes).
test("an unchanged workspace with a file over the cap and an inner repository with no commit is still one listing", async () => {
  const { Shadow } = await import("./shadow.ts");
  const dir = join(root, `case-${++n}`);
  const ws = join(dir, "ws");
  mkdirSync(join(ws, "inner"), { recursive: true });
  writeFileSync(join(ws, "a.txt"), "one\n");
  writeFileSync(join(ws, "big.bin"), "x".repeat(400));
  writeFileSync(join(ws, "inner/file.txt"), "inside\n");
  const inner = (...args: string[]) => { const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: join(ws, "inner"), stdout: "pipe", stderr: "pipe" }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  inner("init", "-q");
  const sh = new Shadow(join(dir, "state", "checkpoints"), ws);
  let runs: string[] = [];
  const git = sh.git.bind(sh);
  sh.git = (args, opts) => { runs.push(args[0]!); return git(args, opts); };
  // (The listing of what differs is read as it comes, through its own call.)
  const list = sh.listEach.bind(sh);
  sh.listEach = (args, opts, each) => { runs.push(args[0]!); return list(args, opts, each); };
  let k = 0;
  const whole = async () => { const o = new Shadow(join(dir, `other-${++k}`, "checkpoints"), ws); return { tree: await o.snapshot(), skipped: o.skipped }; };
  const snap = async () => { runs = []; const tree = await sh.snapshot(); return { tree, skipped: sh.skipped, runs: runs.length }; };
  const excludes = () => readFileSync(join(sh.dir, "info", "exclude"), "utf8");

  const first = await snap();
  expect(first.runs).toBeGreaterThan(3);
  expect(first.skipped).toEqual(["big.bin"]);
  expect({ tree: first.tree, skipped: first.skipped }).toEqual(await whole());
  const left = excludes();
  expect(left).toContain("/big.bin");
  // Nothing changed: the last tree and what it skipped, for the one listing; the exclude file is as the whole work leaves it.
  for (let i = 0; i < 2; i++) {
    expect(await snap()).toEqual({ tree: first.tree, skipped: ["big.bin"], runs: 1 });
    expect(excludes()).toBe(left);
  }
  // A file inside the inner repository changes nothing of the snapshot while it has no commit.
  writeFileSync(join(ws, "inner/file.txt"), "inside, changed\n");
  expect(await snap()).toEqual({ tree: first.tree, skipped: ["big.bin"], runs: 1 });
  // Each change is seen, and gives what a store that never saw the workspace gives.
  const changes: (() => void)[] = [
    () => writeFileSync(join(ws, "big.bin"), "y".repeat(500)), // still over the cap: left out, the tree is the same
    () => writeFileSync(join(ws, "a.txt"), "one, changed\n"),
    () => writeFileSync(join(ws, "big.bin"), "small now\n"), // under the cap: it is in
    () => writeFileSync(join(ws, "big2.bin"), "z".repeat(300)), // another one over the cap
    () => { inner("add", "-A"); inner("commit", "-q", "-m", "first"); }, // the inner repository has a commit: recorded by it
    () => rmSync(join(ws, "big2.bin")),
  ];
  let before = first.tree;
  for (const [i, change] of changes.entries()) {
    change();
    const now = await snap();
    // (A file over the cap is left out: one that comes, changes or goes leaves the tree as it was.)
    expect({ i, same: now.tree === before }).toEqual({ i, same: [0, 3, 5].includes(i) });
    expect({ i, tree: now.tree, skipped: now.skipped }).toEqual({ i, ...(await whole()) });
    const again = await snap();
    expect({ i, tree: again.tree, skipped: again.skipped, runs: again.runs }).toEqual({ i, tree: now.tree, skipped: now.skipped, runs: 1 });
    before = now.tree;
  }
});

// A snapshot keeps the work tree's bytes: the files' own .gitattributes cannot pick a clean filter of the owner's
// git config (in a pull request's checkout its author would choose what runs, outside the sandbox).
test("a snapshot runs no clean filter the files' attributes name, whole or by paths", async () => {
  const { Shadow } = await import("./shadow.ts");
  const dir = join(root, `case-${++n}`);
  const ws = join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const mark = join(dir, "clean-ran");
  writeFileSync(join(dir, "clean.sh"), `#!/bin/sh\ntouch "${mark}"\ntr a-z A-Z\n`);
  chmodSync(join(dir, "clean.sh"), 0o755);
  writeFileSync(join(dir, "gitconfig"), `[filter "probe"]\n\tclean = ${join(dir, "clean.sh")}\n`);
  writeFileSync(join(ws, ".gitattributes"), "*.py filter=probe\n");
  writeFileSync(join(ws, "a.py"), "x = 1\n");
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
  try {
    const sh = new Shadow(join(dir, "state", "checkpoints"), ws);
    const tree = await sh.snapshot();
    expect(await sh.git(["cat-file", "-p", `${tree}:a.py`])).toBe("x = 1\n");
    writeFileSync(join(ws, "a.py"), "y = 2\n");
    const byPath = await sh.snapshot(["a.py"]);
    expect(await sh.git(["cat-file", "-p", `${byPath}:a.py`])).toBe("y = 2\n");
    expect(existsSync(mark)).toBe(false);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before;
  }
});
