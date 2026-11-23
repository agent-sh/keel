import { expect, test } from "bun:test";
import { branchHolds, leftLine, newSince, ownTreeFate, parseWorktrees, processFate, treeHolds } from "./leftover-rules.ts";

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
