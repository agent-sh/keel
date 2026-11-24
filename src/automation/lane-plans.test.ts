import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { briefOf, LanePlans, planText, type PlanView } from "./lane-plans.ts";

const row = (idx: number, title: string, files: string[], how = "named") => ({ idx, title, brief: `Do ${title}.`, files: JSON.stringify(files.map((path) => ({ path, how }))), agent_id: null, state: "planned" as const });

test("a lane's task says its files and the files of the lanes beside it; a merged unit holds both briefs", () => {
  const all = [row(0, "alpha", ["src/z.ts", "src/x.ts"]), row(1, "beta", ["src/y.ts"]), row(2, "gamma", ["src/q.ts"], "importer")];
  const one = briefOf([all[0]!], all);
  expect(one).toStartWith("Do alpha.\n\n---\nThis task is lane 1 of a plan of 3 lanes.");
  expect(one).toContain("Its files, as the plan has them: src/z.ts, src/x.ts.");
  // A lane that only reaches a file as an importer owns nothing.
  expect(one).toContain("Other lanes of the plan own: src/y.ts (lane 2, beta). Keep out of their files");
  const two = briefOf([all[0]!, all[1]!], all);
  expect(two).toContain("## Lane 1: alpha\n\nDo alpha.\n\n## Lane 2: beta\n\nDo beta.");
  expect(two).toContain("does the work of 2 lanes");
  expect(two).not.toContain("Other lanes");
});

test("the plan as the coordinator reads it", () => {
  const lane = (idx: number, title: string, files: string[], extra: Partial<PlanView["lanes"][number]> = {}) => ({ idx, title, brief: "", type: null, declared: [], files: files.map((path) => ({ path, how: "named" as const })), unresolved: [], state: "planned" as const, unit: idx, wave: 0, after: [], waits_on: [], merged_with: [], agent: null, started: null, changed: null, told: [], why: null, blocked: null, ...extra });
  const v: PlanView = {
    id: "lp-1", session_id: "s", repo: "/r", base: "main", base_tip: "0123456789abcdef", created: 0, by: "session", hubs: [], held: null,
    lanes: [lane(0, "alpha", ["src/z.ts"]), lane(1, "beta", ["src/z.ts"], { state: "waiting", waits_on: [0] }), lane(2, "gamma", [])],
    meetings: [{ a: 0, b: 1, kind: "file", files: ["src/z.ts"] }],
    proposal: { units: [{ lanes: [0], wave: 0, after: [] }, { lanes: [1], wave: 1, after: [0] }, { lanes: [2], wave: 0, after: [] }], waves: 2 },
  };
  expect(planText(v)).toBe([
    "Plan lp-1: 3 lanes on main@012345678.",
    "1. alpha: src/z.ts",
    "2. beta [waits for lane 1 to land]: src/z.ts",
    "3. gamma: no file known (declare its files: it may meet any lane)",
    "",
    "Lanes that meet: 1 and 2 (both name src/z.ts).",
    "Proposed: start 1, 3 now; then 2 after 1 lands.",
  ].join("\n"));
  const later = { ...v, held: "the owner stopped this session", lanes: [lane(0, "alpha", ["src/z.ts"], { state: "failed", why: "depth limit" }), lane(1, "beta", ["src/z.ts"], { state: "waiting", waits_on: [0], blocked: { lane: 0, why: "did not start (depth limit)", ended: false } }), lane(2, "gamma", [])] };
  const t = planText(later).split("\n");
  expect(t[0]).toBe("Plan lp-1: 3 lanes on main@012345678. Held: the owner stopped this session; nothing of it starts until that ends.");
  expect(t[1]).toBe("1. alpha [did not start: depth limit]: src/z.ts");
  expect(t[2]).toBe("2. beta [blocked: lane 1 did not start (depth limit)]: src/z.ts");
});

// The plan's own life with a stand-in for the agents it starts: holds, failed starts, lanes that will
// not land, a detached HEAD and a restart between a claim and its agent.
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
function bench() {
  const dir = mkdtempSync(join(tmpdir(), "keel-lane-plans-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  for (const f of ["src/z.ts", "src/x.ts", "src/y.ts"]) writeFileSync(join(repo, f), `export const v = "${f}";\n`);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const store = new Store(join(dir, "state"));
  store.migrate("CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, base_commit TEXT NOT NULL)");
  const made = new Map<string, { id: string; title: string; status: string; session_id: string; branch?: string }>();
  const refuse = new Map<string, string>(); // a title: why its spawn fails
  let n = 0;
  const agents = {
    spawn: async (_parent: string, input: { title: string }) => {
      const why = refuse.get(input.title);
      if (why) throw new Error(why);
      const a = { id: `a${++n}`, title: input.title, status: "running", session_id: `s${n}` };
      made.set(a.id, a);
      return a;
    },
    get: (id: string) => made.get(id),
  };
  const told: { cls: string; message: string; how: string }[] = [];
  const errors: string[] = [];
  let held: string | undefined;
  // A hold that begins after this many questions of it: the owner's Stop that comes while a pass awaits.
  let asks = 0, holdAfter = Infinity;
  const deps = {
    error: (e: unknown) => void errors.push(String((e as Error).message)), changed: () => {},
    tell: (_s: string, cls: string, message: string, how: "wake" | "ride") => void told.push({ cls, message, how }),
    held: () => (++asks > holdAfter ? "the owner stopped this session" : held), agents: agents as never,
  };
  const lp = new LanePlans(store, deps);
  const session = store.createSession({ model: "m:x", workspace: repo, title: "coord" });
  // Two lanes that meet in src/z.ts (one file of four: not proposed as one): lane 2 after lane 1.
  const plan = () => lp.make(session.id, [{ title: "a", brief: "Edit src/z.ts.", files: ["src/z.ts", "src/x.ts", "src/a1.ts", "src/a2.ts"] }, { title: "b", brief: "Edit src/z.ts too.", files: ["src/z.ts", "src/y.ts", "src/b1.ts", "src/b2.ts"] }], "session");
  const byTitle = (t: string) => [...made.values()].find((a) => a.title === t);
  return { store, repo, lp, deps, made, refuse, told, errors, plan, byTitle, setHeld: (w: string | undefined) => void (held = w), holdAfter: (n: number) => { asks = 0; holdAfter = n; } };
}

test("a plan starts nothing while its session is held, and goes on when the hold ends", async () => {
  const b = bench();
  const v = await b.plan();
  expect((await b.lp.start(v.id, "order")).waiting).toEqual([1]);
  b.byTitle("a")!.status = "completed"; // no branch: nothing of it to land
  b.setHeld("the owner stopped this session");
  await b.lp.look();
  expect(b.byTitle("b")).toBeUndefined();
  expect((await b.lp.view(v.id))!.held).toBe("the owner stopped this session");
  // The owner's or the coordinator's press starts nothing either.
  await expect(b.lp.start(v.id, [1], "owner")).rejects.toThrow("while its session is held");
  expect(b.byTitle("b")).toBeUndefined();
  b.setHeld(undefined);
  b.lp.released();
  await b.lp.look();
  expect(b.byTitle("b")?.status).toBe("running");
  expect((await b.lp.view(v.id))!.lanes[1]!.state).toBe("started");
});

test("a start that fails marks the lane failed, tells the plan's session once, and blocks the lane after it", async () => {
  const b = bench();
  const v = await b.plan();
  b.refuse.set("a", "agents nest at most 3 deep");
  // The coordinator's own call is told by its result.
  const r = await b.lp.start(v.id, "order", "session");
  expect(r.failed).toEqual([{ idx: 0, why: "agents nest at most 3 deep" }]);
  expect(b.errors).toEqual(["agents nest at most 3 deep"]);
  expect(b.told).toEqual([]);
  let lanes = (await b.lp.view(v.id))!.lanes;
  expect([lanes[0]!.state, lanes[0]!.why]).toEqual(["failed", "agents nest at most 3 deep"]);
  // Lane 2 waits on a lane that never started: blocked, told once with a turn.
  await b.lp.look();
  await b.lp.look();
  lanes = (await b.lp.view(v.id))!.lanes;
  expect(lanes[1]!.state).toBe("waiting");
  expect(lanes[1]!.blocked).toEqual({ lane: 0, why: "did not start (agents nest at most 3 deep)", ended: false });
  expect(b.told.map((t) => [t.cls, t.how])).toEqual([["lane blocked", "wake"]]);
  expect(b.told[0]!.message).toContain('Lane 2 "b" of plan');
  expect(b.told[0]!.message).toContain("it will not start by itself");
  // The owner's press of a failed lane that fails again is told once, with a turn.
  await b.lp.start(v.id, [0], "owner");
  expect(b.told.map((t) => t.cls)).toEqual(["lane blocked", "lane not started"]);
  // Start now: the blocked lane starts.
  expect((await b.lp.start(v.id, [1], "owner")).started).toEqual([1]);
  expect((await b.lp.view(v.id))!.lanes[1]!.blocked).toBeNull();
});

test("a lane waiting on one that failed, was stopped or ended with work not on the base is blocked, told once", async () => {
  const b = bench();
  const v = await b.plan();
  await b.lp.start(v.id, "order");
  const a = b.byTitle("a")!;
  // Ended with a commit of its own the base does not hold: waits for it to land, said with the next input.
  git(b.repo, "branch", "lane-a");
  git(b.repo, "switch", "-q", "lane-a");
  writeFileSync(join(b.repo, "src/z.ts"), "a\n");
  git(b.repo, "commit", "-qam", "a");
  git(b.repo, "switch", "-q", "main");
  Object.assign(a, { status: "completed", branch: "lane-a" });
  await b.lp.look();
  await b.lp.look();
  expect((await b.lp.view(v.id))!.lanes[1]!.blocked).toEqual({ lane: 0, why: "ended with work not on main", ended: true });
  expect(b.told.map((t) => [t.cls, t.how])).toEqual([["lane waits for a branch to land", "ride"]]);
  // Then it is stopped (its work still not on main): blocked, told with a turn.
  a.status = "stopped";
  await b.lp.look();
  await b.lp.look();
  expect((await b.lp.view(v.id))!.lanes[1]!.blocked).toEqual({ lane: 0, why: "was stopped", ended: false });
  expect(b.told.map((t) => t.how)).toEqual(["ride", "wake"]);
  // Its work lands after all: lane 2 starts by itself.
  git(b.repo, "merge", "-q", "--ff-only", "lane-a");
  await b.lp.look();
  expect(b.byTitle("b")?.status).toBe("running");
  expect(b.told).toHaveLength(2);
});

test("a failed lane with no work of its own blocks the lane after it", async () => {
  const b = bench();
  const v = await b.plan();
  await b.lp.start(v.id, "order");
  b.byTitle("a")!.status = "failed";
  await b.lp.look();
  expect(b.byTitle("b")).toBeUndefined();
  expect((await b.lp.view(v.id))!.lanes[1]!.blocked).toEqual({ lane: 0, why: "ended failed", ended: false });
});

test("a plan is made on a named branch only", async () => {
  const b = bench();
  git(b.repo, "switch", "-q", "--detach");
  await expect(b.plan()).rejects.toThrow("HEAD is detached");
  git(b.repo, "switch", "-q", "main");
  expect((await b.plan()).base).toBe("main");
});

test("a restart between a lane's claim and its agent leaves the lane to start again", async () => {
  const b = bench();
  const v = await b.plan();
  // The claim was written; the daemon stopped before the agent was made.
  b.store.db.query("UPDATE plan_lanes SET state = 'started', started = ? WHERE plan_id = ? AND idx = 0").run(Date.now(), v.id);
  const again = new LanePlans(b.store, b.deps);
  expect((await again.view(v.id))!.lanes[0]!.state).toBe("planned");
  expect((await again.start(v.id, [0])).started).toEqual([0]);
});

test("a hold made while a pass awaits stops the start: the hold is looked at again before each spawn", async () => {
  const b = bench();
  const v = await b.plan();
  await b.lp.start(v.id, "order");
  b.byTitle("a")!.status = "completed"; // no branch: nothing of it to land
  // The pass's first look finds no hold; the owner's Stop comes during its awaits.
  b.holdAfter(1);
  await b.lp.look();
  expect(b.byTitle("b")).toBeUndefined();
  expect((await b.lp.view(v.id))!.lanes[1]!.state).toBe("waiting");
  b.holdAfter(Infinity);
  await b.lp.look();
  expect(b.byTitle("b")?.status).toBe("running");
});

test("a restart between the claim and the agent of a merged unit gives every lane of it the one agent", async () => {
  const b = bench();
  const v = await b.lp.make(b.store.createSession({ model: "m:x", workspace: b.repo, title: "coord2" }).id, [{ title: "a", brief: "Edit src/z.ts.", files: ["src/z.ts"] }, { title: "b", brief: "Edit src/z.ts too.", files: ["src/z.ts"] }], "session");
  expect(v.proposal.units.map((u) => u.lanes)).toEqual([[0, 1]]);
  const out = await b.lp.start(v.id, "order");
  expect(out.started).toEqual([0, 1]);
  const agent = b.byTitle("a + b")!;
  // The claim was written and the agent made; the daemon stopped before the lanes were given it.
  b.store.db.query("UPDATE plan_lanes SET agent_id = NULL, session_id = NULL WHERE plan_id = ?").run(v.id);
  b.store.db.query("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, created INTEGER, session_id TEXT)").run();
  b.store.db.query("INSERT INTO agents (id, parent_id, created, session_id) VALUES (?, ?, ?, ?)").run(agent.id, v.session_id, Date.now() + 1, agent.session_id);
  const again = new LanePlans(b.store, b.deps);
  const lanes = (await again.view(v.id))!.lanes;
  expect(lanes.map((l) => [l.state, l.agent?.id])).toEqual([["started", agent.id], ["started", agent.id]]);
  await again.look();
  expect(b.made.size).toBe(1);
});
