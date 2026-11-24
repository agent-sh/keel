// A loop's runs across a daemon restart, with a stand-in engine and a clock
// the test sets: a turn cut at a chosen point and a restart on the same state
// folder cannot be made to happen on cue from the page.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { alertHook, flush, setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as loops from "./loops.ts";

let store!: Store;
const running = new Set<string>();
const sent: { id: string; text: string }[] = [];
const engine = {
  isRunning: (id: string) => running.has(id),
  send: (id: string, text: string, o: any) => {
    sent.push({ id, text });
    running.add(id);
    return { event: store.append(id, "user", { text, ...o?.meta }) };
  },
};
// A daemon on a state folder; called again on the same folder, the daemon after a restart.
function boot(dir: string) {
  running.clear();
  store = new Store(dir);
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { current: () => [] } } as any);
  activity.migrate();
  loops.migrate();
}
const fresh = () => boot(mkdtempSync(join(tmpdir(), "keel-loops-")));
const restart = () => { const dir = store.stateDir; store.db.close(); boot(dir); loops.recover(); };
const session = () => store.createSession({ model: "m", workspace: "/", title: "t" });
const usage = (n: number) => ({ input: n, output: 0, cache_read: 0, cache_write: 0 });
const step = (id: string, tokens: number) => {
  store.append(id, "turn_start", {});
  store.append(id, "assistant", { blocks: [{ type: "text", text: "working" }], usage: usage(tokens) });
};
// The turn ends by itself: the engine's end, then the turn-end hook.
const end = (id: string, reason = "end_turn") => {
  store.append(id, "turn_end", { reason });
  running.delete(id);
  loops.onTurnEnd(id, reason);
  flush(id);
};
// What the engine's recovery does with a cut turn it continues.
const continued = (id: string, crashed: boolean) => {
  if (crashed) store.append(id, "turn_end", { reason: "restart", crashed: true });
  store.append(id, "user", { text: "[harness] The daemon restarted during your previous turn. Continue where it left off.", origin: "restart" });
  running.add(id);
  step(id, 7);
  end(id);
};
const started = (loopId: string) => loops.runs(loopId).filter((r) => r.started_ms);
const skipped = (loopId: string) => loops.runs(loopId).filter((r) => r.skip_reason).map((r) => r.skip_reason);
const at = (ms: number) => setSystemTime(new Date(ms));
afterEach(() => { setSystemTime(); sent.length = 0; });

for (const how of ["a graceful stop", "a crash"] as const) {
  test(`a loop run cut by ${how} closes once as ok when the engine continues its turn`, () => {
    fresh();
    const s = session();
    const { loop } = loops.create({ session_id: s.id, schedule: "1m", prompt: "tick" });
    loops.runNow(loop.id);
    step(s.id, 5);
    if (how === "a graceful stop") {
      // The turn is parked: its end is stored and the turn-end hook runs with "restart".
      store.append(s.id, "turn_end", { reason: "restart" });
      loops.onTurnEnd(s.id, "restart");
    } else store.db.run("UPDATE sessions SET phase = 'working' WHERE id = ?", [s.id]);
    restart();
    expect(started(loop.id)).toMatchObject([{ ended_ms: null, outcome: null }]);
    expect(loops.get(loop.id)).toMatchObject({ fails: 0, runs: 1, last_status: "running" });

    // Its next time comes before the engine has continued the turn: no second run starts.
    at(loops.get(loop.id)!.next_ms! + 1000);
    loops.tick();
    expect(sent).toHaveLength(1);
    expect(skipped(loop.id)).toEqual(["the previous run was still going"]);

    continued(s.id, how === "a crash");
    expect(started(loop.id)).toMatchObject([{ outcome: "ok", ok: true, detail: "end_turn", usage: { calls: 2, input: 12 }, note: expect.stringContaining("Resumed after a daemon restart.") }]);
    expect(loops.get(loop.id)).toMatchObject({ fails: 0, runs: 1, last_status: "ok", enabled: true });
  });
}

test("a cut loop turn the engine holds closes its run with the reason, and no other run starts before that", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1m", prompt: "tick" });
  const other = loops.create({ session_id: s.id, schedule: "1m", prompt: "tock" }).loop;
  loops.runNow(loop.id);
  step(s.id, 5);
  store.append(s.id, "turn_end", { reason: "restart" });
  loops.onTurnEnd(s.id, "restart");
  restart();

  // Both loops come due while the cut turn waits for the engine: neither starts a turn over it.
  at(Math.max(loops.get(loop.id)!.next_ms!, loops.get(other.id)!.next_ms!) + 1000);
  loops.tick();
  expect(sent).toHaveLength(1);
  expect(started(other.id)).toHaveLength(0);

  const why = "This turn was continued after a daemon restart 3 times in a row, so it was not continued again.";
  store.append(s.id, "note", { kind: "restart", text: why });
  loops.onCutTurnHeld(s.id, why);
  expect(started(loop.id)).toMatchObject([{ outcome: "incomplete", ok: false, detail: why }]);
  expect(loops.get(loop.id)).toMatchObject({ fails: 1, last_status: "incomplete" });
  // The session is free now: the prompt that waited goes, as one new run.
  expect(sent.map((x) => x.text)).toEqual(["tick", "tock"]);
  expect(started(other.id)).toMatchObject([{ ended_ms: null }]);
});

test("a run whose turn had ended when the daemon went down is settled with how it ended", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1m", prompt: "tick" });
  loops.runNow(loop.id);
  step(s.id, 5);
  store.append(s.id, "turn_end", { reason: "end_turn" }); // the daemon stops before the turn-end hook runs
  restart();
  expect(started(loop.id)).toMatchObject([{ outcome: "ok", detail: "end_turn" }]);
  expect(loops.get(loop.id)).toMatchObject({ fails: 0, last_status: "ok" });
});

test("a parked turn the engine neither continues nor holds is not waited for past the engine's time to decide", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1m", prompt: "tick" });
  const other = loops.create({ session_id: s.id, schedule: "1m", prompt: "tock" }).loop;
  loops.runNow(loop.id);
  step(s.id, 5);
  store.append(s.id, "turn_end", { reason: "restart" });
  loops.onTurnEnd(s.id, "restart");
  restart();
  const boot = Date.now();
  // While the engine may still decide: the other loop's prompt waits, the cut run stays open.
  at(boot + 61_000);
  loops.tick();
  expect(sent).toHaveLength(1);
  expect(started(loop.id)).toMatchObject([{ ended_ms: null }]);
  expect(started(other.id)).toHaveLength(0);
  // Past that time nothing was decided: the cut run closes as not finished and the prompt that waited goes.
  at(boot + 5 * 60_000 + 1000);
  loops.tick();
  expect(started(loop.id).at(-1)).toMatchObject({ outcome: "incomplete", detail: expect.stringContaining("not resumed") });
  expect(sent.map((x) => x.text)).toEqual(["tick", "tock"]);
  expect(started(other.id)).toMatchObject([{ ended_ms: null }]);
});

test("a self-paced loop whose run stays open across a restart is not armed again until that run ends", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "auto", prompt: "tick" });
  loops.tick();
  step(s.id, 5);
  store.append(s.id, "turn_end", { reason: "restart" });
  loops.onTurnEnd(s.id, "restart");
  restart();
  expect(loops.get(loop.id)!.next_ms ?? null).toBeNull();
  at(Date.now() + 61_000);
  loops.tick();
  expect(skipped(loop.id)).toEqual([]);
  continued(s.id, false);
  expect(started(loop.id)).toMatchObject([{ outcome: "ok" }]);
  expect(loops.get(loop.id)!.next_ms).toBeGreaterThan(Date.now());
});

// --- a webhook request that waits

const hook = (o: Partial<loops.CreateInput> = {}) => {
  fresh();
  const s = session();
  const { loop, hook_key } = loops.create({ session_id: s.id, schedule: "webhook", prompt: "handle it", ...o });
  return { s, loop, key: hook_key! };
};

const dropped: [string, Partial<loops.CreateInput>, (id: string, t0: number) => void, RegExp][] = [
  ["paused", {}, (id) => void loops.update(id, { enabled: false }), /paused/],
  ["expired", { until_ms: Date.now() + 60_000 }, (_id, t0) => at(t0 + 61_000), /expired/],
  ["out of runs", { max_runs: 1 }, () => {}, /had run its runs/],
];
for (const [state, input, change, reason] of dropped) {
  test(`a webhook request that waited behind a run is not run, on record, once the loop is ${state}`, () => {
    const t0 = Date.now();
    at(t0);
    const { s, loop, key } = hook(input);
    loops.webhook(key, '{"n":1}');
    step(s.id, 5);
    loops.webhook(key, '{"n":2}'); // waits behind the run
    change(loop.id, t0);
    end(s.id);
    // Later, and after a restart: still nothing.
    at(t0 + 3600_000);
    loops.tick();
    restart();
    loops.tick();
    expect(sent.map((x) => x.text)).toEqual([expect.stringContaining('n\\":1')]);
    expect(started(loop.id)).toHaveLength(1);
    expect(skipped(loop.id)).toEqual([expect.stringMatching(reason)]);
  });
}

test("a webhook request that waited survives a restart and runs once, no sooner than the minimum interval", () => {
  const t0 = Date.now();
  at(t0);
  const { s, loop, key } = hook({ min_interval_seconds: 60 });
  loops.webhook(key, '{"n":1}');
  step(s.id, 5);
  at(t0 + 5_000);
  loops.webhook(key, '{"n":2}'); // waits behind the run
  at(t0 + 8_000);
  end(s.id); // the run ended 8 s after it began: the next may start at 60 s
  expect(sent).toHaveLength(1);
  restart();
  at(t0 + 30_000);
  loops.tick();
  expect(sent).toHaveLength(1);
  at(t0 + 60_500);
  loops.tick();
  expect(sent.map((x) => x.text)).toEqual([expect.stringContaining('n\\":1'), expect.stringContaining('n\\":2')]);
  step(s.id, 5);
  end(s.id);
  // Once: later ticks and another restart start nothing more.
  at(t0 + 600_000);
  loops.tick();
  restart();
  loops.tick();
  expect(sent).toHaveLength(2);
  expect(started(loop.id)).toMatchObject([{ outcome: "ok" }, { outcome: "ok" }]);
  expect(skipped(loop.id)).toEqual([]);
  expect(loops.get(loop.id)).toMatchObject({ runs: 2, next_ms: null, enabled: true });
});

test("an edit of a webhook loop keeps the time its waiting request goes", () => {
  const t0 = Date.now();
  at(t0);
  const { s, loop, key } = hook({ min_interval_seconds: 60 });
  loops.webhook(key, '{"n":1}');
  step(s.id, 5);
  end(s.id);
  at(t0 + 5_000);
  loops.webhook(key, '{"n":2}'); // waits for the minimum interval
  expect(loops.get(loop.id)!.next_ms).toBe(t0 + 60_000);
  loops.update(loop.id, { schedule: "webhook", name: "Renamed" });
  expect(loops.get(loop.id)).toMatchObject({ name: "Renamed", next_ms: t0 + 60_000 });
  at(t0 + 60_500);
  loops.tick();
  expect(sent.map((x) => x.text)).toEqual([expect.stringContaining('n\\":1'), expect.stringContaining('n\\":2')]);
});

test("a calendar loop whose saved schedule the parser now refuses is turned off with the reason, once", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "0 9 * * *", prompt: "tick" });
  store.db.run("UPDATE loops SET schedule = '*/2/3 * * * *', next_ms = ? WHERE id = ?", [Date.now() - 1000, loop.id]);
  expect(loops.get(loop.id)!.next_runs).toEqual([]);
  const alerts: string[][] = [];
  alertHook.raise = (kind, _session, title, body) => void alerts.push([kind, title, body]);
  try {
    loops.tick();
    loops.tick();
  } finally {
    alertHook.raise = undefined;
  }
  expect(loops.get(loop.id)).toMatchObject({ enabled: false, next_ms: null, disabled_reason: expect.stringContaining("not valid") });
  expect(sent).toHaveLength(0);
  // The owner is told, once: an activity row and an alert.
  expect(alerts).toEqual([["loop_failed", expect.stringContaining("tick"), expect.stringContaining("*/2/3")]]);
  const rows = store.db.query<{ text: string }, [string]>("SELECT text FROM activity WHERE session_id = ? AND kind = 'loop'").all(s.id);
  expect(rows.map((r) => r.text)).toEqual([expect.stringContaining("turned off")]);
});

// A time that passed while nothing ticked (the daemon was down, or the
// machine slept under it) is run once when ticks come back, and the run says
// it is a catch-up: for which time, how late, and how many later times it
// stands for. The times in between start no runs of their own.
test("a time missed while the daemon was down or the machine slept runs once, marked as catch-up", () => {
  const t0 = Date.UTC(2026, 0, 5, 8, 0, 0);
  at(t0);
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1h", prompt: "tick" });
  expect(loops.get(loop.id)!.next_ms).toBe(t0 + 3_600_000);

  // Down over the 9:00, 10:00, 11:00 and 12:00 times; back at 12:10.
  at(t0 + 4 * 3_600_000 + 600_000);
  restart();
  loops.tick();
  loops.tick();
  expect(sent).toHaveLength(1);
  const [run] = started(loop.id);
  expect(run).toMatchObject({ due_ms: t0 + 3_600_000 });
  expect(run!.note).toMatch(/^Catch-up for .+, 190 min late \(.+\)\. The 3 later times it missed are not run separately\.$/);
  // An interval counts on from the run, not from the times it missed.
  const second = t0 + 5 * 3_600_000 + 600_000;
  expect(loops.get(loop.id)!.next_ms).toBe(second);
  step(s.id, 5);
  end(s.id);
  expect(activity.list({ session_id: s.id }).items.map((a) => a.text).filter((t) => t.includes("started a run"))).toEqual([expect.stringContaining("(Catch-up for")]);

  // The machine sleeps over that time only, with the daemon up: one run, and no later time to name.
  at(second + 20 * 60_000);
  loops.tick();
  expect(sent).toHaveLength(2);
  expect(started(loop.id).find((r) => r.due_ms === second)!.note).toMatch(/^Catch-up for .+, 20 min late \(.+\)\.$/);
  step(s.id, 5);
  end(s.id);

  // A run on time is no catch-up, and nothing else started meanwhile.
  const third = loops.get(loop.id)!.next_ms!;
  expect(third).toBe(second + 20 * 60_000 + 3_600_000);
  at(third + 500);
  loops.tick();
  expect(sent).toHaveLength(3);
  expect(started(loop.id).find((r) => r.due_ms === third)!.note).toBeNull();
  expect(loops.runs(loop.id)).toHaveLength(3);
  step(s.id, 5);
  end(s.id);

  // A calendar loop: every day at 9:00 UTC, missed on three days. One run for
  // the first, and the two later ones named.
  const daily = loops.create({ session_id: session().id, schedule: "0 9 * * *", tz: "UTC", prompt: "daily" }).loop;
  const first = loops.get(daily.id)!.next_ms!;
  at(first + 2 * 86_400_000 + 30 * 60_000);
  restart();
  loops.tick();
  loops.tick();
  const runs = started(daily.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.note).toMatch(/^Catch-up for .+, 2910 min late \(.+\)\. The 2 later times it missed are not run separately\.$/);
  expect(loops.get(daily.id)!.next_ms).toBe(first + 3 * 86_400_000);
});

// --- how long a model's loop lasts, and the line that says it ended

const DAY = 86400_000;
// What the daemon says in the session's scope while the body runs.
const said = (body: () => void) => {
  const lines: string[] = [];
  const was = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try { body(); } finally { console.log = was; }
  return lines.filter((l) => l.startsWith("[loop]"));
};

test("a loop the model makes lasts 30 days, and its end is said once in the session", () => {
  const t0 = Date.now();
  at(t0);
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1h", prompt: "look", name: "nightly", created_by: "model" });
  expect(loop.until_ms).toBe(t0 + 30 * DAY);
  // A longer end the model asks for is cut to the 30 days; the owner's own loop keeps what it asked.
  expect(loops.create({ session_id: s.id, schedule: "1h", prompt: "x", created_by: "model", until_ms: t0 + 90 * DAY }).loop.until_ms).toBe(t0 + 30 * DAY);
  at(t0 + 29 * DAY);
  expect(said(() => loops.tick())).toEqual([]);
  at(t0 + 30 * DAY + 1000);
  const lines = said(() => { loops.tick(); loops.tick(); });
  expect(lines.filter((l) => l.includes('"nightly"'))).toEqual([expect.stringMatching(/"nightly" ended: .*30 days/)]);
  expect(loops.get(loop.id)).toMatchObject({ enabled: false, disabled_reason: "expired" });
});

test("a loop that ran its runs says so once, in the session", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "1m", prompt: "tick", name: "twice", max_runs: 1 });
  const lines = said(() => { loops.runNow(loop.id); step(s.id, 5); end(s.id); });
  expect(lines.filter((l) => l.includes('"twice" ended'))).toEqual([expect.stringMatching(/"twice" ended: ran its 1 run/)]);
  expect(loops.get(loop.id)).toMatchObject({ enabled: false, disabled_reason: "ran its 1 runs" });
});
