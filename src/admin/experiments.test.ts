// Experiment evidence over a real store, on cases the page cannot script:
// subagent families, a daemon restart, turns that end after a stop.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { experimentRoutes, experiments, outcomes } from "../server/routes/experiments.ts";
import { armOf, Experiments, familyObs, FAMILIES_PER_ARM, liveGuards, report, TURNS, WINDOW_MIN, type Experiment, type FamilyTurn, type Obs } from "./experiments.ts";
import { offlineReport, runMetrics, Uploads } from "./offline.ts";
import type { Outcomes } from "./outcomes.ts";
import { assignArm, rng } from "./stats.ts";
import { Telemetry } from "./telemetry.ts";

// A daemon's experiment wiring over a state folder, routes included; `open`
// again is a restart. `call` is a request to its API.
function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "keel-experiments-"));
  const open = () => {
    const store = new Store(dir), bus = new Bus();
    // Subagent sessions name their parent (the agents module's column).
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    new Telemetry(store, bus);
    const calls = allHooks().at(-1)!; // the telemetry's own hooks: a model request sent, answered, failed
    const routes = experimentRoutes({ store, errors: new ErrorTracker(store, bus) } as any);
    const call = async (method: string, path: string, body?: unknown) => {
      for (const [pattern, handlers] of Object.entries(routes)) {
        const m = new RegExp(`^${pattern.replace(":id", "([^/]+)")}$`).exec(path);
        if (!m || !handlers[method]) continue;
        const req = new Request(`http://keel${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const res: Response = await handlers[method](Object.assign(req, { params: { id: m[1] } }));
        return { status: res.status, body: await res.json() };
      }
      throw new Error(`no route ${method} ${path}`);
    };
    return { store, x: experiments!, o: outcomes!, call, calls };
  };
  return { dir, open, close: () => rmSync(dir, { recursive: true, force: true }) };
}

// A look after every family made so far has closed its guard window.
const closed = () => Date.now() + (WINDOW_MIN + 1) * 60_000;
let turnNo = 0;
// One ended turn of a session, as the turn rollup records it.
function turn(store: Store, sessionId: string, v: { cost?: number; outcome?: string; ts?: number; ms?: number; rating?: number } = {}) {
  const tag = armOf(store, sessionId);
  const id = `turn-${++turnNo}`;
  store.db.query("INSERT INTO telemetry_turns (session_id, turn_event, ts, ms, reason, outcome, requests, input, output, cost, exp_id, arm, rating) VALUES (?, ?, ?, ?, 'end_turn', ?, 1, 100, 10, ?, ?, ?, ?)")
    .run(sessionId, id, v.ts ?? Date.now(), v.ms ?? 0, v.outcome ?? "ok", v.cost ?? 0.01, tag?.exp_id ?? null, tag?.arm ?? null, v.rating ?? null);
  return id;
}
// A new top-level session that the experiment puts in `arm`, assigned.
function root(store: Store, x: Experiments, e: Experiment, arm: string) {
  for (;;) {
    const s = store.createSession({ model: "p:m", workspace: "/" });
    if (e.arms[assignArm(e.id, s.id, e.arms.map((a) => a.weight ?? 1))]!.name !== arm) continue;
    x.assign(s);
    return s.id;
  }
}
// A subagent session under `parent`, assigned at its first turn.
function child(store: Store, x: Experiments, parent: string) {
  const s = store.createSession({ model: "p:m", workspace: "/" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
  x.assign(store.session(s.id)!);
  return s.id;
}

test("a session family is one randomized sample, whatever its subagents ran", () => {
  const d = daemon();
  try {
    let { store, x } = d.open();
    const e = x.start(x.create({ template: "effort", name: "families", stop: { sessions_per_arm: 2 } }).id);
    // The low arm: one root with a subagent and that subagent's own subagent.
    const top = root(store, x, e, "low");
    const sub = child(store, x, top), subsub = child(store, x, sub);
    for (const s of [top, top, sub, subsub]) turn(store, s);
    for (let i = 0; i < 2; i++) turn(store, root(store, x, e, "default"));
    expect([armOf(store, sub), armOf(store, subsub)]).toEqual([{ exp_id: e.id, arm: "low", root: top }, { exp_id: e.id, arm: "low", root: top }]);

    const seen = () => {
      const r = x.report(x.get(e.id)!, closed());
      const low = r.arms.find((a) => a.arm === "low")!;
      return { turns: low.units, families: low.clusters, counted: x.sessions(e).find((s) => s.arm === "low")!.n, guard: r.guards.find((g) => g.arm === "low")!.n };
    };
    // Every turn contributes; the report, the guard and the count see one family.
    expect(seen()).toEqual({ turns: 4, families: 1, counted: 1, guard: [2, 1] });
    // The cap of two per arm is not met by one family of three sessions.
    x.check(subsub);
    expect(x.get(e.id)!.state).toBe("running");

    // A restart keeps the family; so does a store from before the key was kept.
    ({ store, x } = d.open());
    expect(seen()).toEqual({ turns: 4, families: 1, counted: 1, guard: [2, 1] });
    store.db.exec("UPDATE experiment_sessions SET root = NULL");
    ({ store, x } = d.open());
    expect(armOf(store, subsub)!.root).toBe(top);
    // Every assignment has its key after that, and a family's sessions are found by it.
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM experiment_sessions WHERE root IS NULL").get()!.n).toBe(0);
    expect(store.db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN SELECT session_id FROM experiment_sessions WHERE exp_id = ? AND root = ?").all(e.id, top).map((r) => r.detail).join(" ")).toContain("experiment_sessions_root");
    expect(seen()).toEqual({ turns: 4, families: 1, counted: 1, guard: [2, 1] });

    // A second family in the low arm meets the cap.
    const second = root(store, x, e, "low");
    turn(store, second);
    x.check(second);
    expect(x.get(e.id)).toMatchObject({ state: "stopped", stop_reason: "reached 2 session families per arm" });
  } finally { d.close(); }
});

// A turn through the engine's own events and the turn rollup. `held` leaves
// it open (started, not ended); `release` ends one.
function start(store: Store, sessionId: string) {
  return store.append(sessionId, "turn_start", { model: "p:m" }).id;
}
function release(store: Store, o: Outcomes, x: Experiments, sessionId: string, cost: number) {
  store.append(sessionId, "assistant", { blocks: [{ type: "text", text: "done" }], model: "p:m", usage: { input: 100, output: 10, cache_read: 0, cache_write: 0, cost }, stop: "end_turn" });
  const end = store.append(sessionId, "turn_end", { reason: "end_turn", ms: 1000, usage: { input: 100, output: 10, cache_read: 0, cache_write: 0, cost } });
  o.recordTurn(store.session(sessionId)!, "end_turn");
  x.check(sessionId);
  return end.id;
}

test("a stopped experiment's report is frozen with its decision", async () => {
  const d = daemon();
  try {
    let { store, x, o, call } = d.open();
    const made = (await call("POST", "/api/experiments", { template: "effort", name: "frozen", primary: "thumbs_down" })).body.experiment as Experiment;
    await call("POST", `/api/experiments/${made.id}/start`);
    const e = x.get(made.id)!;
    const ends: string[] = [];
    for (const arm of ["default", "low", "default", "low", "default", "low"]) {
      const s = root(store, x, e, arm);
      start(store, s);
      ends.push(release(store, o, x, s, arm === "low" ? 0.004 : 0.01));
    }
    // A turn that started before the stop and is still running at it.
    const late = root(store, x, e, "low");
    start(store, late);

    expect((await call("POST", `/api/experiments/${e.id}/stop`)).status).toBe(200);
    const read = async () => (await call("GET", `/api/experiments/${e.id}`)).body;
    const final = await read();
    expect(final.experiment).toMatchObject({ state: "stopped", decision: final.report.decision });
    // Stopped by the owner before the sample size it set: it ends without a winner, and says why.
    expect(final.report).toMatchObject({ judged: false, decision: { verdict: "inconclusive", winner: null, text: expect.stringContaining(`No winner: it stopped before the ${FAMILIES_PER_ARM} session families per arm it set (it had: default 3, low 3)`) } });
    expect(final.report.arms.map((a: any) => [a.arm, a.units, a.clusters])).toEqual([["default", 3, 3], ["low", 3, 3]]);
    expect(final.report.final_ms).toBe(final.experiment.stopped_ms);

    // The held turn ends, a subagent of an assigned session runs, and an earlier reply is rated down.
    release(store, o, x, late, 5);
    const sub = child(store, x, late);
    start(store, sub);
    release(store, o, x, sub, 5);
    expect((await call("POST", "/api/features/rating", { event_id: ends[1], value: -1 })).status).toBe(200);
    // The telemetry did change; the report did not.
    expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM telemetry_turns WHERE exp_id = ?").get(e.id)!.n).toBe(8);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_turns WHERE rating = -1").get()!.n).toBe(1);
    expect(await read()).toEqual(final);
    expect(await read()).toEqual(final);
    // The list shows the same counts.
    expect((await call("GET", "/api/experiments")).body.experiments.find((r: any) => r.id === e.id)).toEqual(final.experiment);

    // After a restart too.
    ({ store, x, o, call } = d.open());
    expect((await call("GET", `/api/experiments/${e.id}`)).body).toEqual(final);

    // An offline run uploaded after the stop is refused, not counted.
    const off = (await call("POST", "/api/experiments", { template: "readers", name: "late upload" })).body.experiment as Experiment;
    const run = { receipt: "late:1", arm: "readers on", task: "readlog", rep: 1, metrics: { cost_usd: 0.01, ok: 1 } };
    await call("POST", `/api/experiments/${off.id}/start`);
    expect((await call("POST", `/api/experiments/${off.id}/runs`, { runs: [run] })).status).toBe(201);
    await call("POST", `/api/experiments/${off.id}/stop`);
    const offFinal = (await call("GET", `/api/experiments/${off.id}`)).body;
    expect((await call("POST", `/api/experiments/${off.id}/runs`, { runs: [{ ...run, receipt: "late:2", rep: 2 }] })).status).toBe(409);
    expect((await call("GET", `/api/experiments/${off.id}`)).body).toEqual(offFinal);
    expect(offFinal.experiment.runs).toBe(1);
  } finally { d.close(); }
});

test("a family's guard observation is read once: after its first turns, or when its window closes", () => {
  const d = daemon();
  try {
    let { store, x } = d.open();
    // A session of an earlier experiment, stopped since.
    const before = x.start(x.create({ template: "effort", name: "earlier" }).id);
    const old = root(store, x, before, "low");
    turn(store, old);
    x.stop(before.id);

    const e = x.start(x.create({ template: "effort", name: "fixed" }).id);
    const families = ["default", "low", "default", "low", "default", "low"].map((arm) => root(store, x, e, arm));
    families.forEach((s, i) => turn(store, s, { outcome: i === 1 ? "error" : "ok" }));
    const error = (r: ReturnType<Experiments["report"]>) => r.guards.find((g) => g.metric === "error")!;

    // One turn each, inside the window: nothing is read, the families are open.
    const early = x.report(e);
    expect(early.guard).toMatchObject({ evidence: 1, threshold: 20, tests: 2, window_min: WINDOW_MIN, turns: TURNS, fixed: 0, pending: 6 });
    expect(error(early).n).toEqual([0, 0]);

    // A family's second turn ends (a subagent's counts): it is read, over those two turns, and a third changes nothing.
    turn(store, child(store, x, families[1]!), { outcome: "ok" });
    x.check(families[1]!);
    const one = x.report(e);
    expect(one.guard).toMatchObject({ fixed: 1, pending: 5 });
    expect(error(one).n).toEqual([0, 1]);
    turn(store, families[1]!, { outcome: "error" });
    expect([x.report(e).guards, x.report(e).guard]).toEqual([one.guards, one.guard]);

    // The window closes for the rest, at a turn of a session that is in no arm of this experiment.
    const at = closed();
    x.check(old, at);
    const read = x.report(e, at);
    expect(read.guard).toMatchObject({ fixed: 6, pending: 0 });
    expect(error(read)).toMatchObject({ n: [3, 3], diff: 1 / 6 }); // the low arm: 1 of 2 turns, 0 and 0

    // Later turns count in the report and change no guard, after a restart too.
    for (const s of families) turn(store, s, { outcome: "error" });
    const later = x.report(e, at + 60_000);
    expect(later.arms.map((a) => a.units)).toEqual([6, 8]);
    expect([later.guards, later.guard]).toEqual([read.guards, read.guard]);
    ({ store, x } = d.open());
    const again = x.report(x.get(e.id)!, at + 120_000);
    expect([again.guards, again.guard]).toEqual([read.guards, read.guard]);
    expect(x.get(e.id)!.state).toBe("running");
  } finally { d.close(); }
});

test("an arm that breaks every turn is stopped inside the window, and no winner is named before the sample size", () => {
  const d = daemon();
  try {
    const { store, x } = d.open();
    const e = x.start(x.create({ template: "effort", name: "broken" }).id);
    expect(e.stop.sessions_per_arm).toBe(FAMILIES_PER_ARM);
    // Families as they come: two turns each, the low arm's all ending in an error.
    let families = 0;
    while (x.get(e.id)!.state === "running" && families < 40) {
      const arm = families++ % 2 ? "low" : "default";
      const s = root(store, x, e, arm);
      for (let i = 0; i < TURNS; i++) { turn(store, s, { outcome: arm === "low" ? "error" : "ok", cost: arm === "low" ? 0.001 : 0.01 }); x.check(s); }
      // The low arm is far cheaper on the primary metric, and no winner is named: the sample size is not there.
      if (families === 8) expect(x.report(x.get(e.id)!)).toMatchObject({ judged: false, decision: { verdict: "inconclusive", winner: null, text: expect.stringContaining(`when every arm has ${FAMILIES_PER_ARM} session families (now: default 4, low 4)`) } });
    }
    const stopped = x.get(e.id)!;
    expect(stopped).toMatchObject({ state: "stopped", stop_reason: "guard: low made ended in an error worse", decision: { verdict: "regression", winner: "default" } });
    expect(stopped.stopped_ms! - stopped.started_ms!).toBeLessThan(60_000); // no window closed: every family was read after its second turn
    const final = x.report(stopped);
    expect(final.guard!.evidence).toBeGreaterThanOrEqual(20);
    expect(final.guards.filter((g) => g.worse).map((g) => g.metric)).toEqual(["error"]);
    expect(families).toBeLessThanOrEqual(16);
    console.log(`broken arm: stopped after ${families} families of ${TURNS} turns`);
  } finally { d.close(); }
});

// The stop rule over a declared look schedule: a look after every fixed
// family, from the first to the last (no schedule looks more often).
// Families come ten minutes apart with one to eight turns over hours; each
// is read as the daemon reads it (familyObs: its first turns, or its window)
// and enters in the order it was fixed. A family that had an error is
// likelier to end early, so what a family did decides when it is read.
// Seeded, so every run draws the same experiments.
test("live guards keep the false-stop bound over every look and find a sustained regression", () => {
  const ALPHA = 0.05, MIN = 60_000, WINDOW = WINDOW_MIN * MIN;
  const r = rng(20261121);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const pareto = (a: number) => Math.pow(1 - r(), -1 / a); // a heavy tail, no variance below 2
  const armBy = (e: Experiment) => {
    let u = r() * e.arms.reduce((n, a) => n + (a.weight ?? 1), 0);
    for (const a of e.arms) { if (u < (a.weight ?? 1)) return a.name; u -= a.weight ?? 1; }
    return e.arms.at(-1)!.name;
  };
  type Make = (arm: string, family: number, of: number) => FamilyTurn["m"];
  // One experiment: the look (1-based) at which it stopped and the test named, or null.
  const run = (e: Experiment, families: number, make: Make) => {
    const fixed: { at: number; i: number; obs: Obs }[] = [];
    for (let i = 0; i < families; i++) {
      const arm = armBy(e), assigned = i * 10 * MIN, turns: FamilyTurn[] = [];
      for (let t = 0, end = assigned, max = 1 + Math.floor(r() * 8); t < max; t++) {
        end += r() * 6 * 60 * MIN;
        const m = make(arm, i, families);
        turns.push({ end, m });
        if (m.error && r() < 0.5) break;
      }
      const o = familyObs(turns, assigned, Infinity, TURNS, WINDOW);
      if (o?.turns) fixed.push({ at: o.at, i, obs: { arm, m: o.m } });
    }
    const obs = fixed.sort((a, b) => a.at - b.at || a.i - b.i).map((f) => f.obs);
    let at: number | null = null;
    liveGuards(e, obs, (seen, evidence) => { if (at === null && evidence >= 1 / ALPHA) at = seen; });
    return at === null ? null : { at, named: liveGuards(e, obs.slice(0, at)).guards.find((g) => g.worse)! };
  };
  const bound = (n: number) => ALPHA + 3 * Math.sqrt((ALPHA * (1 - ALPHA)) / n); // alpha plus three standard errors of the estimate
  const count = (n: number, f: () => unknown) => { let k = 0; for (let i = 0; i < n; i++) if (f()) k++; return k; };

  // Three arms, the control at twice the weight, a skewed cost guard and an error guard.
  const e = { arms: [{ name: "control", weight: 2 }, { name: "a" }, { name: "b" }], guards: [{ metric: "cost_usd", mde: 0.25, relative: true }, { metric: "error", mde: 0.1 }], stop: { alpha: ALPHA } } as Experiment;
  const turnOf = (errorIn: (arm: string) => number): Make => (arm) => ({ cost_usd: 0.01 * Math.exp(0.6 + 0.8 * normal()), error: r() < errorIn(arm) ? 1 : 0 });
  const FAMILIES = 300, NULLS = 2000;
  const falseStops = count(NULLS, () => run(e, FAMILIES, turnOf(() => 0.08)));
  expect(falseStops / NULLS).toBeLessThanOrEqual(bound(NULLS));

  // Weights far from equal (1 : 5 : 0.3), four guards: a cost with no variance that a fifth of the turns lack,
  // rare errors, a duration that drifts up over the experiment, and a cache share (higher is better).
  const skew = { arms: [{ name: "control", weight: 1 }, { name: "a", weight: 5 }, { name: "b", weight: 0.3 }], stop: { alpha: ALPHA },
    guards: [{ metric: "cost_usd", mde: 0.25, relative: true }, { metric: "error", mde: 0.1 }, { metric: "ms", mde: 0.5, relative: true }, { metric: "cache_read_share", mde: 0.1 }] } as Experiment;
  const SKEW_FAMILIES = 400, SKEW_NULLS = 1000;
  const skewStops = count(SKEW_NULLS, () => run(skew, SKEW_FAMILIES, (_arm, i, of) => ({
    ...(r() > 0.2 ? { cost_usd: 0.01 * (1 + (3 * i) / of) * pareto(1.2) } : {}), error: r() < 0.03 ? 1 : 0,
    ms: 1000 * (1 + (3 * i) / of) * Math.exp(2 * normal()), cache_read_share: r() < 0.3 ? 0 : r(),
  })));
  expect(skewStops / SKEW_NULLS).toBeLessThanOrEqual(bound(SKEW_NULLS));

  // Arm a ends 35% of its turns in an error against 8%: found in at least 95% of experiments, and named.
  const PLANTED = 400;
  const found = Array.from({ length: PLANTED }, () => run(e, FAMILIES, turnOf((arm) => (arm === "a" ? 0.35 : 0.08)))).filter((x) => x !== null);
  expect(found.length / PLANTED).toBeGreaterThanOrEqual(0.95);
  expect(found.filter((x) => x.named.arm === "a" && x.named.metric === "error").length / found.length).toBeGreaterThanOrEqual(0.95);
  const median = found.map((x) => x.at).sort((a, b) => a - b)[found.length >> 1];
  console.log(`live guards, a look after every family: null ${falseStops}/${NULLS} stopped (bound ${bound(NULLS).toFixed(4)}); null with weights 1:5:0.3 and four guards ${skewStops}/${SKEW_NULLS} (bound ${bound(SKEW_NULLS).toFixed(4)}); errors 35% against 8% found in ${found.length}/${PLANTED}, median look ${median} of ${FAMILIES}`);
});

test("an offline run uploaded twice is one observation; another payload under its receipt is refused", async () => {
  const d = daemon();
  try {
    const { x, call } = d.open();
    const e = (await call("POST", "/api/experiments", { template: "readers", name: "receipts" })).body.experiment as Experiment;
    await call("POST", `/api/experiments/${e.id}/start`);
    const path = `/api/experiments/${e.id}/runs`;
    const a = { receipt: "run-a", arm: "readers on", task: "readlog", rep: 1, metrics: { cost_usd: 0.004, ok: 1 } };
    const b = { receipt: "run-b", arm: "readers off", task: "readlog", rep: 1, metrics: { cost_usd: 0.006, ok: 1 } };
    const runs = async () => (await call("GET", `/api/experiments/${e.id}`)).body;

    expect(await call("POST", path, { runs: [a] })).toEqual({ status: 201, body: { added: 1, duplicates: 0 } });
    // The answer was lost: the runner sends it again, with the next run and the keys in another order.
    expect(await call("POST", path, { runs: [{ ...a, metrics: { ok: 1, cost_usd: 0.004 } }, b] })).toEqual({ status: 201, body: { added: 1, duplicates: 1 } });
    expect(await call("POST", path, { runs: [a, b] })).toEqual({ status: 200, body: { added: 0, duplicates: 2 } });
    expect((await runs()).experiment.runs).toBe(2);
    expect((await runs()).report.arms.map((r: any) => r.units)).toEqual([1, 1]);

    // The same receipt with another payload: refused, and nothing of its batch is kept.
    const c = { receipt: "run-c", arm: "readers on", task: "readspec", rep: 1, metrics: { cost_usd: 0.005, ok: 1 } };
    const clash = await call("POST", path, { runs: [c, { ...a, metrics: { cost_usd: 0.001, ok: 1 } }] });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toContain("run-a");
    expect((await runs()).experiment.runs).toBe(2);
    // A run without a receipt, or with a metric that is not a number, is not an observation.
    expect((await call("POST", path, { runs: [{ arm: "readers on", metrics: { ok: 1 } }] })).status).toBe(400);
    expect((await call("POST", path, { runs: [{ ...c, metrics: { cost_usd: null, ok: 1 } }] })).status).toBe(400);

    // After the stop the experiment still acknowledges what it has.
    await call("POST", `/api/experiments/${e.id}/stop`);
    expect(await call("POST", path, { runs: [a, b] })).toEqual({ status: 200, body: { added: 0, duplicates: 2 } });
    expect((await call("POST", path, { runs: [a, c] })).status).toBe(409);
    expect(x.runs(x.get(e.id)!)).toBe(2);
  } finally { d.close(); }
});

test("the offline runner recovers a lost upload from its receipt file and stops the experiment only when every run is acknowledged", async () => {
  const d = daemon();
  try {
    const { x, call } = d.open();
    const e = (await call("POST", "/api/experiments", { template: "readers", name: "recover" })).body.experiment as Experiment;
    await call("POST", `/api/experiments/${e.id}/start`);
    // The runner's connection to the daemon: up, down, or the request arrives and its answer is lost.
    let net: "up" | "down" | "lost" = "up";
    const fetch = async (url: string, init?: RequestInit) => {
      if (net === "down") throw new Error("connection refused");
      const r = await call(init?.method ?? "GET", new URL(url).pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (net === "lost") throw new Error("socket closed before the answer");
      return Response.json(r.body, { status: r.status });
    };
    const file = join(d.dir, "receipts", "recover.json");
    const up = Uploads.start(file, { daemon: "http://keel", experiment: e.id, label: "recover" }, fetch);
    const run = (n: number, arm: string) => ({ receipt: `recover:readlog:${n}:${arm}`, arm, task: "readlog", rep: n, metrics: { cost_usd: arm === "readers on" ? 0.004 : 0.006, ok: 1 } });
    const state = () => ({ state: x.get(e.id)!.state, runs: x.runs(x.get(e.id)!) });

    // The first upload arrives and its answer is lost: the run is not acknowledged, the daemon has it once.
    net = "lost";
    up.add(run(1, "readers on"));
    expect(await up.flush()).toBe(false);
    expect([up.pending.length, state()]).toEqual([1, { state: "running", runs: 1 }]);
    // The daemon goes down for the next run; the run ends: the experiment is not stopped.
    net = "down";
    up.add(run(1, "readers off"));
    expect(await up.flush()).toBe(false);
    expect(await up.finalize("the offline run finished")).toMatchObject({ finalized: false, pending: 2 });
    expect(state()).toEqual({ state: "running", runs: 1 });

    // Later, from the receipt file alone: both runs are sent, the daemon counts each once, and it stops.
    net = "up";
    const again = Uploads.open(file, fetch);
    expect(again.pending.map((r) => r.receipt)).toEqual(["recover:readlog:1:readers on", "recover:readlog:1:readers off"]);
    expect(await again.finalize("the offline run finished")).toEqual({ finalized: true, pending: 0, problem: "" });
    expect(state()).toEqual({ state: "stopped", runs: 2 });
    expect(x.get(e.id)!.stop_reason).toBe("the offline run finished");
    // Resuming once more changes nothing.
    expect(await Uploads.open(file, fetch).finalize("the offline run finished")).toMatchObject({ finalized: true });
    expect(state()).toEqual({ state: "stopped", runs: 2 });

    // A payload the daemon refuses (its receipt is taken by another payload) blocks the stop too.
    const e2 = (await call("POST", "/api/experiments", { template: "readers", name: "clash" })).body.experiment as Experiment;
    await call("POST", `/api/experiments/${e2.id}/start`);
    await call("POST", `/api/experiments/${e2.id}/runs`, { runs: [{ ...run(1, "readers on"), metrics: { cost_usd: 1, ok: 0 } }] });
    const clash = Uploads.start(join(d.dir, "receipts", "clash.json"), { daemon: "http://keel", experiment: e2.id, label: "clash" }, fetch);
    clash.add(run(1, "readers on"));
    const refused = await clash.finalize("the offline run finished");
    expect(refused).toMatchObject({ finalized: false, pending: 1 });
    expect(refused.problem).toContain("409");
    expect(x.get(e2.id)!.state).toBe("running");
  } finally { d.close(); }
});

test("an offline run's metrics share one scope, and the runner's report is the daemon's", async () => {
  const d = daemon();
  try {
    const { store, o, call, calls } = d.open();
    // A run's turn: the first attempt fails, its retry is answered, a reader model reads, and a title is made on the side.
    const turnOf = (reader: Record<string, unknown>) => {
      const s = store.createSession({ model: "p:main", workspace: "/" });
      const sess = () => store.session(s.id)!;
      const request = (purpose: string, route: string) => ({ model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal, purpose, route }) as any;
      const answer = (req: any, usage: Record<string, unknown>) => { calls.requestSent!(sess(), req); calls.requestDone!(sess(), req, { blocks: [], stop: "end_turn", usage } as any); };
      store.append(s.id, "user", { text: "the task" });
      store.append(s.id, "turn_start", { model: "p:main" });
      const step = request("turn", "p:main");
      calls.requestSent!(sess(), step);
      calls.requestFailed!(sess(), step, Object.assign(new Error("overloaded"), { status: 529 }), false);
      answer(step, { input: 100, cache_read: 300, cache_write: 50, output: 20, cost: 0.002 });
      answer(request("reader", "p:small"), { input: 1000, cache_read: 0, cache_write: 0, output: 40, ...reader });
      answer(request("side", "p:small"), { input: 30, cache_read: 0, cache_write: 0, output: 5, cost: 0.0001 });
      store.append(s.id, "assistant", { blocks: [{ type: "text", text: "done" }], model: "p:main", usage: {}, stop: "end_turn" });
      store.append(s.id, "turn_end", { reason: "end_turn", ms: 4000, usage: {} });
      o.recordTurn(sess(), "end_turn");
      return o.sessionTurns(s.id)[0];
    };

    // Three requests (the failed attempt, its retry, the reader); tokens, cost and cache share over the two answered; the side request in none.
    const priced = runMetrics(turnOf({ cost: 0.0005 }), { ok: true, ms: 4321 });
    expect(priced).toEqual({ requests: 3, prompt_tokens: 1450, output_tokens: 60, cost_usd: 0.0025, cache_read_share: 300 / 1450, ms: 4321, ok: 1, error: 0, tool_errors: 0 });
    // The reader has no price: the run's cost is not known, so it has none (not the working model's part, not zero).
    const unpriced = runMetrics(turnOf({ unpriced: true }), { ok: false, ms: 5000 });
    expect("cost_usd" in unpriced).toBe(false);
    expect(unpriced).toMatchObject({ requests: 3, prompt_tokens: 1450, cache_read_share: 300 / 1450, ok: 0 });
    // A run whose turn left no rollup reports what the runner saw, nothing made up.
    expect(runMetrics(undefined, { ok: false, ms: 9 })).toEqual({ ok: 0, ms: 9 });

    // The runner's report and the daemon's, from the same runs.
    const e = (await call("POST", "/api/experiments", { template: "readers", name: "scopes" })).body.experiment as Experiment;
    await call("POST", `/api/experiments/${e.id}/start`);
    const runs = [1, 2, 3].flatMap((rep) => [
      { receipt: `on-${rep}`, arm: "readers on", task: "readlog", rep, metrics: rep === 2 ? unpriced : { ...priced, cost_usd: 0.0025 + rep * 0.0001 } },
      { receipt: `off-${rep}`, arm: "readers off", task: "readlog", rep, metrics: { ...unpriced, ok: 1 } },
    ]);
    expect((await call("POST", `/api/experiments/${e.id}/runs`, { runs })).status).toBe(201);
    const theirs = (await call("GET", `/api/experiments/${e.id}`)).body.report;
    const ours = JSON.parse(JSON.stringify(offlineReport(e, runs)));
    expect([theirs.arms, theirs.effects, theirs.guards]).toEqual([ours.arms, ours.effects, ours.guards]);
    // The cost is over the two priced runs of the first arm; the second arm has none, and no effect is claimed.
    expect(theirs.arms[0].metrics.cost_usd).toMatchObject({ n: 2, estimate: 0.0027 });
    expect(theirs.arms[0].metrics.requests).toMatchObject({ n: 3, estimate: 3 });
    expect(theirs.arms[1].metrics.cost_usd).toBeUndefined();
    expect(theirs.effects.some((f: any) => f.metric === "cost_usd")).toBe(false);
  } finally { d.close(); }
});

test("a guard's alpha is a probability, and the report carries the threshold it gives", async () => {
  const d = daemon();
  try {
    const { x, call } = d.open();
    const make = (stop: unknown, template = "effort") => call("POST", "/api/experiments", { template, name: "alpha", stop });
    for (const alpha of [0, 1, 1.5, -0.05, "0.05", null, Number.NaN]) expect([alpha, (await make({ alpha })).status]).toEqual([alpha, 400]);
    const usual = (await make({})).body.experiment as Experiment;
    expect((await call("PATCH", `/api/experiments/${usual.id}`, { stop: { alpha: 2 } })).status).toBe(400);
    const strict = (await make({ alpha: 0.01 })).body.experiment as Experiment;
    const offline = (await make({ alpha: 0.02, reps: 3 }, "readers")).body.experiment as Experiment;
    const threshold = (e: Experiment) => { const r = x.report(x.get(e.id)!); return [r.threshold, r.guard?.threshold]; };
    expect([threshold(usual), threshold(strict), threshold(offline)]).toEqual([[20, 20], [100, 100], [50, undefined]]);
  } finally { d.close(); }
});

test("the sessions per arm cap is over the arms that get sessions; a live control is one of them", async () => {
  const d = daemon();
  try {
    const { store, x, call } = d.open();
    const arms = [{ name: "current" }, { name: "variant", settings: { effort: "low" } }, { name: "shelved", weight: 0, settings: { effort: "high" } }];
    const e = x.start(x.create({ template: "effort", name: "cap", arms, stop: { sessions_per_arm: 2 } }).id);
    for (const arm of ["current", "variant", "current"]) turn(store, root(store, x, e, arm));
    const last = root(store, x, e, "variant");
    x.check(last);
    expect(x.get(e.id)!.state).toBe("running"); // the variant has one family with a turn
    turn(store, last);
    x.check(last);
    expect(x.get(e.id)).toMatchObject({ state: "stopped", stop_reason: "reached 2 session families per arm" });
    // The shelved arm got nothing and is tested against nothing.
    const r = x.report(x.get(e.id)!);
    expect(r.arms.map((a) => [a.arm, a.clusters])).toEqual([["current", 2], ["variant", 2], ["shelved", 0]]);
    expect(r.guards.map((g) => g.arm)).toEqual(["variant", "variant"]);

    // A control with weight 0 would leave nothing to compare with: refused live, fine offline (weights split sessions only).
    const off = [{ name: "current", weight: 0 }, { name: "variant" }];
    const refused = await call("POST", "/api/experiments", { template: "effort", name: "no control", arms: off });
    expect([refused.status, refused.body.error]).toEqual([400, expect.stringContaining("control")]);
    expect((await call("POST", "/api/experiments", { template: "readers", name: "offline weights", arms: off })).status).toBe(201);
  } finally { d.close(); }
});

test("the control wins only when every arm compared with it lost", () => {
  const e = { mode: "offline", primary: "cost_usd", guards: [], stop: {}, arms: [{ name: "current" }, { name: "dear", tools_off: ["run_code"] }, { name: "other", settings: { effort: "low" } }] } as unknown as Experiment;
  // Nine runs of an arm at about `cost`, three per task.
  const runs = (arm: string, cost: number) => Array.from({ length: 9 }, (_, i) => ({ arm, cluster: `${arm}-${i}`, stratum: `task-${i % 3}`, m: { cost_usd: cost + (i % 3) * 0.001 + Math.floor(i / 3) * 0.0002 } }));
  const decide = (...rows: ReturnType<typeof runs>[]) => report(e, rows.flat()).decision;

  // One clear loser, the other arm not measured: no winner.
  const unmeasured = decide(runs("current", 0.01), runs("dear", 0.02));
  expect(unmeasured).toMatchObject({ verdict: "inconclusive", winner: null });
  expect(unmeasured.text).toContain("dear is worse by");
  expect(unmeasured.text).toContain("other is not measured yet");
  expect(unmeasured.remove).toContain("Arm dear (without run_code) can be dropped");
  // One clear loser, the other arm not told apart from the control: no winner.
  const same = decide(runs("current", 0.01), runs("dear", 0.02), runs("other", 0.01));
  expect(same).toMatchObject({ verdict: "inconclusive", winner: null });
  expect(same.text).toContain("other does not differ beyond chance");
  // Both arms decisively worse: the control wins, and both go.
  const both = decide(runs("current", 0.01), runs("dear", 0.02), runs("other", 0.03));
  expect(both).toMatchObject({ verdict: "won", winner: "current" });
  expect(both.remove).toContain("Drop arms dear (without run_code), other (effort \"low\")");
  // An arm that is better still wins over a loser.
  expect(decide(runs("current", 0.01), runs("dear", 0.02), runs("other", 0.005))).toMatchObject({ verdict: "won", winner: "other" });
  // Live: an arm with weight 0 is not compared, so the one enabled loser is every arm.
  const live = { ...e, mode: "live", stop: { sessions_per_arm: 9 }, arms: [e.arms[0]!, e.arms[1]!, { ...e.arms[2]!, weight: 0 }] } as Experiment;
  expect(report(live, [...runs("current", 0.01), ...runs("dear", 0.02)]).decision).toMatchObject({ verdict: "won", winner: "current" });
});

test("an experiment stopped before reports were kept is frozen without guards it never read", () => {
  const d = daemon();
  try {
    let { store, x } = d.open();
    const e = x.start(x.create({ template: "effort", name: "legacy" }).id);
    const families = ["default", "low", "default", "low"].map((arm) => root(store, x, e, arm));
    for (const s of families) turn(store, s, { ms: 0 });
    const stopped = x.stop(e.id);
    // As an older build left it: the decision with the experiment, no report and no observations kept.
    store.db.exec("DELETE FROM experiment_reports; DELETE FROM experiment_obs");
    // A turn that started before the stop and ended after it.
    turn(store, families[1]!, { ts: stopped.stopped_ms!, ms: 60_000, outcome: "error" });

    const r = x.report(x.get(e.id)!);
    expect(r.decision).toEqual(stopped.decision!);
    expect(r.final_ms).toBe(stopped.stopped_ms);
    expect(r.arms.map((a) => [a.arm, a.units])).toEqual([["default", 2], ["low", 2]]);
    // No guard evidence is shown: what the guards read at the stop was not kept.
    expect([r.guards, r.guard]).toEqual([[], undefined]);
    ({ store, x } = d.open());
    expect(x.report(x.get(e.id)!)).toEqual(r);
  } finally { d.close(); }
});
