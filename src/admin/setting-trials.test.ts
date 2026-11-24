// Trials of a setting: the assignment of new agent trees, the rule that ends a trial, and what keeping
// one does, over a real store and the experiments' own routes.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { cachePlanOn, compactLimit, windowShare } from "../engine/agent-defaults.ts";
import { COMPACT_SHARE } from "../engine/compact.ts";
import { experimentRoutes, experiments } from "../server/routes/experiments.ts";
import { settingTrialRoutes } from "../server/routes/setting-trials.ts";
import { armOf, FAMILIES_PER_ARM } from "./experiments.ts";
import { patchSettings, settings } from "./settings.ts";
import { MAX_DAYS, MIN_DAYS, plan, SETTING_TRIAL_KIND, settingTrial, treesPerDay, trialExperiment } from "./setting-trials.ts";
import { Telemetry } from "./telemetry.ts";
import { cohort, SETTLE_MS, treeFigures } from "./tree-figures.ts";

setDefaultTimeout(30_000);
const DAY = 86_400_000;
const HOUR = 3_600_000;

test("the sample and the time of a trial follow the rate new agent trees start at", () => {
  // The starting sample (FAMILIES_PER_ARM) is kept while two days of trees are fewer; above it, two days of trees.
  expect(plan(50)).toMatchObject({ per_arm: FAMILIES_PER_ARM, expected_days: 2.6, until_days: 6, startable: true });
  expect(plan(200)).toMatchObject({ per_arm: 200, expected_days: MIN_DAYS, until_days: 4, startable: true });
  // Its time is twice the days the sample is expected to take, and never over the longest a trial runs.
  expect(plan(15)).toMatchObject({ per_arm: FAMILIES_PER_ARM, expected_days: 8.5, until_days: MAX_DAYS, startable: true });
  // Too few new trees: a sample would take longer than a trial may run, and the card says so.
  const slow = plan(5);
  expect(slow.startable).toBe(false);
  expect(slow.why).toContain(`${MAX_DAYS} days at most`);
  expect(plan(0).startable).toBe(false);
  // The rate: the trees of the last week over the days recorded, a day at the least.
  const now = 100 * DAY;
  const started = [...Array.from({ length: 70 }, (_, i) => now - (i % 7) * DAY - HOUR), now - 9 * DAY];
  expect(treesPerDay(started, now, now - 30 * DAY)).toMatchObject({ per_day: 10, trees: 70, days: 7 });
  expect(treesPerDay(started.slice(0, 20), now, now - 2 * DAY)).toMatchObject({ days: 2 });
  expect(treesPerDay([], now, now).per_day).toBe(0);
});

test("a trial reads the first trees of each arm in the order they were assigned, once they are settled", () => {
  const assigned = ["a", "b", "c", "d", "e", "f"].map((root, i) => ({ root, arm: i % 2 ? "other" : "now", ts: 1000 + i }));
  // The first two of each arm: a, c and b, d. The later trees stay out, whatever they did.
  expect([...cohort(assigned, 2)].sort()).toEqual(["a", "b", "c", "d"]);
  const until = 10 * HOUR, old = until - 2 * HOUR;
  const spent = new Map(Object.entries({
    a: { cost: 1, unpriced: false, last_call: old }, b: { cost: 2, unpriced: false, last_call: old },
    c: { cost: 3, unpriced: false, last_call: until - 10 * 60_000 }, // still working: not settled
    d: { cost: 4, unpriced: true, last_call: old },                   // a call with no price: no cost to read
    e: { cost: 9, unpriced: false, last_call: old },                  // not in the cohort
  }));
  const turns = new Map(Object.entries({ a: { first: old - 5000, end: old }, b: { first: old - 100, end: old }, d: { first: old - 50, end: old } }));
  const got = treeFigures({ assigned, spent, turns, per_arm: 2, until });
  expect([...got.entries()].sort()).toEqual([["a", { tree_cost_usd: 1, tree_ms: 5000 }], ["b", { tree_cost_usd: 2, tree_ms: 100 }], ["d", { tree_ms: 50 }]]);
  // A tree settles when nothing of it has happened for SETTLE_MS, and not before.
  expect(treeFigures({ assigned, spent, turns, per_arm: 2, until: until + SETTLE_MS }).has("c")).toBe(true);
});

// A daemon's experiment wiring over a state folder, with the routes of experiments and of trials.
function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "keel-setting-trials-"));
  const before = allHooks().length;
  const store = new Store(dir), bus = new Bus();
  // Agent sessions name their parent (the agents module's column).
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  new Telemetry(store, bus);
  const errors = new ErrorTracker(store, bus);
  experimentRoutes({ store, errors } as any);
  const routes = settingTrialRoutes({ store, errors } as any);
  const mine = allHooks().slice(before);
  const call = async (method: string, path: string, body?: unknown) => {
    for (const [pattern, handlers] of Object.entries(routes)) {
      const m = new RegExp(`^${pattern.replace(":id", "([^/]+)")}$`).exec(path);
      if (!m || !handlers[method]) continue;
      const req = new Request(`http://keel${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const res: Response = await handlers[method](Object.assign(req, { params: { id: m[1] } }));
      return { status: res.status, body: await res.json() as any };
    }
    throw new Error(`no route ${method} ${path}`);
  };
  const close = () => {
    for (const h of mine) { const i = allHooks().indexOf(h); if (i >= 0) allHooks().splice(i, 1); }
    patchSettings({ agents: { window_share: null, cache_plan: null } });
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, x: experiments!, call, close };
}

const own = () => ({ id: Bun.randomUUIDv7(), kind: SETTING_TRIAL_KIND });
// Agents a top-level session started, each the start of a tree; their agents take the tree's arm.
const agent = (store: Store, x: NonNullable<typeof experiments>, parent: string) => {
  const s = store.createSession({ model: "p:m", workspace: "/" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
  x.assign(store.session(s.id)!);
  return s.id;
};
const call = (store: Store, session: string, ts: number, cost: number, v: { unpriced?: boolean } = {}) =>
  store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cost, unpriced, outcome, purpose) VALUES (?, ?, 'p:m', 100, 10, ?, ?, 'ok', 'turn')").run(session, ts, v.unpriced ? null : cost, v.unpriced ? 1 : 0);

test("new agent trees draw an arm at their start, half each way, and their agents take it", () => {
  const d = daemon();
  try {
    const t = settingTrial("agent_window")!;
    const p = plan(200);
    const e = d.x.start(d.x.create(trialExperiment(t, 0.85, 0.425, p, Date.now()), own()).id);
    const top = d.store.createSession({ model: "p:m", workspace: "/" });
    d.x.assign(top);
    expect(armOf(d.store, top.id)).toBeNull(); // the session the owner talks to is no unit
    const ids = Array.from({ length: 400 }, () => agent(d.store, d.x, top.id));
    const arms = ids.map((id) => armOf(d.store, id)!.arm);
    const low = arms.filter((a) => a === e.arms[1]!.name).length;
    expect(arms.every((a) => e.arms.some((x) => x.name === a))).toBe(true);
    // A fair split of 400 draws: 200 each way, within four standard deviations (40).
    expect(Math.abs(low - 200)).toBeLessThan(40);
    // The arm is set on the tree's first agent, once; its own agent reads it from there.
    const first = ids[0]!;
    const deep = agent(d.store, d.x, first);
    expect(armOf(d.store, deep)).toEqual({ ...armOf(d.store, first)!, root: first });
    const share = (id: string) => windowShare(d.store.session(id)!, (i) => d.store.session(i));
    expect(d.store.session(first)!.settings.compact_share).toBe(armOf(d.store, first)!.arm === e.arms[1]!.name ? 0.425 : 0.85);
    expect(share(deep)).toBe(share(first));
    expect(compactLimit(d.store.session(deep)!, 1000, (i) => d.store.session(i))).toBe(Math.floor(1000 * share(first)));
    // The session the owner talks to keeps the usual share whatever the agents' default is.
    expect(windowShare(d.store.session(top.id)!, (i) => d.store.session(i))).toBe(COMPACT_SHARE);
  } finally { d.close(); }
});

test("a trial ends when the settled trees of its sample are in, and by its time with no winner", async () => {
  const d = daemon();
  try {
    const t = settingTrial("agent_window")!;
    const { x, store } = d;
    const start = (per_arm: number, until: number) => {
      const e = x.start(x.create({ ...trialExperiment(t, 0.85, 0.425, { ...plan(200), per_arm }, Date.now()), stop: { sessions_per_arm: per_arm, until_ms: until } }, own()).id);
      // Its start in the past, so the ledger rows it reads can be older than an hour.
      store.db.query("UPDATE experiments SET data = json_set(data, '$.started_ms', ?) WHERE id = ?").run(Date.now() - 20 * HOUR, e.id);
      return x.get(e.id)!;
    };
    const top = store.createSession({ model: "p:m", workspace: "/" });
    const e = start(5, Date.now() + 5 * DAY);
    const mine = new Map<string, string[]>();
    while ([...e.arms].some((a) => (mine.get(a.name)?.length ?? 0) < 5)) {
      const id = agent(store, x, top.id), arm = armOf(store, id)!.arm;
      mine.set(arm, [...(mine.get(arm) ?? []), id]);
    }
    const now = Date.now(), old = now - 3 * HOUR;
    // The cheaper arm costs about a third less a tree; every tree has a turn and a call, in its settled past.
    mine.get(e.arms[0]!.name)!.forEach((id, i) => { call(store, id, old, 3 + i * 0.1); store.db.query("INSERT INTO telemetry_turns (session_id, turn_event, ts, ms, reason, outcome, requests, cost) VALUES (?, ?, ?, 1000, 'end_turn', 'ok', 1, 1)").run(id, `t-${id}`, old); });
    mine.get(e.arms[1]!.name)!.forEach((id, i) => { call(store, id, old, 2 + i * 0.1); store.db.query("INSERT INTO telemetry_turns (session_id, turn_event, ts, ms, reason, outcome, requests, cost) VALUES (?, ?, ?, 1000, 'end_turn', 'ok', 1, 1)").run(id, `t-${id}`, old); });
    // One tree of the cheaper arm is still working: the sample is not whole, and nothing is decided on a part of it.
    const busy = mine.get(e.arms[1]!.name)![0]!;
    call(store, busy, now - 5 * 60_000, 0.5);
    x.check(top.id, now);
    expect(x.get(e.id)!.state).toBe("running");
    expect(x.report(x.get(e.id)!, now).decision.text).toContain("No winner yet");
    // An hour later its last call has settled: the sample is whole, the trial ends itself and names the winner by its interval.
    x.check(top.id, now + 2 * 60_000); // (looked at once a minute: this one is too soon)
    expect(x.get(e.id)!.state).toBe("running");
    x.check(top.id, now + SETTLE_MS + 2 * 60_000);
    const done = x.get(e.id)!;
    expect(done.state).toBe("stopped");
    expect(done.stop_reason).toBe("all 5 trees per arm are settled");
    expect(done.decision).toMatchObject({ verdict: "won", winner: e.arms[1]!.name });
    const r = x.report(done);
    expect(r.arms.map((a) => a.metrics.tree_cost_usd?.n)).toEqual([5, 5]);
    expect(r.arms.map((a) => a.metrics.tree_ms?.estimate)).toEqual([1000, 1000]);
    expect(r.effects.find((f) => f.metric === "tree_cost_usd")!.better).toBe(true);

    // A trial that reaches its time before its sample ends with the trees it has and names no winner.
    const late = start(50, Date.now() + HOUR);
    expect(late.state).toBe("running");
    for (let i = 0; i < 8; i++) { const id = agent(store, x, top.id); call(store, id, old, 1 + i); }
    x.check(top.id, Date.now() + 2 * HOUR);
    const cut = x.get(late.id)!;
    expect(cut.state).toBe("stopped");
    expect(cut.stop_reason).toBe("reached its time limit");
    expect(cut.decision!.winner).toBeNull();
    expect(cut.decision!.text).toContain("No winner");
  } finally { d.close(); }
});

test("keeping a trial sets the owner's setting for agents, dropping leaves it, and a tree reads it", async () => {
  const d = daemon();
  try {
    const { store, call: api } = d;
    // Nothing is tried while there are no trees to draw from.
    expect((await api("POST", "/api/trials/start", { trial: "agent_window" })).status).toBe(409);
    const rate = (await api("GET", "/api/trials")).body;
    expect(rate.trials.map((x: any) => [x.id, x.now, x.other])).toEqual([
      ["agent_window", "compacts at 85% of the window", "compacts at 42.5% of the window"],
      ["cache_plan", "plans its waits", "lets its cache lapse"],
    ]);
    // Agents started by a top-level session at a rate a trial can be drawn from (200 a day).
    const top = store.createSession({ model: "p:m", workspace: "/" });
    store.db.query("UPDATE sessions SET created = ? WHERE id = ?").run(Date.now() - 3 * DAY, top.id);
    for (let i = 0; i < 600; i++) { const s = store.createSession({ model: "p:m", workspace: "/" }); store.db.query("UPDATE sessions SET parent_id = ?, created = ? WHERE id = ?").run(top.id, Date.now() - (i % 3) * DAY - 60_000, s.id); }
    const started = await api("POST", "/api/trials/start", { trial: "cache_plan" });
    expect(started.status).toBe(201);
    const id = started.body.trial.id as string;
    expect((await api("POST", "/api/trials/start", { trial: "agent_window" })).status).toBe(409); // one live experiment at a time
    expect(started.body.trial.arms.map((a: any) => a.name)).toEqual(["plans its waits", "lets its cache lapse"]);
    // The page reads a running trial's report from the read thread: both arms, none of its trees has a turn yet.
    const listed = (await api("GET", "/api/trials")).body.trials.find((t: any) => t.id === "cache_plan").last;
    expect(listed).toMatchObject({ id, state: "running" });
    expect(listed.report.arms.map((a: any) => a.arm)).toEqual(["plans its waits", "lets its cache lapse"]);
    // A tree whose arm lets its cache lapse plans nothing; its agents read the same.
    const lapse = (() => { for (;;) { const a = agent(store, d.x, top.id); if (armOf(store, a)?.arm === "lets its cache lapse") return a; } })();
    const under = agent(store, d.x, lapse);
    const parent = (i: string) => store.session(i);
    expect([lapse, under].map((i) => cachePlanOn(store.session(i)!, parent))).toEqual([false, false]);
    expect(cachePlanOn(store.session(top.id)!, parent)).toBe(true);
    // Drop: the trial ends and the setting stays.
    const dropped = await api("POST", `/api/trials/${id}/drop`);
    expect(dropped.status).toBe(200);
    expect(dropped.body.trial).toMatchObject({ state: "stopped", choice: { kept: false } });
    expect(settings().agents.cache_plan).toBe(true);
    expect((await api("POST", `/api/trials/${id}/keep`)).status).toBe(409); // chosen once

    // Keep: the other arm's value becomes the owner's, for every agent without a tree of its own.
    const again = (await api("POST", "/api/trials/start", { trial: "agent_window" })).body.trial.id as string;
    const kept = await api("POST", `/api/trials/${again}/keep`);
    expect(kept.body.trial).toMatchObject({ state: "stopped", stop_reason: "kept by the owner", choice: { kept: true } });
    expect(settings().agents.window_share).toBe(0.425);
    const plain = store.createSession({ model: "p:m", workspace: "/" });
    store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(top.id, plain.id);
    expect(windowShare(store.session(plain.id)!, parent)).toBe(0.425);
    expect(windowShare(store.session(top.id)!, parent)).toBe(COMPACT_SHARE);
    // And it can be put back.
    expect((await api("POST", "/api/trials/reset", { trial: "agent_window" })).status).toBe(200);
    expect(windowShare(store.session(plain.id)!, parent)).toBe(COMPACT_SHARE);
  } finally { d.close(); }
});
