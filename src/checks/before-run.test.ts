// The fails-before run on a real repository: what a test leaves running does not hold the run, and the run is
// confined by the session's own sandbox profile.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Gate } from "../safety/gate.ts";
import { sandboxStatus } from "../safety/sandbox.ts";
import { Worktrees } from "../worktree/manager.ts";
import { bindBefore, leftScopes, runOne, settled, startFor } from "./before-run.ts";
import { bindLedger } from "./ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-before-run-"));
const store = new Store(join(dir, "state"));
new Worktrees(store, join(dir, "worktrees")); // its table: the base is read from it
bindLedger(store);
const gate = new Gate(store, new Bus(), (_s, p) => p.sandbox !== "off" && sandboxStatus().available);
bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool) => gate.confineFor(id, ws, tool), capture: (e) => { throw e; } });

// A repository whose check runs one test file with `sh t.sh FILE`, and a session in it with `files` new.
function repo(files: Record<string, string>) {
  const top = mkdtempSync(join(dir, "repo-"));
  const g = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: top });
  g("init", "-q", "-b", "main");
  mkdirSync(join(top, ".keel"));
  writeFileSync(join(top, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "sh t.sh", args: true, tests: ["*.test.sh"] } } }));
  writeFileSync(join(top, "t.sh"), 'sh "$1"\n');
  g("add", "-A");
  g("commit", "-qm", "checks");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(top, f), text);
  return { top, session: store.createSession({ model: "m:x", workspace: top, title: "before" }) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("what a test leaves running, in its group or out of it, does not hold the run, and goes", async () => {
  const pids = join(dir, "pids");
  // A test that passes and leaves a sleep in its group, and one that leaves a sleep in a session of its own; both hold its output open.
  const { top, session } = repo({
    "a.test.sh": `sleep 60 & echo $! > ${pids}.a; exit 0\n`,
    "b.test.sh": `setsid sleep 60 & echo $! > ${pids}.b; exit 1\n`,
  });
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  const t0 = Date.now();
  const run = await startFor(session.id, top);
  const r = await settled(run!, 20_000);
  expect(r.state).toBe("done");
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(r.results.map((f) => [f.path, f.state])).toEqual([["a.test.sh", "passes"], ["b.test.sh", "fails"]]);
  expect(r.unconfined).toBe("the session runs in full auto with its sandbox off");
  // Its group goes at its end; a process that left the group goes with the run's scope, where the machine has them.
  expect(alive(Number(readFileSync(`${pids}.a`, "utf8")))).toBe(false);
  const b = Number(readFileSync(`${pids}.b`, "utf8"));
  if (sandboxStatus().scope) expect(alive(b)).toBe(false);
  else try { process.kill(b, "SIGKILL"); } catch {} // no scope here: the run did not wait for it all the same
});

// (Skipped where the sandbox, bubblewrap, cannot start: it is what confines the run.)
test.skipIf(!sandboxStatus().available)("the run is confined by the session's own profile: a read-only session's test cannot write its folder", async () => {
  const { top, session } = repo({ "w.test.sh": "echo x > made.txt\n" });
  gate.setPerm(session.id, { mode: "ask", sandbox: "read-only" });
  const r = await settled((await startFor(session.id, top))!, 60_000);
  expect(r.results[0]).toMatchObject({ path: "w.test.sh", state: "fails" });
  expect(r.unconfined).toBeNull();
  expect(r.results[0]!.why).toContain("Read-only file system");
  expect(existsSync(join(top, "made.txt"))).toBe(false);
});

test("a scratch worktree a killed daemon left goes at the next start, with its repository's entry for it", async () => {
  // (The folder a run starts from is often an agent's worktree, gone by then: the repository is found from the scratch worktree.)
  const { top } = repo({});
  const left = join(store.stateDir, "checks", "before", "999999");
  mkdirSync(join(store.stateDir, "checks", "before"), { recursive: true });
  Bun.spawnSync(["git", "worktree", "add", "-q", "--detach", left, "HEAD"], { cwd: top });
  const list = () => Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: top }).stdout.toString().split("\n").filter((l) => l.startsWith("worktree ")).length;
  expect(list()).toBe(2);
  await bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool) => gate.confineFor(id, ws, tool), capture: (e) => { throw e; } });
  expect(existsSync(left)).toBe(false);
  expect(list()).toBe(1);
});

// A daemon killed while a file runs outside the sandbox takes no timer with it: the file's scope has a limit of its
// own, and the next start stops a scope whose daemon is gone.
const scoped = sandboxStatus().scope;
test.skipIf(!scoped)("a file's scope ends by its own time limit, whatever happens to the daemon", async () => {
  const tool = mkdtempSync(join(dir, "tool-"));
  // The test passes when its own scope has a runtime limit (systemd says "infinity" when it has none).
  const command = `u=$(basename "$(cut -d: -f3 /proc/self/cgroup)"); v=$(systemctl --user show -p RuntimeMaxUSec --value "$u"); echo "$u $v"; [ -n "$v" ] && [ "$v" != infinity ]`;
  const r = await runOne({ cwd: tool, tool, env: { ...process.env } as Record<string, string>, command, limitMs: 120_000, unit: `keel-before-${process.pid}-0-limit` });
  expect(r.state).toBe("passes");
});

test.skipIf(!scoped)("a scope a killed daemon left is stopped at the next start, with what runs in it", async () => {
  const gone = Bun.spawn(["true"]);
  await gone.exited; // a daemon that is not there any more
  const unit = `keel-before-${gone.pid}-7-0`;
  const left = Bun.spawn(["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", "sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  const active = () => Bun.spawnSync(["systemctl", "--user", "is-active", `${unit}.scope`]).stdout.toString().trim() === "active";
  const t0 = Date.now();
  while (!active() && Date.now() - t0 < 5_000) await Bun.sleep(50);
  expect(active()).toBe(true);
  await bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool) => gate.confineFor(id, ws, tool), capture: (e) => { throw e; } });
  expect(await Promise.race([left.exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
  expect(active()).toBe(false);
});

test("the scopes a start stops are those of daemons that are gone", () => {
  const out = ["keel-before-100-3-0.scope loaded active running keel-before-100-3-0.scope", "  keel-before-200-1-2.scope loaded active running x", "keel-other-1.scope loaded active running y", ""].join("\n");
  expect(leftScopes(out, (pid) => pid === 200)).toEqual(["keel-before-100-3-0.scope"]);
});
