// The fails-before run on a real repository: what a test leaves running does not hold the run, and the run is
// confined by the session's own sandbox profile.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Gate } from "../safety/gate.ts";
import { sandboxStatus } from "../safety/sandbox.ts";
import { overlays } from "../safety/sandbox-view.ts";
import { Worktrees } from "../worktree/manager.ts";
import { bindBefore, leftScopes, runOne, settled, startFor } from "./before-run.ts";
import { beforeLine } from "./before.ts";
import { bindLedger } from "./ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-before-run-"));
const store = new Store(join(dir, "state"));
new Worktrees(store, join(dir, "worktrees")); // its table: the base is read from it
bindLedger(store);
const gate = new Gate(store, new Bus(), (_s, p) => p.sandbox !== "off" && sandboxStatus().available);
bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool, shown) => gate.confineFor(id, ws, tool, shown), capture: (e) => { throw e; } });

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
// Stopped: gone, or a zombie its new parent has not reaped yet (on a loaded machine that takes a moment), within a few seconds.
const stopped = async (pid: number) => {
  for (const end = Date.now() + 3_000; Date.now() < end; await Bun.sleep(50)) {
    if (!alive(pid)) return true;
    try { if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return true; } catch { return true; }
  }
  return false;
};

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
  expect(await stopped(Number(readFileSync(`${pids}.a`, "utf8")))).toBe(true);
  const b = Number(readFileSync(`${pids}.b`, "utf8"));
  if (sandboxStatus().scope) expect(await stopped(b)).toBe(true);
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
  await bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool, shown) => gate.confineFor(id, ws, tool, shown), capture: (e) => { throw e; } });
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

// A run's tool folder a killed daemon left can hold an overlay's work folder the kernel made with no access:
// the next start removes it all the same, and the folders after it.
test("a cut run's overlay layers are removed at the next start", async () => {
  const base = join(store.stateDir, "checks", "before");
  const work = join(base, "999998.tool", "layers", "0", "work", "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(base, "999998.tool", "layers", "0", "work", "x"), "x");
  chmodSync(work, 0o000);
  mkdirSync(join(base, "999999.tool"), { recursive: true });
  await bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool, shown) => gate.confineFor(id, ws, tool, shown), capture: (e) => { throw e; } });
  expect([existsSync(join(base, "999998.tool")), existsSync(join(base, "999999.tool"))]).toEqual([false, false]);
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
  await bindBefore({ store, bus: new Bus(), perm: (id) => gate.perm(id), confine: (id, ws, tool, shown) => gate.confineFor(id, ws, tool, shown), capture: (e) => { throw e; } });
  expect(await Promise.race([left.exited.then(() => true), Bun.sleep(5_000).then(() => false)])).toBe(true);
  expect(active()).toBe(false);
});

// A package project whose base declares a dependency (installed from its lockfile in the main checkout), and an
// agent's worktree without the packages that adds a test of a fix: the test imports the dependency and fails on
// the base by its assertion. `extra`: more files of the agent's.
// `count`: a file each install of the packages adds a line to (the package's own postinstall); `post`: more of
// the postinstall, and `ignored`: more of .gitignore.
function pkgRepo(extra: Record<string, string> = {}, count?: string, post = "", ignored = "") {
  const top = mkdtempSync(join(dir, "pkg-"));
  const g = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  g(top, "init", "-q", "-b", "main");
  mkdirSync(join(top, ".keel"));
  writeFileSync(join(top, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "bun test", args: true, inputs: ["node_modules"], tests: ["*.test.ts"] } } }));
  mkdirSync(join(top, "vendor", "dep"), { recursive: true });
  writeFileSync(join(top, "vendor", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(top, "vendor", "dep", "index.js"), "module.exports = { twice: (n) => n * 2 };\n");
  writeFileSync(join(top, "package.json"), JSON.stringify({ name: "p", dependencies: { dep: "file:./vendor/dep" }, ...(count ? { scripts: { postinstall: `echo x >> ${count}${post}` } } : {}) }));
  writeFileSync(join(top, ".gitignore"), `node_modules\n${ignored}`);
  writeFileSync(join(top, "lib.ts"), "export const add = (a: number, b: number) => a - b;\n");
  expect(Bun.spawnSync(["bun", "install"], { cwd: top, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  g(top, "add", "-A");
  g(top, "commit", "-qm", "base");
  const { wt, session } = agentOf(top, extra);
  return { top, wt, session, g: (...args: string[]) => g(top, ...args) };
}
// An agent's worktree of the repository's main, with a test of a fix (and `extra`).
let agents = 0;
function agentOf(top: string, extra: Record<string, string> = {}) {
  const wt = `${top}-agent-${++agents}`;
  Bun.spawnSync(["git", "worktree", "add", "-q", "-b", `fix-${agents}`, wt], { cwd: top });
  writeFileSync(join(wt, "lib.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(join(wt, "add.test.ts"), 'import { expect, test } from "bun:test";\nimport { twice } from "dep";\nimport { add } from "./lib.ts";\ntest("add", () => expect(twice(add(1, 2))).toBe(6));\n');
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(wt, f), text);
  const session = store.createSession({ model: "m:x", workspace: wt, title: "before" });
  gate.setPerm(session.id, { mode: "full-auto", sandbox: "off" });
  return { wt, session };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
const cached = () => { try { return readdirSync(join(store.stateDir, "checks", "packages")).filter((n) => !n.includes(".")); } catch { return []; } };

test("a test of a package the base declares runs on the base with its packages, linked from a checkout of the same lockfile", async () => {
  const { top, wt, session } = pkgRepo();
  expect(existsSync(join(wt, "node_modules"))).toBe(false); // the agent's worktree has none of its own
  const r = await settled((await startFor(session.id, wt))!, 60_000);
  expect(r.results.map((f) => [f.path, f.state, f.why])).toEqual([["add.test.ts", "fails", "1 of 1 failed"]]);
  // The link is the run's: the main checkout's packages are still there, and the scratch checkout is gone.
  expect(existsSync(join(top, "node_modules", "dep", "index.js"))).toBe(true);
  expect(readdirSync(join(store.stateDir, "checks", "before")).filter((n) => !n.endsWith(".tool"))).toEqual([]);
});

test("with no installed packages of the base's lockfile, the base's own install runs in the scratch checkout", async () => {
  const { top, wt, session } = pkgRepo();
  renameSync(join(top, "node_modules"), join(top, "node_modules.away"));
  const r = await settled((await startFor(session.id, wt))!, 120_000);
  expect(r.results.map((f) => [f.path, f.state, f.why])).toEqual([["add.test.ts", "fails", "1 of 1 failed"]]);
  expect(existsSync(join(top, "node_modules"))).toBe(false);
});

test("a package only the change adds does not load on the base: that is a failure before", async () => {
  const { session, wt } = pkgRepo({ "new.test.ts": 'import { test } from "bun:test";\nimport x from "brand-new-dep";\ntest("x", () => x());\n' });
  const r = await settled((await startFor(session.id, wt))!, 60_000);
  const n = r.results.find((f) => f.path === "new.test.ts")!;
  expect(n.state).toBe("fails");
  expect(n.why).toContain("it does not load without the change: Cannot find");
  expect(n.why).toContain("brand-new-dep");
});

test("the scopes a start stops are those of daemons that are gone", () => {
  const out = ["keel-before-100-3-0.scope loaded active running keel-before-100-3-0.scope", "  keel-before-200-1-2.scope loaded active running x", "keel-other-1.scope loaded active running y", ""].join("\n");
  expect(leftScopes(out, (pid) => pid === 200)).toEqual(["keel-before-100-3-0.scope"]);
});

test("the base's install runs once for a lockfile: later reports link the kept packages, a new lockfile installs again", async () => {
  const count = join(dir, "installs-cache");
  const { top, g } = pkgRepo({}, count);
  const away = () => renameSync(join(top, "node_modules"), join(top, `node_modules.${Date.now()}`));
  away(); // no installed packages match the base's lockfile
  const before = lines(count), entries = cached().length;
  const report = async () => {
    const { wt, session } = agentOf(top);
    const t0 = performance.now();
    const r = await settled((await startFor(session.id, wt))!, 120_000);
    return { results: r.results.map((f) => [f.path, f.state, f.why]), ms: Math.round(performance.now() - t0) };
  };
  const first = await report();
  expect(first.results).toEqual([["add.test.ts", "fails", "1 of 1 failed"]]);
  expect(lines(count) - before).toBe(1);
  expect(cached().length - entries).toBe(1);
  const second = await report();
  expect(second.results).toEqual([["add.test.ts", "fails", "1 of 1 failed"]]);
  expect(lines(count) - before).toBe(1); // linked: nothing installed
  // The kept packages are still there after the run (its scratch checkout went, and with it only the link).
  expect(cached().every((k) => existsSync(join(store.stateDir, "checks", "packages", k, "tree", "node_modules", "dep", "index.js")))).toBe(true);
  // A new lockfile on the base installs again.
  mkdirSync(join(top, "vendor", "two"), { recursive: true });
  writeFileSync(join(top, "vendor", "two", "package.json"), JSON.stringify({ name: "two", version: "1.0.0" }));
  writeFileSync(join(top, "package.json"), JSON.stringify({ name: "p", dependencies: { dep: "file:./vendor/dep", two: "file:./vendor/two" }, scripts: { postinstall: `echo x >> ${count}` } }));
  expect(Bun.spawnSync(["bun", "install"], { cwd: top, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
  away();
  g("add", "-A");
  g("commit", "-qm", "two");
  const after = lines(count);
  expect((await report()).results).toEqual([["add.test.ts", "fails", "1 of 1 failed"]]);
  expect(lines(count) - after).toBe(1);
  expect(cached().length - entries).toBe(2);
  console.log(`fails-before reports: first ${first.ms} ms (installed), second ${second.ms} ms (linked)`);
});

test("an install that failed is the answer for its lockfile for a while: the next report says so at once", async () => {
  const { top, g } = pkgRepo();
  renameSync(join(top, "node_modules"), join(top, "node_modules.away"));
  // The base's package.json names a package its lockfile does not have: a frozen install fails.
  writeFileSync(join(top, "package.json"), JSON.stringify({ name: "p", dependencies: { dep: "file:./vendor/dep", gone: "file:./vendor/gone" } }));
  g("add", "-A");
  g("commit", "-qm", "out of step");
  const a = agentOf(top);
  const r = await settled((await startFor(a.session.id, a.wt))!, 120_000);
  expect(r.results[0]).toMatchObject({ path: "add.test.ts", state: "unrun" });
  expect(r.results[0]!.why).toStartWith("the base's install failed: bun install --frozen-lockfile: ");
  // The same report again is the same answer, not a new run.
  expect((await startFor(a.session.id, a.wt))!.id).toBe(r.id);
  // Another agent's report on the same base: at once, from what is remembered.
  const b = agentOf(top);
  const t0 = performance.now();
  const r2 = await settled((await startFor(b.session.id, b.wt))!, 120_000);
  expect(r2.results[0]).toMatchObject({ path: "add.test.ts", state: "unrun", ms: null });
  expect(r2.results[0]!.why).toMatch(/^the base's install failed 1 min ago \(tried again 30 min after it, or now by Run again\): bun install/);
  expect(performance.now() - t0).toBeLessThan(10_000);
});

// An install that writes out of node_modules (a postinstall's generated file) is not kept: the next report would
// link the packages without the file. It installs for each report, and the line says so.
test("an install that writes out of its packages folders runs for each report, and is not kept", async () => {
  const count = join(dir, "installs-gen");
  const gen = { "gen.test.ts": 'import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("gen", () => expect(readFileSync("gen.txt", "utf8")).toBe("g\\n"));\n' };
  const { top } = pkgRepo(gen, count, " && echo g > gen.txt", "gen.txt\n");
  renameSync(join(top, "node_modules"), join(top, "node_modules.away"));
  const before = lines(count), entries = cached().length;
  const said: string[] = [];
  for (let n = 1; n <= 2; n++) {
    const { wt, session } = agentOf(top, gen);
    const r = await settled((await startFor(session.id, wt))!, 120_000);
    expect(r.results.map((f) => [f.path, f.state, f.why])).toEqual([["add.test.ts", "fails", "1 of 1 failed"], ["gen.test.ts", "passes", "1 passed"]]);
    expect(lines(count) - before).toBe(n);
    said.push(beforeLine({ mergeBase: r.merge_base, base: r.base, note: r.note, results: r.results }));
  }
  expect(cached().length).toBe(entries);
  for (const l of said) expect(l).toContain("without the change, with the base's packages installed for this run only (its install writes out of node_modules: gen.txt, so they are not kept): ");
});

// (Skipped where the sandbox, bubblewrap, cannot start.) The session's own sandbox does not show the main
// checkout's packages (they are in the machine's temp folder, which is the sandbox's own there): the install runs
// once, and the run writes into the kept packages in a layer of its own (where overlays mount): its test passes,
// and the kept packages are as they were. Without overlays they are read-only: the file could not run.
test.skipIf(!sandboxStatus().available)("in the sandbox what a run writes into the base's packages does not reach them", async () => {
  const w = { "w.test.ts": 'import { expect, test } from "bun:test";\nimport { mkdirSync, readFileSync, writeFileSync } from "node:fs";\ntest("w", () => { mkdirSync("node_modules/.cache", { recursive: true }); writeFileSync("node_modules/.cache/x", "x"); writeFileSync("node_modules/dep/made.txt", "x"); expect(readFileSync("node_modules/.cache/x", "utf8")).toBe("x"); });\n' };
  const { top, session, wt } = pkgRepo(w);
  gate.setPerm(session.id, { mode: "ask", sandbox: "workspace-write" });
  const r = await settled((await startFor(session.id, wt))!, 120_000);
  expect(r.unconfined).toBeNull();
  const w2 = overlays() ? ["w.test.ts", "passes", "1 passed"] : ["w.test.ts", "unrun", "the base's packages are read-only here: the test writes under node_modules"];
  expect(r.results.map((f) => [f.path, f.state, f.why])).toEqual([["add.test.ts", "fails", "1 of 1 failed"], w2]);
  // A second report links the kept packages: nothing the first wrote is there.
  const b = agentOf(top, w);
  gate.setPerm(b.session.id, { mode: "ask", sandbox: "workspace-write" });
  expect((await settled((await startFor(b.session.id, b.wt))!, 120_000)).results.map((f) => [f.path, f.state, f.why])).toEqual([["add.test.ts", "fails", "1 of 1 failed"], w2]);
  const kept = readdirSync(join(store.stateDir, "checks", "packages")).filter((n) => !n.includes("."));
  expect(existsSync(join(top, "node_modules", "dep", "made.txt"))).toBe(false);
  for (const k of kept) {
    expect(existsSync(join(store.stateDir, "checks", "packages", k, "tree", "node_modules", "dep", "made.txt"))).toBe(false);
    expect(existsSync(join(store.stateDir, "checks", "packages", k, "tree", "node_modules", ".cache"))).toBe(false);
  }
  // The run's layers went with its tool folder.
  expect(readdirSync(join(store.stateDir, "checks", "before"))).toEqual([]);
});
