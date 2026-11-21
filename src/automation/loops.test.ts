// A loop's runs across a daemon restart, with a stand-in engine and a clock
// the test sets: a turn cut at a chosen point and a restart on the same state
// folder cannot be made to happen on cue from the page.
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { flush, setDeps } from "./core.ts";
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
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
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
afterEach(() => void setSystemTime());

for (const how of ["a graceful stop", "a crash"] as const) {
  test(`a loop run cut by ${how} closes once as ok when the engine continues its turn`, () => {
    fresh();
    const s = session();
    const { loop } = loops.create({ session_id: s.id, schedule: "10m", prompt: "tick" });
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
    expect(started(loop.id)).toMatchObject([{ outcome: "ok", ok: true, detail: "end_turn", usage: { calls: 2, input: 12 }, note: expect.stringContaining("Continued after a daemon restart.") }]);
    expect(loops.get(loop.id)).toMatchObject({ fails: 0, runs: 1, last_status: "ok", enabled: true });
    sent.length = 0;
  });
}

test("a cut loop turn the engine holds closes its run with the reason, and no other run starts before that", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "10m", prompt: "tick" });
  const other = loops.create({ session_id: s.id, schedule: "10m", prompt: "tock" }).loop;
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
  sent.length = 0;
});

test("a run whose turn had ended when the daemon went down is settled with how it ended", () => {
  fresh();
  const s = session();
  const { loop } = loops.create({ session_id: s.id, schedule: "10m", prompt: "tick" });
  loops.runNow(loop.id);
  step(s.id, 5);
  store.append(s.id, "turn_end", { reason: "end_turn" }); // the daemon stops before the turn-end hook runs
  restart();
  expect(started(loop.id)).toMatchObject([{ outcome: "ok", detail: "end_turn" }]);
  expect(loops.get(loop.id)).toMatchObject({ fails: 0, last_status: "ok" });
  sent.length = 0;
});
