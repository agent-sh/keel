// The landing queue against real git: what it must never do to the owner's
// repository (land a tree no check passed on, move a checkout with work in
// it, push what did not land here, run the after step on another branch),
// who may queue which branch, and what a restart in the middle leaves.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { bindLedger, unbindLedger } from "../checks/ledger.ts";
import { Store } from "../core/store.ts";
import { Overlaps } from "../worktree/overlap-scan.ts";
import { Worktrees } from "../worktree/manager.ts";
import { LandingQueue, type QueueDeps } from "./queue.ts";

// Each case runs git a few dozen times and a check or two.
setDefaultTimeout(60_000);

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `landing-${process.pid}`);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
ownEnv({ GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
afterAll(() => { unbindLedger(); rmSync(root, { recursive: true, force: true }); });

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const tryG = (cwd: string, ...a: string[]) => { try { return g(cwd, ...a); } catch { return null; } };
let n = 0;

type Setup = { checks?: Record<string, unknown>; land?: Record<string, unknown>; files?: Record<string, string>; origin?: boolean };
function setup(o: Setup = {}) {
  const dir = join(root, `case-${++n}`);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".keel"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(repo, "marker.txt"), "main\n");
  writeFileSync(join(repo, "check.sh"), "true\n");
  for (const [f, t] of Object.entries(o.files ?? {})) writeFileSync(join(repo, f), t);
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: o.checks ?? { test: "sh check.sh" }, land: { checks: Object.keys(o.checks ?? { test: 1 }), ...o.land } }));
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  if (o.origin) {
    g(dir, "init", "-q", "--bare", "origin.git");
    g(repo, "remote", "add", "origin", join(dir, "origin.git"));
    g(repo, "push", "-q", "origin", "main");
  }
  const store = new Store(join(dir, "state"));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  new Worktrees(store, join(dir, "wt"));
  bindLedger(store);
  // (A landing schedules a forecast pass of its own; one that runs after the file removed its folders fails, and is no finding.)
  const ov = new Overlaps(store, { changed: () => {}, failed: () => {} });
  const session = (title: string, parent?: string) => {
    const s = store.createSession({ model: "scripted:stand-in", workspace: repo, title });
    if (parent) store.db.run("UPDATE sessions SET parent_id = ? WHERE id = ?", [parent, s.id]);
    return s.id;
  };
  const coord = session("coord");
  const told: { root: string; message: string }[] = [], owed: string[] = [];
  const deps: QueueDeps = {
    changed: () => {}, error: (e) => { throw e; },
    failed: (r, f) => told.push({ root: r, message: f.message }), owed: (s) => owed.push(s),
    confine: (a) => a, env: () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }),
    mayPush: () => undefined,
  };
  const q = new LandingQueue(store, ov, deps);
  // A branch from main that changes one line of notes.md, held by `holder`.
  const branch = (name: string, line: number, to: string, holder?: string) => {
    g(repo, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(repo, "notes.md"), readFileSync(join(repo, "notes.md"), "utf8").replace(`line ${line}\n`, `${to}\n`));
    g(repo, "commit", "-qam", name);
    g(repo, "checkout", "-q", "main");
    if (holder) ov.committed(repo, name, holder);
  };
  const land = async (branches: string[], by: string | null = coord) => { const r = await q.add(repo, branches, by); await q.idle(repo); return r; };
  const rows = () => store.db.query<{ branch: string; state: string; why: string | null; landed: string | null }, []>("SELECT branch, state, why, landed FROM landing_queue ORDER BY pos").all();
  return { dir, repo, store, ov, q, deps, coord, session, told, owed, branch, land, rows, main: () => g(repo, "rev-parse", "main") };
}

// A check that writes into the tree it checks would pass on files the entry does not hold.
test("a check that changes the files it checks: the entry leaves, the base stays", async () => {
  const t = setup({ checks: { fmt: "sh fmt.sh", test: "sh check.sh" }, files: { "fmt.sh": "echo FORMATTED >> notes.md\n", "check.sh": "grep -q FORMATTED notes.md\n" } });
  const base = t.main();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(t.main()).toBe(base);
  expect(t.rows()[0]).toMatchObject({ state: "left" });
  expect(t.rows()[0]!.why).toContain("fmt changed the files it checked (notes.md)");
});

test("a checkout that has the base out with work in it is not moved, and the queue says so", async () => {
  const t = setup();
  const base = t.main();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  writeFileSync(join(t.repo, "marker.txt"), "owner's uncommitted edit\n");
  writeFileSync(join(t.repo, "staged.txt"), "owner's staged file\n");
  g(t.repo, "add", "staged.txt");
  await t.land(["keel/a"]);
  expect(t.main()).toBe(base);
  expect(readFileSync(join(t.repo, "marker.txt"), "utf8")).toBe("owner's uncommitted edit\n");
  expect(g(t.repo, "diff", "--cached", "--name-only")).toBe("staged.txt");
  expect(t.rows()[0]).toMatchObject({ state: "left" });
  expect(t.rows()[0]!.why).toContain("has uncommitted changes (2 files: marker.txt, staged.txt)");
  // Told to the session above the agent whose branch it is.
  expect(t.told.map((x) => x.root)).toEqual([t.coord]);
  expect(t.told[0]!.message).toContain("main was not moved: the checkout at");
});

// A session lands its own branches and its agents'; another session's, or one nobody holds, is the owner's to land.
test("who may queue which branch", async () => {
  const t = setup();
  const other = t.session("another lane");
  const mine = t.session("my agent", t.coord);
  const deeper = t.session("its agent", mine);
  t.branch("keel/other", 1, "x", other);
  t.branch("keel/mine", 2, "y", mine);
  t.branch("keel/deeper", 3, "z", deeper);
  t.branch("keel/nobody", 4, "w");
  const r = await t.q.add(t.repo, ["keel/other", "keel/mine", "keel/deeper", "keel/nobody"], t.coord);
  expect(r.queued.map((e) => e.branch)).toEqual(["keel/mine", "keel/deeper"]);
  expect(r.refused.map((x) => x.branch)).toEqual(["keel/other", "keel/nobody"]);
  expect(r.refused[0]!.why).toContain("another session holds it");
  expect(r.refused[1]!.why).toContain("no session holds it");
  // The owner may queue any.
  const o = await t.q.add(t.repo, ["keel/other", "keel/nobody"], null);
  expect(o.queued.map((e) => e.branch)).toEqual(["keel/other", "keel/nobody"]);
  await t.q.idle(t.repo);
});

// A commit reaches main between the pass's last look and its move: nothing moves and nothing is
// pushed then; the entry is built again on the new main, lands there, and only then is pushed.
test("the base moved under the pass: nothing is pushed before the base moved here", async () => {
  const t = setup({ origin: true, land: { push: "origin" } });
  const base = t.main();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  const was = (LandingQueue.prototype as any).moveBase;
  const seen: string[] = [];
  (LandingQueue.prototype as any).moveBase = async function (...a: unknown[]) {
    if (!seen.length) {
      writeFileSync(join(t.repo, "late.txt"), "late\n");
      g(t.repo, "add", "late.txt");
      g(t.repo, "commit", "-qm", "the owner commits on main meanwhile");
    }
    const r = await was.apply(this, a);
    seen.push(g(join(t.dir, "origin.git"), "rev-parse", "main"));
    return r;
  };
  try { await t.land(["keel/a"]); } finally { (LandingQueue.prototype as any).moveBase = was; }
  // At each move, origin was where it started: the push comes after.
  expect(seen).toEqual([base, base]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(g(t.repo, "log", "--format=%s", "main").split("\n")).toEqual(["keel/a", "the owner commits on main meanwhile", "init"]);
  expect(g(join(t.dir, "origin.git"), "rev-parse", "main")).toBe(t.main());
});

test("land.push names a remote: a path is refused and nothing is pushed there", async () => {
  const t = setup({ land: { push: "elsewhere" } });
  g(t.repo, "init", "-q", "--bare", "elsewhere");
  const base = t.main();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(tryG(join(t.repo, "elsewhere"), "rev-parse", "main")).toBeNull();
  expect(t.main()).toBe(base);
  expect(t.rows()[0]!.why).toContain("land.push names elsewhere, which is not a remote of the repository");
});

test("the after step runs on the landed tip, not on the branch the main checkout has out", async () => {
  const t = setup({ land: { after: "cat marker.txt >> \"$KEEL_LAND_REPO/../after.log\"; git rev-parse HEAD >> \"$KEEL_LAND_REPO/../after.log\"" } });
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  g(t.repo, "checkout", "-q", "-b", "feature", "main");
  writeFileSync(join(t.repo, "marker.txt"), "the owner's feature branch\n");
  g(t.repo, "commit", "-qam", "feature marker");
  expect(t.q.afterPins.pin(t.repo, t.q.afterPins.show(t.repo).sha256!)).toBeNull();
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(readFileSync(join(t.dir, "after.log"), "utf8")).toBe(`main\n${t.main()}\n`);
  expect(g(t.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  expect(g(t.repo, "worktree", "list").split("\n")).toHaveLength(1);
});

// The after step runs in the owner's checkout after the base moved: only while his pin holds its command and the
// script of .keel/ it runs, as the landed commit has them. Held, the branches still land; the outcome says why.
test("the after step runs only while the owner's pin holds it and the script it runs", async () => {
  const t = setup({ land: { after: "bash .keel/after.sh" }, files: { ".keel/after.sh": 'echo "ran $KEEL_LANDED_BASE" >> "$KEEL_LAND_REPO/../after.log"\n' } });
  const log = join(t.dir, "after.log");
  const text = () => { const o = t.q.outcomeFor(t.coord)!; o.settle(); return o.text; };
  const a = t.session("a", t.coord);
  t.branch("keel/a", 1, "line 1 ALPHA", a);
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(existsSync(log)).toBe(false);
  expect(text()).toContain("The after-land step did not run: the owner has not trusted the after step and .keel/after.sh yet");
  expect(t.q.afterPins.show(t.repo)).toMatchObject({ state: "new", command: "bash .keel/after.sh", covers: [".keel/after.sh"] });
  expect(t.q.afterPins.pin(t.repo, "0".repeat(64))).toContain("no longer the one that was shown");
  expect(t.q.afterPins.pin(t.repo, t.q.afterPins.show(t.repo).sha256!)).toBeNull();
  t.branch("keel/b", 2, "line 2 BETA", a);
  await t.land(["keel/b"]);
  expect(readFileSync(log, "utf8")).toBe("ran main\n");
  expect(text()).toContain("The after-land step ran once (exit 0)");
  // A branch that changes the script lands, and the changed script does not run.
  g(t.repo, "checkout", "-q", "-b", "keel/c", "main");
  writeFileSync(join(t.repo, ".keel/after.sh"), 'echo changed >> "$KEEL_LAND_REPO/../after.log"\n');
  g(t.repo, "commit", "-qam", "keel/c");
  g(t.repo, "checkout", "-q", "main");
  t.ov.committed(t.repo, "keel/c", a);
  await t.land(["keel/c"]);
  expect(t.rows()[2]!.state).toBe("landed");
  expect(readFileSync(log, "utf8")).toBe("ran main\n");
  expect(text()).toContain("changed since the owner trusted them");
  expect(t.q.afterPins.show(t.repo).state).toBe("changed");
});

// The rest of the land block is part of what the owner trusts: a landing that sends the push elsewhere holds the step.
test("a landing that moves land.push to another remote holds the after step until it is trusted again", async () => {
  const t = setup({ origin: true, land: { push: "origin", after: "bash .keel/after.sh" }, files: { ".keel/after.sh": 'echo "to $KEEL_LANDED_PUSHED" >> "$KEEL_LAND_REPO/../after.log"\n' } });
  g(t.dir, "init", "-q", "--bare", "mirror.git");
  g(t.repo, "remote", "add", "mirror", join(t.dir, "mirror.git"));
  const log = join(t.dir, "after.log");
  const a = t.session("a", t.coord);
  expect(t.q.afterPins.pin(t.repo, t.q.afterPins.show(t.repo).sha256!)).toBeNull();
  expect(t.q.afterPins.show(t.repo).land).toEqual({ push: "origin", checks: ["test: sh check.sh"] });
  // A branch that changes where the landing pushes: it lands (under the rules the base had), and the next batch,
  // which pushes to the new remote, does not run the step.
  g(t.repo, "checkout", "-q", "-b", "keel/m", "main");
  const file = JSON.parse(readFileSync(join(t.repo, ".keel/checks.json"), "utf8"));
  writeFileSync(join(t.repo, ".keel/checks.json"), JSON.stringify({ ...file, land: { ...file.land, push: "mirror" } }));
  g(t.repo, "commit", "-qam", "keel/m");
  g(t.repo, "checkout", "-q", "main");
  t.ov.committed(t.repo, "keel/m", a);
  await t.land(["keel/m"]);
  expect(readFileSync(log, "utf8")).toBe("to origin\n");
  t.branch("keel/n", 2, "line 2 BETA", a);
  await t.land(["keel/n"]);
  expect(t.rows().map((r) => r.state)).toEqual(["landed", "landed"]);
  expect(readFileSync(log, "utf8")).toBe("to origin\n");
  expect(t.q.afterPins.show(t.repo)).toMatchObject({ state: "changed", land: { push: "mirror" } });
});

// The queue's push goes to a public place under the owner's name: read as his own `git push` is.
test("a push the private-words reading holds (or could not read) is not made, and the after step is told so", async () => {
  const t = setup({ origin: true, land: { push: "origin", after: "bash .keel/after.sh" }, files: { ".keel/after.sh": 'echo "pushed=[$KEEL_LANDED_PUSHED]" >> "$KEEL_LAND_REPO/../after.log"\n' } });
  const log = join(t.dir, "after.log");
  const asked: string[] = [];
  let answer: () => Promise<string | undefined> = async () => "This goes to a public place under your name and holds private words:\n- notes.md: SECRETNAME";
  t.deps.publicSend = async (repo, command, who) => { asked.push(`${repo === t.repo} ${command.replace(/[0-9a-f]{40}/, "TIP")} ${who === t.coord}`); return answer(); };
  expect(t.q.afterPins.pin(t.repo, t.q.afterPins.show(t.repo).sha256!)).toBeNull();
  const origin = () => g(t.repo, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  const before = origin();
  const a = t.session("a", t.coord);
  t.branch("keel/a", 1, "line 1 SECRETNAME", a);
  await t.land(["keel/a"]);
  expect(asked).toEqual(["true git push --porcelain origin TIP:refs/heads/main true"]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(origin()).toBe(before);
  const o = t.q.outcomeFor(t.coord)!; o.settle();
  expect(o.text).toContain("It was not pushed to origin: This goes to a public place under your name and holds private words");
  expect(readFileSync(log, "utf8")).toBe("pushed=[]\n");
  // A reading that fails is a part it could not read: no push either.
  answer = async () => { throw new Error("no answer"); };
  t.branch("keel/b", 2, "line 2 BETA", a);
  await t.land(["keel/b"]);
  expect(origin()).toBe(before);
  expect(readFileSync(log, "utf8")).toBe("pushed=[]\npushed=[]\n");
  // Nothing found: the push goes.
  answer = async () => undefined;
  t.branch("keel/c", 3, "line 3 GAMMA", a);
  await t.land(["keel/c"]);
  expect(origin()).toBe(t.main());
  expect(readFileSync(log, "utf8")).toBe("pushed=[]\npushed=[]\npushed=[origin]\n");
});

// A restart while the after step ran: the batch's entries are landed, the step never ended; the outcome says so.
test("a restart that cut a running after step is told", async () => {
  const t = setup({ land: { after: "true" } });
  expect(t.q.afterPins.pin(t.repo, t.q.afterPins.show(t.repo).sha256!)).toBeNull();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  // As the store is when the daemon stopped while the step ran.
  t.store.db.query("UPDATE landing_batches SET after_exit = NULL, after_log = NULL").run();
  t.store.db.query("UPDATE landing_queue SET owed = 1").run();
  t.owed.length = 0;
  const q2 = new LandingQueue(t.store, t.ov, t.deps);
  await q2.recover();
  await q2.idle(t.repo);
  expect(t.owed).toContain(t.coord);
  expect(q2.outcomeFor(t.coord)?.text).toContain("The after-land step did not finish: the daemon stopped after the move");
});

test("a check past its time is stopped with every process it started", async () => {
  const flag = join(root, `orphan-${n + 1}`);
  const t = setup({ land: { timeout_minutes: 0.02 }, files: { "check.sh": `sh -c 'sleep 3; touch ${flag}' & sleep 30\n` } });
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.why).toContain("stopped after 2 s");
  await Bun.sleep(3500);
  expect(existsSync(flag)).toBe(false);
});

// A stop between the base's move and the rows' write: the next start reads the base, not the rows.
test("after a restart in the middle, an entry the base holds is landed and told", async () => {
  const t = setup();
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  t.store.db.query("UPDATE landing_queue SET state = 'checking', landed = NULL, owed = 0").run();
  t.owed.length = 0;
  const q2 = new LandingQueue(t.store, t.ov, t.deps);
  await q2.recover();
  await q2.idle(t.repo);
  expect(t.rows()[0]).toMatchObject({ state: "landed" });
  expect(t.owed).toContain(t.coord);
  expect(q2.outcomeFor(t.coord)?.text).toContain("Landed on main: keel/a");
  expect(g(t.repo, "log", "--format=%s", "main").split("\n")).toEqual(["keel/a", "init"]);
});

test("a base that keeps moving while an entry is checked: it leaves after a few tries", async () => {
  // Each run of the check moves main.
  const t = setup({ files: { "check.sh": "cd \"$KEEL_LAND_REPO\" && date +%s%N >> moved.txt && git add moved.txt && git commit -qm moved\n" } });
  t.branch("keel/a", 1, "line 1 ALPHA", t.session("a", t.coord));
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("left");
  expect(t.rows()[0]!.why).toContain("main moved while it was checked, 3 times");
});

test("a session whose commands have no network: the base moves here and is not pushed, and the outcome says so", async () => {
  const t = setup({ origin: true, land: { push: "origin" } });
  const base = t.main();
  t.deps.mayPush = () => "the session that queued it has no network in its sandbox";
  t.branch("keel/a", 1, "line 1 ALPHA", t.coord);
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(g(join(t.dir, "origin.git"), "rev-parse", "main")).toBe(base);
  expect(t.q.outcomeFor(t.coord)?.text).toContain("It was not pushed to origin: the session that queued it has no network in its sandbox.");
});

// A branch that conflicts with the base goes to its own agent (src/landing/resolve.ts): a stand-in
// agent here, which rebases in its worktree or does not, and reports.
function withAgents(t: ReturnType<typeof setup>) {
  const sent: { to: string; text: string }[] = [];
  const agents = new Map<string, { ended: boolean; status: string; tasks: number; report: string }>();
  t.deps.agents = {
    who: (e) => (e.holder && t.store.session(e.holder)?.parent_id ? { agent: `ag-${e.holder}` } : undefined),
    send: async (e, to, text) => {
      const id = "agent" in to ? to.agent : "fresh";
      sent.push({ to: id, text });
      const a = agents.get(id) ?? { ended: true, status: "completed", tasks: 0, report: "" };
      agents.set(id, { ...a, ended: false, status: "running", tasks: a.tasks + 1 });
      return { agent: id, session: e.holder!, task: a.tasks + 1 };
    },
    state: (id) => agents.get(id),
  };
  const wts = new Worktrees(t.store, join(t.dir, "wt"));
  // The agent's worktree, with its branch out.
  const worktree = async (session: string, branch: string) => { const w = await wts.attach(session, t.repo, branch); wts.adopt(session, w.wt); return w.wt.path; };
  // Its turn ends with this report.
  const end = async (session: string, report = "Done.") => {
    const id = `ag-${session}`;
    agents.set(id, { ...agents.get(id)!, ended: true, status: "completed", report });
    await t.q.agentEnded(id);
    await t.q.idle(t.repo);
  };
  return { sent, worktree, end };
}

test("a conflict with the base: its agent gets a rebase task naming files and lines, and the rebased branch lands", async () => {
  const t = setup();
  const a = withAgents(t);
  const agent = t.session("delta", t.coord);
  t.branch("keel/d", 5, "line 5 DELTA", agent);
  const wt = await a.worktree(agent, "keel/d");
  writeFileSync(join(t.repo, "notes.md"), readFileSync(join(t.repo, "notes.md"), "utf8").replace("line 5\n", "line 5 MAIN\n"));
  g(t.repo, "commit", "-qam", "main changes line 5");
  const base = t.main();
  await t.land(["keel/d"]);
  // It did not leave: its agent has the task, and nobody was told of a failure.
  expect(t.rows()[0]).toMatchObject({ state: "resolving" });
  expect(t.told).toEqual([]);
  expect(a.sent).toHaveLength(1);
  const task = a.sent[0]!.text;
  expect(task).toContain(`your branch keel/d conflicts with main`);
  expect(task).toContain(`main is now at ${base.slice(0, 9)} (main changes line 5)`);
  expect(task).toContain(`stops at ${g(t.repo, "rev-parse", "keel/d").slice(0, 9)} (keel/d)`);
  expect(task).toContain("notes.md: main's lines 5");
  expect(task).toContain("1. git rebase main");
  // The queue's own rebase was given up in its own worktree: nothing of the agent's changed.
  expect(existsSync(join(wt, ".git"))).toBe(true);
  expect(g(wt, "status", "--porcelain")).toBe("");
  // The agent rebases, keeping both sides, and reports.
  expect(tryG(wt, "rebase", "main")).toBeNull();
  writeFileSync(join(wt, "notes.md"), readFileSync(join(wt, "notes.md"), "utf8").replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/, "line 5 MAIN DELTA\n"));
  g(wt, "add", "notes.md");
  execFileSync("git", ["rebase", "--continue"], { cwd: wt, env: { ...process.env, GIT_EDITOR: "true" } });
  await a.end(agent, "Rebased onto main, kept both.");
  expect(t.rows()[0]).toMatchObject({ state: "landed" });
  expect(g(t.repo, "log", "--format=%s", "main").split("\n")).toEqual(["keel/d", "main changes line 5", "init"]);
  expect(readFileSync(join(t.repo, "notes.md"), "utf8")).toContain("line 5 MAIN DELTA\n");
  expect(t.told).toEqual([]);
});

test("two failed tries go to the session that started the agent; a rebase in progress in its worktree is left as it is", async () => {
  const t = setup();
  const a = withAgents(t);
  const agent = t.session("delta", t.coord);
  t.branch("keel/d", 5, "line 5 DELTA", agent);
  const wt = await a.worktree(agent, "keel/d");
  writeFileSync(join(t.repo, "notes.md"), readFileSync(join(t.repo, "notes.md"), "utf8").replace("line 5\n", "line 5 MAIN\n"));
  g(t.repo, "commit", "-qam", "main changes line 5");
  await t.land(["keel/d"]);
  expect(a.sent).toHaveLength(1);
  // The agent starts the rebase and ends its turn in the middle of it.
  expect(tryG(wt, "rebase", "main")).toBeNull();
  const rebasing = join(t.repo, ".git/worktrees", g(wt, "rev-parse", "--git-dir").split("/").at(-1)!, "rebase-merge");
  expect(existsSync(rebasing)).toBe(true);
  await a.end(agent);
  // Another try: the task says the rebase in progress is left as it is, and the queue did not end it.
  expect(a.sent).toHaveLength(2);
  expect(a.sent[1]!.text).toContain("try 2 of 2");
  expect(a.sent[1]!.text).toContain("already in progress in your worktree, and Keel did not start it: it is left as it is");
  expect(existsSync(rebasing)).toBe(true);
  expect(t.rows()[0]).toMatchObject({ state: "resolving" });
  await a.end(agent);
  expect(existsSync(rebasing)).toBe(true);
  expect(t.rows()[0]).toMatchObject({ state: "left" });
  expect(t.rows()[0]!.why).toContain("its agent left a rebase or merge in progress, after 2 tries");
  expect(t.told.map((x) => x.root)).toEqual([t.coord]);
  expect(t.told[0]!.message).toContain("keel/d left the landing queue of main: it conflicts with main");
});

test("a conflict its agent calls substantive goes to the session that started it at once", async () => {
  const t = setup();
  const a = withAgents(t);
  const agent = t.session("delta", t.coord);
  t.branch("keel/d", 5, "line 5 DELTA", agent);
  writeFileSync(join(t.repo, "notes.md"), readFileSync(join(t.repo, "notes.md"), "utf8").replace("line 5\n", "line 5 MAIN\n"));
  g(t.repo, "commit", "-qam", "main changes line 5");
  await t.land(["keel/d"]);
  await a.end(agent, "Both sides set line 5.\nConflict: substantive: keep MAIN or DELTA on line 5?");
  expect(a.sent).toHaveLength(1);
  expect(t.rows()[0]).toMatchObject({ state: "left" });
  expect(t.told[0]!.message).toContain("its agent found the conflict substantive: keep MAIN or DELTA on line 5?");
});
