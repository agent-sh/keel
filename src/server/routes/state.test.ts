// The state board's telling: what a snapshot read does to the frames that follow it.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ResultLandings } from "../../automation/result-landings.ts";
import { Store } from "../../core/store.ts";
import type { Frame } from "../../core/types.ts";
import type { SessionState } from "../../core/watch.ts";
import { readsOf } from "../reads.ts";
import { StateBoard, SWEEP_FRESH_MS, sweepDue } from "./state.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-"));
  const store = new Store(dir);
  const bus = new Bus();
  const running = new Set<string>();
  const engine = { isRunning: (id: string) => running.has(id) };
  const board = new StateBoard({ store, bus, engine } as any);
  const told: [string, SessionState | null][] = [];
  bus.on((f: Frame) => { if (f.t === "feature" && f.name === "state") told.push([f.session_id!, f.data as SessionState | null]); });
  return { store, board, told, running, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a snapshot read between a change and its telling does not swallow the frame", () => {
  const { store, board, told, done } = fixture();
  try {
    const s = store.createSession({ model: "m", workspace: "/w", title: "Waits on a timer" });
    board.touch(s.id);
    board.flush();
    expect(told.map(([, st]) => st?.watch)).toEqual(["idle"]);
    // Its state changes; before the change is told, something reads every state
    // (a page's GET /api/state, a peer's relay opening, the command line).
    store.updateSession(s.id, { phase: "working" });
    board.touch(s.id);
    expect(board.all()[s.id]!.watch).toBe("work");
    board.flush();
    // The listeners that were told "idle" are told "work": the read told them nothing.
    expect(told.map(([, st]) => st?.watch)).toEqual(["idle", "work"]);
    // And a second change straight after it is told too.
    store.updateSession(s.id, { phase: "idle", usage: { ...s.usage, output: 5 } });
    board.touch(s.id);
    board.all();
    board.flush();
    expect(told.map(([, st]) => st?.watch)).toEqual(["idle", "work", "done"]);
  } finally {
    done();
  }
});

test("a session only a snapshot has seen is still looked at again while it is not at rest", () => {
  const { store, board, told, done } = fixture();
  try {
    const s = store.createSession({ model: "m", workspace: "/w", title: "Was working when the daemon started" });
    store.updateSession(s.id, { phase: "working" });
    // No frame ever named it: a snapshot is the first to read it.
    expect(board.all()[s.id]!.watch).toBe("work");
    // Its turn ends with no frame to say so (a command left running ends): the sweep finds it.
    store.updateSession(s.id, { phase: "idle", usage: { ...s.usage, output: 5 } });
    board.sweep();
    board.flush();
    expect(told.map(([, st]) => st?.watch)).toEqual(["done"]);
  } finally {
    done();
  }
});

test("a change of the word is told at once, also while a step change waits its turn", async () => {
  const { store, board, told, running, done } = fixture();
  try {
    const s = store.createSession({ model: "m", workspace: "/w", title: "Steps, then ends" });
    store.updateSession(s.id, { phase: "working" });
    running.add(s.id);
    board.touch(s.id);
    board.flush();
    // Another step right after: held back (one step after another is told at most every 600 ms).
    store.mergeSettings(s.id, { tags: ["x"] });
    (board as any).last.set(s.id, "{}");
    board.touch(s.id);
    board.flush();
    expect(told).toHaveLength(1);
    // The turn ends: the word changes and is told within the settle time, not after the step's wait.
    running.delete(s.id);
    store.updateSession(s.id, { phase: "idle", usage: { ...s.usage, output: 5 } });
    board.touch(s.id);
    await Bun.sleep(120);
    expect(told.map(([, st]) => st?.watch)).toEqual(["work", "done"]);
  } finally {
    done();
  }
});

test("the sweep leaves a session the telling read a moment ago", () => {
  const readAt = new Map([["fresh", 10_000], ["old", 10_000 - SWEEP_FRESH_MS]]);
  expect(sweepDue(["fresh", "old", "never"], readAt, 10_000 + 1)).toEqual(["old", "never"]);
  expect(sweepDue(["fresh"], readAt, 10_000 + SWEEP_FRESH_MS)).toEqual(["fresh"]);
});

test("the coordinator's row reports a git landing even when the queue is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-state-landed-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
  const store = new Store(join(dir, "state"));
  const bus = new Bus();
  let complete!: () => void;
  let changed = new Promise<void>((resolve) => { complete = resolve; });
  const landings = new ResultLandings(store, async () => "refs/heads/main", (id) => { board.touch(id); board.flush(); complete(); }, (e) => { throw e; });
  const board = new StateBoard({ store, bus, engine: { isRunning: () => false } } as any, landings);
  const results: unknown[] = [];
  const off = bus.on((f) => {
    if (f.t === "feature" && f.name === "state") results.push((f.data as SessionState).result);
  });
  try {
    g("init", "-q", "-b", "main");
    g("commit", "--allow-empty", "-qm", "base");
    const base = g("rev-parse", "HEAD");
    g("branch", "keel/empty");
    g("checkout", "-qb", "keel/agent");
    g("commit", "--allow-empty", "-qm", "agent work");
    const head = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    const s = store.createSession({ workspace: repo, model: "m", title: "Coordinator" });
    store.db.exec(`
      CREATE TABLE agents (session_id TEXT, parent_id TEXT, machine TEXT, branch TEXT, status TEXT, title TEXT, type TEXT, ended INTEGER, created INTEGER, id TEXT PRIMARY KEY);
      CREATE INDEX agents_parent ON agents(parent_id);
      CREATE TABLE worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT, branch TEXT, base_commit TEXT);
      CREATE TABLE overlap_marks (session_id TEXT, repo TEXT, branch TEXT, tip TEXT);
    `);
    for (const [id, branch, tip] of [["empty", "keel/empty", base], ["agent", "keel/agent", head]]) {
      store.db.run("INSERT INTO agents VALUES (?, ?, NULL, ?, 'completed', ?, 'general', 1, 1, ?)", [id!, s.id, branch!, id!, id!]);
      store.db.run("INSERT INTO worktrees VALUES (?, ?, ?, ?)", [id!, repo, branch!, base]);
      store.db.run("INSERT INTO overlap_marks VALUES (?, ?, ?, ?)", [id!, repo, branch!, tip!]);
    }
    expect(board.read(s.id)?.result).toBeUndefined();
    g("merge", "-q", "--ff-only", "keel/agent");
    board.onFrame({ t: "feature", name: "tree_review", session_id: s.id, data: { repo } });
    await changed;
    const landed = { kind: "landed", what: "keel/agent", head: head.slice(0, 9), ok: true };
    expect(results.at(-1)).toMatchObject(landed);
    expect(board.read(s.id)?.result).toMatchObject(landed);

    // Reconnection after cleanup still has a fact, not a hash parsed from a report.
    g("branch", "-D", "keel/agent");
    g("commit", "--allow-empty", "-qm", "next work on main");
    landings.forget(s.id);
    changed = new Promise<void>((resolve) => { complete = resolve; });
    board.all();
    await changed;
    expect(board.read(s.id)?.result).toMatchObject(landed);

    // A reflog entry alone is not evidence after main moves back.
    g("reset", "--hard", base);
    changed = new Promise<void>((resolve) => { complete = resolve; });
    board.onFrame({ t: "feature", name: "tree_review", session_id: s.id, data: { repo } });
    await changed;
    expect(board.read(s.id)?.result).toBeUndefined();
  } finally {
    off();
    readsOf(store).close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
