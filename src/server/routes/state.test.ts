// The state board's telling: what a snapshot read does to the frames that follow it.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import type { Frame } from "../../core/types.ts";
import type { SessionState } from "../../core/watch.ts";
import { StateBoard } from "./state.ts";

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
