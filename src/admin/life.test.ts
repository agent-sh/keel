// The record of a start, without a daemon: what the sign of life says of the
// daemon before, what a cut turn becomes when the recovery settles it or
// leaves it, that the record is whole once, and the sentences every place
// tells it in.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localDay, localTime } from "../core/clock.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { allHooks, type CutTurn } from "../engine/hooks.ts";
import { type Life, readBefore, type Restart, restartNeedsEye, Restarts, restartSummary, restartTurnLine } from "./life.ts";

const at = (h: number, m: number, s: number) => new Date(2026, 10, 21, h, m, s).getTime();
const cut = (n: number, more: Partial<CutTurn> = {}): CutTurn => ({
  turn_event: `t${n}`, end_event: `e${n}`, started_ms: at(10, 1, 30), ran_ms: 41_600, down_ms: at(10, 2, 11), crashed: true, unstarted: false, step: 3, tools: ["Bash"], waiting: 0, ...more,
});
const life = (before: Life["before"], unknown?: string): Life => ({ before, unknown, started_ms: at(10, 2, 26), beat() {}, listening() {}, end() {} });
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "life-"));
  const store = new Store(dir);
  return { dir, store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
};
// The hooks a record registered.
const hooked = (make: () => Restarts) => { const n = allHooks().length; const rs = make(); return { rs, hook: allHooks().slice(n).find((h) => h.turnCut)! }; };

test("the sign of life says how the daemon before ended, or that it cannot be said", () => {
  const alive = { pid: 41, started_ms: at(9, 0, 0), alive_ms: at(10, 2, 11), listening_ms: at(9, 0, 4) };
  const read = (a: object | string | null, listened?: number) => readBefore(a === null || typeof a === "string" ? a : JSON.stringify(a), listened, 99);
  // No end: it went down under its work, at about its last sign.
  expect(read(alive)).toEqual({ before: { pid: 41, started_ms: at(9, 0, 0), down_ms: at(10, 2, 11), how: "killed" } });
  expect(read({ ...alive, ended_ms: at(10, 2, 12), how: "restart" }).before).toMatchObject({ how: "restart", down_ms: at(10, 2, 12) });
  expect(read({ ...alive, ended_ms: at(10, 2, 12), how: "crash", code: 1 }).before).toMatchObject({ how: "crash", code: 1 });
  // Its own listening line in the log is not another daemon; a later one is.
  expect(read(alive, at(9, 0, 5)).before).not.toBeNull();
  expect(read(alive, at(10, 30, 0))).toEqual({ before: null, unknown: "another daemon, one that keeps no sign of life, ran since the last sign" });
  // One killed before it listened: any daemon that began to answer after its last sign ran since.
  expect(read({ pid: 41, started_ms: at(9, 0, 0), alive_ms: at(9, 0, 0) }, at(9, 0, 1)).before).not.toBeNull();
  expect(read({ pid: 41, started_ms: at(9, 0, 0), alive_ms: at(9, 0, 0) }, at(9, 5, 0)).before).toBeNull();
  // Missing, empty (a kill before the first write), cut, or another format: nothing is known, and it says why.
  expect(read(null).unknown).toStartWith("no sign of life was found");
  for (const text of ["", '{"pid":41,"started_ms":17', "[]", '{"pid":41}']) expect(read(text).before).toBeNull();
  expect(read("").unknown).toBe("the sign of life was cut while it was written");
  expect(read({ ...alive, pid: 99 }).before).toBeNull();
});

test("a start records each cut turn once, what became of it, and is whole once", () => {
  const f = scratch();
  try {
    const { rs, hook } = hooked(() => new Restarts(f.store, life({ pid: 41, started_ms: at(9, 0, 0), down_ms: at(10, 2, 11), how: "killed" })));
    const session = (title: string) => f.store.createSession({ title, model: "fixture:m", workspace: f.dir }) as Session;
    const [a, b, c, d, e] = [session("Parser refactor"), session("Flaky fetch"), session("Docs"), session(""), session("Cut the time before")];
    let changes = 0;
    const whole: Restart[] = [];
    rs.changed = () => void changes++;
    rs.whole = (r) => void whole.push(r);

    hook.turnCut!(a, cut(1));
    hook.turnCut!(a, cut(1)); // told again: still one
    hook.turnCut!(b, cut(2, { step: 2, tools: [] }));
    hook.turnCut!(c, cut(3, { step: 1, tools: [], waiting: 1 }));
    hook.turnCut!(d, cut(4, { unstarted: true, ran_ms: 0 }));
    // Cut before the daemon that just went down had started: an earlier stop's, still waiting to be decided.
    hook.turnCut!(e, cut(5, { started_ms: at(8, 58, 0), down_ms: at(8, 59, 0), crashed: false }));
    expect(rs.last().turns.map((t) => [t.state, !!t.earlier])).toEqual([["pending", false], ["pending", false], ["pending", false], ["pending", false], ["pending", true]]);
    hook.turnCutSettled!(a, cut(1), "continued");
    hook.turnCutSettled!(b, cut(2), "held", "This turn was continued after a daemon restart 3 times in a row.");
    hook.turnCutSettled!(e, cut(5), "continued");
    expect(changes).toBe(8);
    // The two nobody settled: one whose session has a newer turn went on by other means, the other is as the cut left it.
    rs.finish((id) => id === c.id);
    rs.finish(() => true);
    expect(whole.length).toBe(1);
    const r = rs.last();
    expect(r.turns.map((t) => [t.title, t.state])).toEqual([["Parser refactor", "continued"], ["Flaky fetch", "held"], ["Docs", "moved"], ["", "left"], ["Cut the time before", "continued"]]);
    expect(r.settled_ms).toBeGreaterThan(0);
    // Nothing changes a record that is whole, and a later process reads the same one.
    hook.turnCut!(a, cut(9));
    expect(JSON.parse(f.store.db.query<{ data: string }, []>("SELECT data FROM daemon_starts").get()!.data)).toEqual(r);

    // The turns this stop cut are counted; the one an earlier stop cut is said apart.
    expect(restartSummary(r)).toBe(`The daemon went down without stopping (killed, or the machine went down) at about ${localTime(at(10, 2, 11))} and came back at ${localTime(at(10, 2, 26))} (down 15 s); 4 turns were cut: 1 resumed, 1 held for the owner, 1 went on by other means, 1 left as cut. 1 turn an earlier stop cut was still waiting: 1 resumed.`);
    expect(r.turns.map(restartTurnLine)).toEqual([
      '"Parser refactor" cut at step 3, during Bash, after 42 s: resumed',
      '"Flaky fetch" cut at step 2, waiting for the model, after 42 s: held for the owner',
      `"Docs" cut at step 1, waiting for the owner's answer, after 42 s: went on by other means`,
      "an untitled session cut before its turn began: left as cut",
      '"Cut the time before" cut by an earlier stop at step 3, during Bash, after 42 s: resumed',
    ]);
    // A stop the daemon made itself has an exact time; a day apart, the date is said; a failure says its code.
    const eve = new Date(2026, 10, 20, 23, 59, 50).getTime();
    expect(restartSummary({ ...r, before: { ...r.before!, how: "restart", down_ms: eve }, turns: [] }))
      .toBe(`The daemon stopped for a restart at ${localDay(eve)} ${localTime(eve)} and came back at ${localTime(at(10, 2, 26))} (down 10.1 h); no turn was cut.`);
    expect(restartSummary({ ...r, before: { ...r.before!, how: "crash", code: 1 }, turns: [] })).toStartWith("The daemon ended on a failure (exit code 1) at ");

    // What is worth a row of its own: a daemon that did not choose to go down, or a turn not continued.
    const planned = { ...r, before: { ...r.before!, how: "restart" as const } };
    expect(restartNeedsEye(r)).toBe(true);
    expect(restartNeedsEye({ ...planned, turns: [] })).toBe(false);
    expect(restartNeedsEye({ ...planned, turns: r.turns.filter((t) => t.state === "continued" || t.state === "moved") })).toBe(false);
    expect(restartNeedsEye({ ...planned, turns: r.turns.filter((t) => t.state === "held") })).toBe(true);
    expect(restartNeedsEye({ ...planned, before: { ...planned.before, how: "crash" }, turns: [] })).toBe(true);
  } finally {
    f.close();
  }
});

test("a start that knows nothing of the daemon before it keeps its own record, never an older start's", () => {
  const f = scratch();
  try {
    // An older start's record is in the store.
    new Restarts(f.store, { ...life({ pid: 41, started_ms: at(9, 0, 0), down_ms: at(9, 30, 0), how: "killed" }), started_ms: at(9, 30, 10) });
    const { rs, hook } = hooked(() => new Restarts(f.store, life(null, "the sign of life was cut while it was written")));
    expect(rs.last()).toMatchObject({ up_ms: at(10, 2, 26), before: null, unknown: "the sign of life was cut while it was written", turns: [] });
    expect(restartNeedsEye(rs.last())).toBe(false);
    // A turn it finds cut is still told, with what is known.
    const s = f.store.createSession({ title: "Found cut", model: "fixture:m", workspace: f.dir }) as Session;
    hook.turnCut!(s, cut(1));
    hook.turnCutSettled!(s, cut(1), "held", "why");
    rs.finish(() => false);
    expect(rs.last().turns.map((t) => [t.state, !!t.earlier])).toEqual([["held", false]]);
    expect(restartSummary(rs.last())).toBe(`The daemon started at ${localTime(at(10, 2, 26))}. How the one before it ended is not known: the sign of life was cut while it was written; 1 turn was found cut: 1 held for the owner.`);
    expect(restartNeedsEye(rs.last())).toBe(true);
    expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM daemon_starts").get()!.n).toBe(2);
  } finally {
    f.close();
  }
});

// The file itself, written by a process of its own: one line of a fixed
// length, in place, with the end the process made (or none, when it was killed).
test("a process leaves its sign of life as one fixed line: a stop, a failure with its code, or no end when it is killed", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "life-"));
  try {
    const run = (body: string) => Bun.spawnSync(["bun", "-e", `const { beginLife } = await import(${JSON.stringify(join(import.meta.dir, "life.ts"))}); const life = beginLife(${JSON.stringify(dir)}); ${body}`], { env: { ...process.env, KEEL_CONFIG_DIR: join(dir, "config") }, stdout: "pipe", stderr: "pipe" });
    const sign = () => { const text = readFileSync(join(dir, "daemon.alive"), "utf8"); return { text, ...JSON.parse(text) }; };
    // A first start knows nothing; it says so on stdout.
    const first = run("life.listening(); life.beat(); console.log(JSON.stringify([life.before, life.unknown])); process.exit(0);");
    expect(JSON.parse(first.stdout.toString())).toEqual([null, "no sign of life was found (a first start, or the daemon before kept none)"]);
    expect(sign()).toMatchObject({ how: "stop", ended_ms: expect.any(Number), listening_ms: expect.any(Number) });
    expect(sign().text.length).toBe(192);
    // The next reads that stop, then ends on a failure: recorded as that, with the code.
    const second = run("console.log(JSON.stringify(life.before)); process.exit(3);");
    expect(JSON.parse(second.stdout.toString())).toMatchObject({ how: "stop", pid: first.pid });
    expect(sign()).toMatchObject({ how: "crash", code: 3 });
    expect(sign().text.length).toBe(192);
    // Killed: no end, and the one after reads it as that, at its last sign.
    const third = run("console.log(JSON.stringify(life.before)); process.kill(process.pid, 'SIGKILL');");
    expect(JSON.parse(third.stdout.toString())).toMatchObject({ how: "crash", code: 3 });
    expect(sign().ended_ms).toBeUndefined();
    const fourth = run("console.log(JSON.stringify(life.before)); process.exit(0);");
    expect(JSON.parse(fourth.stdout.toString())).toMatchObject({ how: "killed", pid: third.pid, down_ms: expect.any(Number) });
    // A daemon that keeps no sign of life ran since (its log says it began to answer): nothing is said of the one before.
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", `keel-${new Date().toISOString().slice(0, 10)}.log`), `${new Date(Date.now() + 60_000).toISOString()} INFO  keel listening on http://127.0.0.1:1 (state ${dir})\n`);
    const fifth = run("console.log(JSON.stringify([life.before, life.unknown])); process.exit(0);");
    expect(JSON.parse(fifth.stdout.toString())).toEqual([null, "another daemon, one that keeps no sign of life, ran since the last sign"]);
    // An empty file (a kill between the open and the first write) says nothing either.
    writeFileSync(join(dir, "daemon.alive"), "");
    rmSync(join(dir, "logs"), { recursive: true });
    const sixth = run("console.log(JSON.stringify([life.before, life.unknown])); process.exit(0);");
    expect(JSON.parse(sixth.stdout.toString())).toEqual([null, "the sign of life was cut while it was written"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
