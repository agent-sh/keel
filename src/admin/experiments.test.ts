// Experiment evidence over a real store, on cases the page cannot script:
// subagent families, a daemon restart, turns that end after a stop.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { experimentRoutes, experiments, outcomes } from "../server/routes/experiments.ts";
import { armOf, Experiments, liveGuards, WINDOW_MIN, type Experiment, type Obs } from "./experiments.ts";
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
    return { store, x: experiments!, o: outcomes!, call };
  };
  return { open, close: () => rmSync(dir, { recursive: true, force: true }) };
}

// A look after every family made so far has closed its guard window.
const closed = () => Date.now() + (WINDOW_MIN + 1) * 60_000;
let turnNo = 0;
// One ended turn of a session, as the turn rollup records it.
function turn(store: Store, sessionId: string, v: { cost?: number; outcome?: string; ts?: number; rating?: number } = {}) {
  const tag = armOf(store, sessionId);
  const id = `turn-${++turnNo}`;
  store.db.query("INSERT INTO telemetry_turns (session_id, turn_event, ts, ms, reason, outcome, requests, input, output, cost, exp_id, arm, rating) VALUES (?, ?, ?, 1000, 'end_turn', ?, 1, 100, 10, ?, ?, ?, ?)")
    .run(sessionId, id, v.ts ?? Date.now(), v.outcome ?? "ok", v.cost ?? 0.01, tag?.exp_id ?? null, tag?.arm ?? null, v.rating ?? null);
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
    expect(seen()).toEqual({ turns: 4, families: 1, counted: 1, guard: [2, 1] });

    // A second family in the low arm meets the cap.
    const second = root(store, x, e, "low");
    turn(store, second);
    x.check(second);
    expect(x.get(e.id)).toMatchObject({ state: "stopped", stop_reason: "reached 2 sessions per arm" });
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
    const run = { arm: "readers on", task: "readlog", rep: 1, metrics: { cost_usd: 0.01, ok: 1 } };
    await call("POST", `/api/experiments/${off.id}/start`);
    expect((await call("POST", `/api/experiments/${off.id}/runs`, { runs: [run] })).status).toBe(201);
    await call("POST", `/api/experiments/${off.id}/stop`);
    const offFinal = (await call("GET", `/api/experiments/${off.id}`)).body;
    expect((await call("POST", `/api/experiments/${off.id}/runs`, { runs: [{ ...run, rep: 2 }] })).status).toBe(409);
    expect((await call("GET", `/api/experiments/${off.id}`)).body).toEqual(offFinal);
    expect(offFinal.experiment.runs).toBe(1);
  } finally { d.close(); }
});

test("a family's guard observation is read once, when its window closes, and a regression stops the experiment", () => {
  const d = daemon();
  try {
    let { store, x } = d.open();
    const e = x.start(x.create({ template: "effort", name: "fixed" }).id);
    const families = ["default", "low", "default", "low", "default", "low"].map((arm) => root(store, x, e, arm));
    families.forEach((s, i) => turn(store, s, { outcome: i === 1 ? "error" : "ok" }));
    const error = (r: ReturnType<Experiments["report"]>) => r.guards.find((g) => g.metric === "error")!;

    // Inside the window nothing is read: the families wait.
    const early = x.report(e);
    expect(early.guard).toMatchObject({ evidence: 1, threshold: 20, tests: 2, window_min: WINDOW_MIN, fixed: 0, pending: 6 });
    expect(error(early).n).toEqual([0, 0]);

    // The window closes: one observation per family, in the order they were assigned.
    const at = closed();
    x.check(families[0]!, at);
    const read = x.report(e, at);
    expect(read.guard).toMatchObject({ fixed: 6, pending: 0 });
    expect(error(read)).toMatchObject({ n: [3, 3], diff: 1 / 3 });

    // Later turns and a subagent's turns count in the report and change no guard.
    for (const s of families) turn(store, s, { outcome: "error" });
    turn(store, child(store, x, families[0]!), { outcome: "error" });
    const later = x.report(e, at + 60_000);
    expect(later.arms.map((a) => a.units)).toEqual([7, 6]);
    expect([later.guards, later.guard]).toEqual([read.guards, read.guard]);
    ({ store, x } = d.open());
    const again = x.report(x.get(e.id)!, at + 120_000);
    expect([again.guards, again.guard]).toEqual([read.guards, read.guard]);
    expect(x.get(e.id)!.state).toBe("running");

    // A sustained regression: every new low family ends in errors, no default one does.
    let made = 0;
    while (x.get(e.id)!.state === "running" && made < 60) {
      for (const arm of ["default", "low"]) turn(store, root(store, x, e, arm), { outcome: arm === "low" ? "error" : "ok" });
      made += 2;
      x.check(families[0]!, closed());
    }
    const stopped = x.get(e.id)!;
    expect(stopped).toMatchObject({ state: "stopped", stop_reason: "guard: low made ended in an error worse", decision: { verdict: "regression", winner: "default" } });
    const final = x.report(stopped);
    expect(final.guard!.evidence).toBeGreaterThanOrEqual(20);
    expect(final.guards.filter((g) => g.worse).map((g) => g.metric)).toEqual(["error"]);
    expect(made).toBeLessThanOrEqual(16);
  } finally { d.close(); }
});

// The stop rule over a declared look schedule: a look after every fixed
// family, from the first to the last (no schedule looks more often).
// Seeded, so every run draws the same experiments.
test("live guards keep the false-stop bound over every look and find a sustained regression", () => {
  const ALPHA = 0.05, FAMILIES = 300;
  const e = { arms: [{ name: "control", weight: 2 }, { name: "a" }, { name: "b" }], guards: [{ metric: "cost_usd", mde: 0.25, relative: true }, { metric: "error", mde: 0.1 }], stop: { alpha: ALPHA } } as Experiment;
  const r = rng(20261121);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  // A family: its arm by the weights, one to eight turns, skewed costs around its own level, some turns ending in an error.
  const family = (errorIn: (arm: string) => number): Obs => {
    const u = r() * 4, arm = u < 2 ? "control" : u < 3 ? "a" : "b";
    const turns = 1 + Math.floor(r() * 8), level = Math.exp(0.6 * normal());
    return { arm, m: {
      cost_usd: mean(Array.from({ length: turns }, () => 0.01 * level * Math.exp(0.8 * normal()))),
      error: mean(Array.from({ length: turns }, () => (r() < errorIn(arm) ? 1 : 0))),
    } };
  };
  // Runs one experiment; the look (1-based) at which it stopped, with the test named, or null.
  const run = (errorIn: (arm: string) => number) => {
    const obs = Array.from({ length: FAMILIES }, () => family(errorIn));
    let at: number | null = null;
    liveGuards(e, obs, (seen, evidence) => { if (at === null && evidence >= 1 / ALPHA) at = seen; });
    return at === null ? null : { at, named: liveGuards(e, obs.slice(0, at)).guards.find((g) => g.worse)! };
  };

  // No arm differs: stopped experiments stay within alpha, plus three standard errors of the estimate.
  const NULLS = 2000, tolerance = 3 * Math.sqrt((ALPHA * (1 - ALPHA)) / NULLS);
  let falseStops = 0;
  for (let i = 0; i < NULLS; i++) if (run(() => 0.08)) falseStops++;
  expect(falseStops / NULLS).toBeLessThanOrEqual(ALPHA + tolerance);

  // Arm a ends 35% of its turns in an error against 8%: found in at least 95% of experiments, and named.
  const PLANTED = 400;
  const found = Array.from({ length: PLANTED }, () => run((arm) => (arm === "a" ? 0.35 : 0.08))).filter((x) => x !== null);
  expect(found.length / PLANTED).toBeGreaterThanOrEqual(0.95);
  expect(found.filter((x) => x.named.arm === "a" && x.named.metric === "error").length / found.length).toBeGreaterThanOrEqual(0.95);
  console.log(`live guards: ${falseStops}/${NULLS} null experiments stopped (bound ${ALPHA} + ${tolerance.toFixed(4)}); planted regression found in ${found.length}/${PLANTED}, median look ${found.map((x) => x.at).sort((a, b) => a - b)[found.length >> 1]} of ${FAMILIES}`);
});
