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
  await t.land(["keel/a"]);
  expect(t.rows()[0]!.state).toBe("landed");
  expect(readFileSync(join(t.dir, "after.log"), "utf8")).toBe(`main\n${t.main()}\n`);
  expect(g(t.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  expect(g(t.repo, "worktree", "list").split("\n")).toHaveLength(1);
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
