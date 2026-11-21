// The record of a start, without a daemon: what a cut turn becomes when the
// recovery settles it or leaves it, that the record is whole once, and the
// sentences every place tells it in.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { allHooks, type CutTurn } from "../engine/hooks.ts";
import { type Life, type Restart, Restarts, restartSummary, restartTurnLine } from "./life.ts";

const at = (h: number, m: number, s: number) => new Date(2026, 10, 21, h, m, s).getTime();
// The time of day as this machine's locale writes it (the sentences use the reader's own).
const hms = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hourCycle: "h23" });
const cut = (n: number, more: Partial<CutTurn> = {}): CutTurn => ({
  turn_event: `t${n}`, end_event: `e${n}`, started_ms: at(10, 1, 30), ran_ms: 41_600, down_ms: at(10, 2, 11), crashed: true, unstarted: false, step: 3, tools: ["Bash"], waiting: 0, ...more,
});

test("a start records each cut turn once, what became of it, and is whole once", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "life-"));
  const store = new Store(dir);
  try {
    const life: Life = { before: { pid: 41, started_ms: at(9, 0, 0), down_ms: at(10, 2, 11), how: "killed" }, started_ms: at(10, 2, 26), end() {} };
    const hooksBefore = allHooks().length;
    const rs = new Restarts(store, life);
    const hook = allHooks().slice(hooksBefore).find((h) => h.turnCut)!;
    const session = (title: string) => store.createSession({ title, model: "fixture:m", workspace: dir }) as Session;
    const [a, b, c, d] = [session("Parser refactor"), session("Flaky fetch"), session("Docs"), session("")];
    let changes = 0;
    const whole: Restart[] = [];
    rs.changed = () => void changes++;
    rs.whole = (r) => void whole.push(r);

    hook.turnCut!(a, cut(1));
    hook.turnCut!(a, cut(1)); // told again: still one
    hook.turnCut!(b, cut(2, { step: 2, tools: [] }));
    hook.turnCut!(c, cut(3, { step: 1, tools: [], waiting: 1 }));
    hook.turnCut!(d, cut(4, { unstarted: true, ran_ms: 0 }));
    expect(rs.last()!.turns.map((t) => t.state)).toEqual(["pending", "pending", "pending", "pending"]);
    hook.turnCutSettled!(a, cut(1), "continued");
    hook.turnCutSettled!(b, cut(2), "held", "This turn was continued after a daemon restart 3 times in a row.");
    expect(changes).toBe(6);
    // The two nobody settled: one whose session has a newer turn went on by other means, the other is as the cut left it.
    rs.finish((id) => id === c.id);
    rs.finish(() => true);
    expect(whole.length).toBe(1);
    const r = rs.last()!;
    expect(r.turns.map((t) => [t.title, t.state])).toEqual([["Parser refactor", "continued"], ["Flaky fetch", "held"], ["Docs", "moved"], ["", "left"]]);
    expect(r.settled_ms).toBeGreaterThan(0);
    // Nothing changes a record that is whole, and a later process reads the same one.
    hook.turnCut!(a, cut(9));
    expect(JSON.parse(store.db.query<{ data: string }, []>("SELECT data FROM daemon_starts").get()!.data)).toEqual(r);

    expect(restartSummary(r)).toBe(`The daemon went down without stopping (killed or crashed) at about ${hms(at(10, 2, 11))} and came back at ${hms(at(10, 2, 26))} (down 15 s); 4 turns were cut: 1 continued, 1 held for the owner, 1 went on by other means, 1 left as cut.`);
    expect(r.turns.map(restartTurnLine)).toEqual([
      '"Parser refactor" cut at step 3, during Bash, after 42 s: continued',
      '"Flaky fetch" cut at step 2, waiting for the model, after 42 s: held for the owner',
      '"Docs" cut at step 1, waiting for an approval, after 42 s: went on by other means',
      "an untitled session cut before its turn began: left as cut",
    ]);
    // A stop the daemon made itself has an exact time; a day apart, the date is said.
    const eve = new Date(2026, 10, 20, 23, 59, 50);
    expect(restartSummary({ ...r, before: { ...r.before, how: "restart", down_ms: eve.getTime() }, turns: [] }))
      .toBe(`The daemon stopped for a restart at ${eve.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hms(eve.getTime())} and came back at ${hms(at(10, 2, 26))} (down 10.1 h); no turn was cut.`);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first start, with no daemon known before it, keeps no record", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "life-"));
  const store = new Store(dir);
  try {
    const rs = new Restarts(store, { before: null, started_ms: Date.now(), end() {} });
    expect(rs.last()).toBeNull();
    rs.finish(() => true);
    expect(store.db.query("SELECT 1 FROM daemon_starts").get()).toBeNull();
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
