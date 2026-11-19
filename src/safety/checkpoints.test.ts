// The checkpoint engine on a real shadow repository and store: the cases an
// e2e cannot stage (a git step that fails, retention, an edit landing between
// two tool calls of one turn, a restore cut before its result was recorded).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a confirmed restore takes only what the preview showed, at the version it showed", async () => {
  const t = setup({ "turn.txt": "0\n", "A": "0\n", "B": "0\n" });
  const t1 = await t.turn(() => t.write("turn.txt", "1\n"));
  t.write("A", "owner\n");
  const p = await t.c.rewind(t.s, { turn: t1, preview: true });
  expect(p.skipped).toEqual(["A"]);
  t.write("B", "owner\n");
  const confirm = { paths: [...p.files, ...p.skipped], versions: p.versions };
  const r = await t.c.rewind(t.s, { turn: t1, includeOutside: true, confirm });
  expect(r.files.sort()).toEqual(["A", "turn.txt"]);
  expect(t.read("B")).toBe("owner\n");
  // A file edited again after its preview is not written from the old one.
  t.write("A", "again\n");
  const p2 = await t.c.rewind(t.s, { turn: t1, preview: true, includeOutside: true });
  t.write("A", "and again\n");
  await expect(t.c.rewind(t.s, { turn: t1, includeOutside: true, confirm: { paths: p2.files, versions: p2.versions } })).rejects.toThrow(/changed since the preview/);
  expect(t.read("A")).toBe("and again\n");
});

test("a file too large to capture is kept, not removed", async () => {
  const t = setup({ "notes.txt": "x".repeat(200), "small.txt": "s\n" });
  const t1 = await t.turn(() => { t.write("notes.txt", "short"); t.write("small.txt", "t\n"); });
  const p = await t.c.rewind(t.s, { turn: t1, preview: true });
  expect(p.uncaptured).toEqual(["notes.txt"]);
  expect(p.files).toEqual(["small.txt"]);
  await t.c.rewind(t.s, { turn: t1 });
  expect(t.read("notes.txt")).toBe("short");
  expect(t.read("small.txt")).toBe("s\n");
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
