import { expect, test } from "bun:test";
import { attachedWhy, BUILD_IDLE_MS, branchHolds, buildKind, candidatesOf, landedPass, recordOf, leftLine, newSince, nextIdle, ownTreeFate, parseWorktrees, processFate, SCOPE_IDLE_MS, scopeFate, sharedKind, treeHolds } from "./leftover-rules.ts";

test("worktree list porcelain: main first, branches, detached and locked", () => {
  const t = parseWorktrees("worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD bbb\nbranch refs/heads/feat/x\nlocked\n\nworktree /r-d\nHEAD ccc\ndetached\n");
  expect(t).toEqual([
    { path: "/r", head: "aaa", branch: "main", main: true },
    { path: "/r-wt", head: "bbb", branch: "feat/x", main: false, locked: true },
    { path: "/r-d", head: "ccc", main: false },
  ]);
});

test("what is new since the agent started: not there before, not the main checkout, not Keel's own for it", () => {
  const trees = parseWorktrees("worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /r-new\nHEAD b\nbranch refs/heads/new\n\nworktree /r-old\nHEAD d\nbranch refs/heads/old\n\nworktree /r-own\nHEAD e\nbranch refs/heads/keel/own\n");
  const before = { worktrees: ["/r", "/r-old"], branches: { main: "a", old: "d", moved: "x" } };
  const heads = { main: "a", new: "b", old: "d", moved: "y", "keel/own": "e", tmp: "f" };
  const fresh = newSince(before, trees, heads, { trees: new Set(["/r-own"]), branches: new Set(["keel/own"]) });
  expect(fresh.trees.map((t) => t.path)).toEqual(["/r-new"]);
  // A branch that was there and moved is not new.
  expect(fresh.branches).toEqual(["new", "tmp"]);
});

test("a process is stopped unless another process is connected to its port", () => {
  expect(processFate({ job: "b1", command: "sleep 300", pids: [10], ports: [], clients: 0 })).toEqual({ act: "stop" });
  expect(processFate({ job: "b2", command: "serve", pids: [11], ports: [8080], clients: 2 })).toEqual({ act: "keep", why: "2 connections of another process to port 8080" });
});

test("Keel's own worktree goes only when nothing in it would be lost; what else is found is described, never decided", () => {
  expect(ownTreeFate({ dirty: 0, unique: 0 })).toEqual({ act: "remove" });
  // Its ignored files go with it, as they always have (build output, what .worktreeinclude copied in).
  expect(ownTreeFate({ dirty: 0, unique: 0, ignored: ["node_modules/"] })).toEqual({ act: "remove" });
  expect(ownTreeFate({ dirty: 2, unique: 0 })).toEqual({ act: "keep", why: "2 uncommitted files" });
  expect(ownTreeFate({ dirty: 0, unique: 1 })).toEqual({ act: "keep", why: "1 commit on no other branch" });
  expect(ownTreeFate({ dirty: 0, unique: 0, busy: "a process works in it: pid 7 (vim)" })).toEqual({ act: "keep", why: "a process works in it: pid 7 (vim)" });
  expect(ownTreeFate({ dirty: 0, unique: 0, inner: "a repository inside it holds work of its own (sub)" }).act).toBe("keep");
  expect(ownTreeFate({ dirty: 0, unique: 0, unknown: "x" }).act).toBe("keep");
  expect(treeHolds({ dirty: 0, unique: 0 })).toBe("nothing uncommitted, no commit of its own");
  expect(treeHolds({ dirty: 1, unique: 2, ignored: ["out/", "a.log", "b.log", "c.log"] })).toBe("1 uncommitted file, 2 commits on no other branch, 4 ignored paths (out/, a.log, b.log, ...)");
  expect(branchHolds({ unique: 0 })).toBe("every commit on another branch");
  expect(branchHolds({ unique: 3, out: "/r-x" })).toBe("3 commits on no other branch, checked out in /r-x");
});

test("the report's one line names what was stopped and what is left, and nothing when nothing was left", () => {
  expect(leftLine({ stopped: [], kept: [], found: [] })).toBe("");
  const line = leftLine({
    stopped: [{ job: "b1", command: "python3 -m http.server 48311", pids: [1], ports: [48311], clients: 0, left: [] }, { job: "b2", command: "sleep 300", pids: [2], ports: [], clients: 0 }],
    kept: [],
    found: [
      { kind: "worktree", repo: "/r", path: "/r-wt", name: "feat", holds: "1 commit on no other branch" },
      { kind: "branch", repo: "/r", name: "tmp", holds: "every commit on another branch" },
    ],
  });
  expect(line).toBe("Left behind: stopped `python3 -m http.server 48311` on port 48311, `sleep 300`; new in its repositories since it started, not removed (who made them is not known; Settings, Leftovers removes them): worktree /r-wt (branch feat: 1 commit on no other branch), branch tmp in /r (every commit on another branch).");
  expect(line.split("\n")).toHaveLength(1);
  const kept = leftLine({ stopped: [], kept: [{ job: "b3", command: "serve", pids: [3], ports: [80], clients: 1, why: "a connection of another process to port 80" }], found: [], units: ["web.service", ""] });
  expect(kept).toBe("Left behind: left running `serve` on port 80 (a connection of another process to port 80), which runs until stopped from Settings, Leftovers; its commands name systemd unit web.service (systemd-run), which Keel neither tracks nor stops (systemctl --user stop web.service); its commands start a systemd unit with no name (systemd-run), which Keel neither tracks nor stops.");
});

test("Keel's own scratch worktrees (a fails-before run's, the landing queue's) are never an agent's leftovers", () => {
  const trees = parseWorktrees("worktree /r\nHEAD a\nbranch refs/heads/main\n\nworktree /state/checks/before/12\nHEAD b\ndetached\n\nworktree /state/landing/ab12/batch-3\nHEAD c\ndetached\n\nworktree /state/checks/before-other\nHEAD d\ndetached\n");
  const fresh = newSince({ worktrees: ["/r"], branches: {} }, trees, {}, { trees: new Set(), branches: new Set(), under: ["/state/checks/before", "/state/landing/"] });
  // (A folder whose name only starts the same is not under one.)
  expect(fresh.trees.map((t) => t.path)).toEqual(["/state/checks/before-other"]);
});

test("a job scope left running: stopped once idle when its session ended, its build daemons when the session ends or they idle", () => {
  const min = 60_000;
  const base = { clients: 0, ports: [], commandEnded: true, idleMs: 0, builds: [] };
  const gradle = { pid: 7, kind: "Gradle daemon", idleMs: 0 };
  // A live session keeps what its commands left, a build daemon until it idles for the bound.
  expect(scopeFate({ ...base, idleMs: 600 * min })).toEqual({ act: "keep", why: "its session lives" });
  expect(scopeFate({ ...base, builds: [{ ...gradle, idleMs: BUILD_IDLE_MS - min }] }).act).toBe("keep");
  expect(scopeFate({ ...base, builds: [{ ...gradle, idleMs: BUILD_IDLE_MS }] })).toEqual({ act: "stop-builds", pids: [7], why: "its Gradle daemon built nothing for 30 min" });
  // One whose command still runs is the command's: its build daemon is not touched.
  expect(scopeFate({ ...base, commandEnded: false, builds: [{ ...gradle, idleMs: 10 * BUILD_IDLE_MS }] }).act).toBe("keep");
  // An ended session: build daemons go at once, the rest once idle.
  expect(scopeFate({ ...base, ended: "its agent ended", builds: [gradle] })).toEqual({ act: "stop-builds", pids: [7], why: "its agent ended: its Gradle daemon served only its builds" });
  expect(scopeFate({ ...base, ended: "its agent ended", idleMs: SCOPE_IDLE_MS - min })).toEqual({ act: "keep", why: "its agent ended; it is stopped once idle for 10 min" });
  expect(scopeFate({ ...base, ended: "its session is archived", idleMs: SCOPE_IDLE_MS })).toEqual({ act: "stop", why: "its session is archived, and it used no processor for 10 min" });
  // What always stays: the owner's mark, the owner's terminal, a scope this daemon runs in, a server in use.
  const done = { ...base, ended: "its session is gone", idleMs: 10 * SCOPE_IDLE_MS, builds: [gradle] };
  expect(scopeFate({ ...done, keep: true })).toEqual({ act: "keep", why: "you keep it" });
  expect(scopeFate({ ...done, owner: true }).act).toBe("keep");
  expect(scopeFate({ ...done, self: true })).toEqual({ act: "keep", why: "this daemon runs in it" });
  expect(scopeFate({ ...done, clients: 1, ports: [5173] })).toEqual({ act: "keep", why: "a connection of another process to port 5173" });
});

test("build daemons by their command line; idle by the share of a core between samples", () => {
  expect(buildKind(["/usr/bin/java", "-Xmx2g", "-cp", "x.jar", "org.gradle.launcher.daemon.bootstrap.GradleDaemon", "9.6.1"])).toBe("Gradle daemon");
  expect(buildKind(["java", "-cp", "k.jar", "org.jetbrains.kotlin.daemon.KotlinCompileDaemon", "--daemon-runFilesPath", "/r"])).toBe("Kotlin daemon");
  expect(buildKind(["bazel(ws)", "-jar", "/home/u/.cache/bazel/_bazel_u/install/abc/A-server.jar"])).toBe("Bazel server");
  expect(buildKind(["/home/u/.cargo/bin/sccache"])).toBe("sccache server");
  expect(buildKind(["sccache", "rustc", "a.rs"])).toBeUndefined();
  expect(buildKind(["./gradlew", "build"])).toBeUndefined();
  let m = nextIdle(undefined, 1000, 0);
  expect(m.since).toBe(0);
  // 1.2 s of processor in a minute (2% of a core): idle goes on.
  m = nextIdle(m, 2200, 60_000);
  expect(m.since).toBe(0);
  // 30 s in a minute: at work, the count starts again.
  m = nextIdle(m, 32_200, 120_000);
  expect(m.since).toBe(120_000);
  // A counter that went back (another process under the same id) starts again.
  expect(nextIdle(m, 5, 180_000).since).toBe(180_000);
});

test("a scope is kept whole when a process in it is someone's: a terminal, or a parent outside that is not the command's", () => {
  const p = (pid: number, parent: number, o: { tty?: boolean; pty?: boolean } = {}) => ({ pid, parent, start: "9", tty: !!o.tty, pty: !!o.pty });
  const reapers = new Set([1, 50]);
  // The command (started by the daemon, 7), what it started, and an orphan the user manager (50) took.
  expect(attachedWhy([p(10, 7), p(11, 10), p(12, 50)], { pid: 10, start: "9" }, reapers)).toBeUndefined();
  expect(attachedWhy([p(11, 10), p(12, 1)], { pid: 10, start: "9" }, reapers)).toBeUndefined();
  // A shell moved in from a terminal emulator (300), an editor holding a terminal's end, a controlling terminal.
  expect(attachedWhy([p(12, 50), p(13, 300)], { pid: 10 }, reapers)).toBe("process 13 was put in it from outside (its parent 300 is not of the command)");
  expect(attachedWhy([p(12, 50, { pty: true })], { pid: 10 }, reapers)).toBe("process 12 in it has a terminal");
  expect(attachedWhy([p(11, 10, { tty: true })], { pid: 10 }, reapers)).toBe("process 11 in it has a terminal");
  // The command's pid given to another process is not the command.
  expect(attachedWhy([p(10, 7)], { pid: 10, start: "8" }, reapers)).toBe("process 10 was put in it from outside (its parent 7 is not of the command)");
});

test("a shared server keeps its scope: adb's, which every device tool talks to", () => {
  expect(sharedKind(["adb", "-L", "tcp:5037", "fork-server", "server", "--reply-fd", "4"])).toBe("adb server");
  expect(sharedKind(["/opt/android/platform-tools/adb", "-L", "tcp:5037", "fork-server", "server"])).toBe("adb server");
  expect(sharedKind(["adb", "devices"])).toBeUndefined();
  const facts = { ended: "its session is gone", clients: 0, ports: [5037], commandEnded: true, idleMs: SCOPE_IDLE_MS * 3, builds: [] };
  expect(scopeFate(facts).act).toBe("stop");
  expect(scopeFate({ ...facts, shared: "adb server" })).toEqual({ act: "keep", why: "its adb server is shared by other tools" });
  expect(scopeFate({ ...facts, attached: "process 13 in it has a terminal" })).toEqual({ act: "keep", why: "process 13 in it has a terminal: it is kept until you stop it" });
});

test("a branch whose whole work the base holds goes with its worktree; one landed with changes is kept and said", () => {
  const whole = { how: "whole", at: "abcdef0123456789" } as const;
  const earlier = { how: "earlier", at: "fedcba9876543210" } as const;
  const changed = { how: "changed", at: "0123456789abcdef", why: "its 2 commits are on the base by subject" } as const;
  expect(ownTreeFate({ dirty: 0, unique: 2, landed: whole })).toEqual({ act: "remove" });
  expect(ownTreeFate({ dirty: 0, unique: 2, landed: changed })).toEqual({ act: "keep", why: "2 commits on no other branch, landed as 0123456789 with changes (its 2 commits are on the base by subject)" });
  // Held by an older commit of the base, not its tip (reverted or edited since): its branch is kept.
  expect(ownTreeFate({ dirty: 0, unique: 1, landed: earlier })).toEqual({ act: "keep", why: "1 commit on no other branch, landed as fedcba9876, and the base's tip no longer holds its every line (reverted or edited since)" });
  // Nothing uncommitted is ever outweighed by a landing.
  expect(ownTreeFate({ dirty: 1, unique: 2, landed: whole }).act).toBe("keep");
  expect(ownTreeFate({ dirty: 0, unique: 0, busy: "a process works in it: pid 7 (vim)", landed: whole }).act).toBe("keep");
  // The page's landed pass: the branch goes only with a whole landing, and only a clean worktree on a branch is in it.
  expect(landedPass({ removable: true, branch: "b", landed: whole })).toBe("tree-and-branch");
  expect(landedPass({ removable: true, branch: "b", landed: changed })).toBe("tree");
  expect(landedPass({ removable: true, branch: "b", landed: earlier })).toBe("tree");
  expect(landedPass({ removable: false, branch: "b", landed: whole })).toBeUndefined();
  expect(landedPass({ removable: true, landed: whole })).toBeUndefined();
  expect(landedPass({ removable: true, branch: "b", missing: true, landed: whole })).toBeUndefined();
  expect(landedPass({ removable: true, branch: "b" })).toBeUndefined();
});

test("the landing record names a branch landed with changes only on what says it landed", () => {
  expect(recordOf({ commits: 2, matched: 2, newest: "c2" })).toEqual({ at: "c2", why: "its 2 commits are on the base by subject" });
  expect(recordOf({ commits: 3, matched: 1, newest: "c1" })).toBeUndefined();
  // One subject alone names no landing, a review's yes or not; two with a review do.
  expect(recordOf({ commits: 1, matched: 1, newest: "c1" })).toBeUndefined();
  expect(recordOf({ commits: 3, matched: 1, newest: "c1", reviewed: true })).toBeUndefined();
  expect(recordOf({ commits: 3, matched: 2, newest: "c1", reviewed: true })).toEqual({ at: "c1", why: "a review said land it, and 2 of its 3 commits are on the base by subject" });
  expect(recordOf({ commits: 3, matched: 0, reviewed: true })).toBeUndefined();
  expect(recordOf({ commits: 1, matched: 0, queued: "q" })).toEqual({ at: "q", why: "the landing queue landed it" });
  // The commits worth a merge: the queue's first, then those of the branch's subjects, newest first, bounded.
  const log = [{ sha: "n3", subject: "b" }, { sha: "n2", subject: "x" }, { sha: "n1", subject: "a" }, { sha: "n0", subject: "a" }];
  expect(candidatesOf(log, new Set(["a", "b"]), "q")).toEqual(["q", "n3", "n1", "n0"]);
  expect(candidatesOf(log, new Set(["a", "b"]), undefined, 2)).toEqual(["n3", "n1"]);
});
