// The checks beside an agent on a real repository: which tests a step's change runs, who is told a red result
// and when the copy of the files goes, the run's view of the installed packages in the sandbox, and that a run
// Keel made by itself is never what says a check is red on the base too.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Gate } from "../safety/gate.ts";
import { sandboxStatus } from "../safety/sandbox.ts";
import { Worktrees } from "../worktree/manager.ts";
import { afterCall, afterStep, afterTurn, bindBeside, laneOf } from "./beside-run.ts";
import { scratchName, BESIDE_DIR, type AgentState } from "./beside.ts";
import { bindLedger, keyOf, ofSession, record, repoOf, treeOf } from "./ledger.ts";
import { baseFor } from "./runs.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-beside-run-"));
const store = new Store(join(dir, "state"));
new Worktrees(store, join(dir, "worktrees")); // its table: the base is read from it
bindLedger(store);
// (What the automation adds to the sessions table when it starts: an agent's session names its parent.)
store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
const gate = new Gate(store, new Bus(), (_s, p) => p.sandbox !== "off" && sandboxStatus().available);

// Where each agent stands, and what it and its parent were told.
const state = new Map<string, AgentState>();
const toAgent: { id: string; text: string }[] = [];
const toParent: { id: string; cls: string; message: string }[] = [];
bindBeside({
  store, capture: (e) => { throw e; }, perm: (id) => gate.perm(id), confine: (id, ws, tool, shown) => gate.confineFor(id, ws, tool, shown),
  agentOf: (id) => state.get(id),
  tellAgent: async (id, text) => { if (state.get(id) !== "working") return false; toAgent.push({ id, text }); return true; },
  tellParent: (id, cls, message) => void toParent.push({ id, cls, message }),
  windowMs: 0,
});

// A repository whose check runs its test files with `sh t.sh FILE...` (each a sh script that exits 1 to fail),
// and an agent's session in it, working.
function repo(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const top = mkdtempSync(join(dir, "repo-"));
  const g = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: top });
  g("init", "-q", "-b", "main");
  mkdirSync(join(top, ".keel"));
  writeFileSync(join(top, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "sh t.sh", args: true, tests: ["**/*.test.sh"], beside: true, ...extra } } }));
  writeFileSync(join(top, "t.sh"), 'f=0; for t in "$@"; do sh "$t" || f=1; done; exit $f\n');
  // (Content of this repository's own: the ledger is kept by tree, and another test's tree is not this one's.)
  writeFileSync(join(top, "README"), top);
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(top, f, ".."), { recursive: true }); writeFileSync(join(top, f), text); }
  g("add", "-A");
  g("commit", "-qm", "first");
  const parent = store.createSession({ model: "m:x", workspace: top, title: "parent" });
  const made = store.createSession({ model: "m:x", workspace: top, title: "agent" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, made.id);
  const session = store.session(made.id)!;
  if (session.parent_id !== parent.id) throw new Error("the agent's session has no parent");
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  state.set(session.id, "working");
  return { top, session, write: (f: string, text: string) => writeFileSync(join(top, f), text) };
}
const EDIT = { id: "c", tool: { kind: "edit" } } as any;
// One step of the agent that edited files, then (with `end`) the end of its turn.
const step = (s: { id: string }, end = false) => { const sess = store.session(s.id)!; afterCall(sess, EDIT); afterStep(sess); if (end) afterTurn(sess); };
// Until its lane has nothing running or waiting.
async function idle(id: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) { const l = laneOf(id); if (!l || (!l.running && l.first === null)) return; } // (gone: settled, and dropped)
  throw new Error("the lane did not settle");
}
const ran = (id: string) => ofSession(id).filter((r) => r.by === "beside").map((r) => r.command);
const copyOf = (id: string) => join(store.stateDir, ...BESIDE_DIR, scratchName(id));

test("a run takes the tests of the latest step's change, not of every change since the base", async () => {
  const { session, write } = repo({ "a/lib.sh": "x=1\n", "a/lib.test.sh": "exit 0\n", "b/lib.sh": "y=1\n", "b/lib.test.sh": "exit 0\n" });
  write("a/lib.sh", "x=2\n");
  step(session);
  await idle(session.id);
  write("b/lib.sh", "y=2\n");
  step(session);
  await idle(session.id);
  expect(ran(session.id)).toEqual(["sh t.sh ./a/lib.test.sh", "sh t.sh ./b/lib.test.sh"]);
});

test("a wide change runs the most direct of the tests it touches", async () => {
  const files: Record<string, string> = { "c/lib.sh": "x=1\n" };
  for (let i = 0; i < 30; i++) files[`c/t${String(i).padStart(2, "0")}.test.sh`] = "exit 0\n";
  const { session, write } = repo(files);
  write("c/lib.sh", "x=2\n");
  step(session);
  await idle(session.id);
  const [command] = ran(session.id);
  expect(command!.split(" ").filter((w) => w.endsWith(".test.sh"))).toHaveLength(20);
});

test("a red is told to the agent at work, to the parent of one that ended (no new work), and to nobody past the owner's stop", async () => {
  const { session, write } = repo({ "lib.sh": "x=1\n", "lib.test.sh": '. ./lib.sh; [ "$x" = 1 ] || { echo "error: x is $x"; exit 1; }\n' });
  toAgent.length = toParent.length = 0;
  // At work: its next step reads it.
  write("lib.sh", "x=2\n");
  step(session);
  await idle(session.id);
  expect(toAgent.map((t) => t.id)).toEqual([session.id]);
  expect(toAgent[0]!.text).toContain("error: x is 2");
  // Ended before the run did: the session that started it is told; the agent is given nothing.
  state.set(session.id, "ended");
  write("lib.sh", "x=3\n");
  step(session, true);
  await idle(session.id);
  expect(toAgent).toHaveLength(1);
  expect(toParent).toEqual([{ id: session.id, cls: "unit", message: expect.stringContaining("unit failed after it ended") }]);
  expect(toParent[0]!.message).toContain("error: x is 3");
  // Stopped by the owner: nothing runs, and nobody is told.
  state.set(session.id, "held");
  const before = ran(session.id).length;
  write("lib.sh", "x=4\n");
  step(session, true);
  await idle(session.id);
  expect(ran(session.id)).toHaveLength(before);
  expect(toAgent).toHaveLength(1);
  expect(toParent).toHaveLength(1);
});

test("a red found while the agent waits on its own is told at its next step, or to its parent when it ends first", async () => {
  const { session, write } = repo({ "lib.sh": "x=1\n", "lib.test.sh": '. ./lib.sh; [ "$x" = 1 ] || { echo "error: x is $x"; exit 1; }\n' });
  toAgent.length = toParent.length = 0;
  state.set(session.id, "parked");
  write("lib.sh", "x=2\n");
  step(session);
  await idle(session.id);
  expect(toAgent).toHaveLength(0);
  expect(laneOf(session.id)!.owed).not.toBeNull();
  // It works again: its next call is where it is told.
  state.set(session.id, "working");
  afterCall(store.session(session.id)!, { id: "r", tool: { kind: "read" } } as any);
  for (let i = 0; i < 100 && !toAgent.length; i++) await Bun.sleep(10);
  expect(toAgent.map((t) => t.text.includes("error: x is 2"))).toEqual([true]);
  expect(toParent).toHaveLength(0);
});

test("the copy of the files goes when the agent's turn ends with nothing running or waiting", async () => {
  const { session, write } = repo({ "lib.sh": "x=1\n", "lib.test.sh": "exit 0\n" });
  write("lib.sh", "x=2\n");
  step(session); // runs within the turn
  await idle(session.id);
  expect(existsSync(copyOf(session.id))).toBe(true);
  afterTurn(store.session(session.id)!);
  for (let i = 0; i < 200 && existsSync(copyOf(session.id)); i++) await Bun.sleep(10);
  expect(existsSync(copyOf(session.id))).toBe(false);
});

// (Skipped where the sandbox, bubblewrap, cannot start: it is what hides a folder from the run.)
test.skipIf(!sandboxStatus().available)("in the sandbox the run reads the installed packages its copy links to, wherever they are", async () => {
  // The repository's packages folder is a link to a folder out of every place the session reaches.
  const pkgs = mkdtempSync(join(dir, "pkgs-"));
  writeFileSync(join(pkgs, "v"), "ok\n");
  const { top, session, write } = repo({ "lib.sh": "x=1\n", "lib.test.sh": '[ "$(cat node_modules/v)" = ok ] || { echo "error: no packages"; exit 1; }\n' }, { inputs: ["node_modules"] });
  symlinkSync(pkgs, join(top, "node_modules"));
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "workspace-write" });
  write("lib.sh", "x=2\n");
  step(session);
  await idle(session.id, 60_000);
  expect(ofSession(session.id).filter((r) => r.by === "beside").map((r) => r.result)).toEqual(["pass"]);
});

test("a run Keel made beside an agent is never what says a check is red on the base too", async () => {
  const { top, session, write } = repo({ "lib.sh": "x=1\n", "lib.test.sh": "exit 0\n" });
  const r = repoOf(top)!;
  const base = (await treeOf(r))!;
  const row = (by: string, tree: string, result: "pass" | "fail") => record({ name: "unit", command: "sh t.sh ./lib.test.sh", dir: ".", repo: r.scope, tree, head: base.head, session_id: session.id, call_id: null, by, result, exit: result === "pass" ? 0 : 1, pass: null, fail: null, started: Date.now() - 10, ended: Date.now(), log: null, from_run: null, inputs: null, top: r.top } as any)!;
  // Keel's own run on the base's tree was red (its copy or its sandbox, not the base).
  row("beside", base.tree!, "fail");
  write("lib.sh", "x=2\n");
  const mine = row("session", (await treeOf(r))!.tree!, "fail");
  expect(await baseFor(mine, r)).not.toContain("red on");
  // The session's own run on the base is evidence.
  row("session", base.tree!, "fail");
  expect(await baseFor(mine, r)).toContain("red on");
  expect(keyOf(".", "sh t.sh ./lib.test.sh")).toBeTruthy();
});
