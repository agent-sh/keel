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
import { armOf, Experiments, type Experiment } from "./experiments.ts";
import type { Outcomes } from "./outcomes.ts";
import { assignArm } from "./stats.ts";
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
      const low = x.report(x.get(e.id)!).arms.find((a) => a.arm === "low")!;
      return { turns: low.units, families: low.clusters, counted: x.sessions(e).find((s) => s.arm === "low")!.n, guard: x.report(x.get(e.id)!).guards.find((g) => g.arm === "low")!.n };
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
