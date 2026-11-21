// Experiment evidence over a real store, on cases the page cannot script:
// subagent families, a daemon restart, turns that end after a stop.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { armOf, Experiments, type Experiment } from "./experiments.ts";
import { Outcomes } from "./outcomes.ts";
import { assignArm } from "./stats.ts";
import { Telemetry } from "./telemetry.ts";

// A daemon's experiment wiring over a state folder; `open` again is a restart.
function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "keel-experiments-"));
  const open = () => {
    const store = new Store(dir);
    // Subagent sessions name their parent (the agents module's column).
    if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
    new Telemetry(store, new Bus());
    const x = new Experiments(store);
    return { store, x, o: new Outcomes(store, x) };
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
