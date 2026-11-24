import { expect, test } from "bun:test";
import { closest, pathsIn, rank, sharedFiles, words } from "./earlier-rank.ts";

const BRIEF = "Read the brief first and follow it exactly. Scratch daemons only. One commit per row in your worktree.";
const doc = (title: string, text: string, files?: string[]) => ({ title, text: `${BRIEF} ${text}`, ...(files ? { files } : {}) });

const landed = doc("Leftovers: remove only Keel-made", "When an agent ends, stop and list what it leaves behind: jobs, worktrees, branches. Remove only a worktree Keel made and recorded (FIND-M13).");
const refused = doc("Waiting agents give the slot back", "An agent that waits on a timer gives its slot back and its cache plan is kept. Rows FIND-M11 and FIND-M21.");
const unrelated = doc("Sidebar rows redesign", "The session list in the sidebar shows a row for each folder; redesign its top bar at 1920x1040 in both themes (UI-M31).");

test("the closest earlier agents are the related ones, never the unrelated one", () => {
  const query = doc("Leftovers when an agent ends", "Make the leftovers of an agent's worktree and branches visible when it ends; remove what Keel made. Also its slot when it waits.");
  const got = closest(query, [unrelated, landed, refused]);
  expect(got.map((g) => g.index)).toEqual([1, 2]);
  expect(got[0]!.score).toBeGreaterThan(got[1]!.score);
});

test("words every brief shares weigh nothing", () => {
  const docs = [doc("A", "alpha"), doc("B", "beta"), doc("C", "gamma")];
  const s = rank(doc("Z", "delta"), docs);
  expect(s.every((x) => x.score < 0.2)).toBe(true);
});

test("a backlog row's id is a strong match", () => {
  const a = doc("Fix the thing", "the work of FIND-M17 in the spawn");
  const b = doc("Fix the other thing", "the work of FIND-M18 in the spawn");
  const [x, y] = rank(doc("Build it", "FIND-M17"), [a, b]);
  expect(x!.score).toBeGreaterThan(y!.score);
  expect(x!.words).toContain("find-m17");
});

test("plural and ending forms meet", () => {
  expect(words("leftovers waiting matches queues")).toEqual(["leftover", "wait", "match", "queue"]);
});

test("a file the task names and an earlier agent touched raises the score", () => {
  const query = doc("Change it", "Edit src/engine/turn.ts and src/tools/spill.ts so long output spills");
  const plain = [doc("One", "other words entirely"), doc("Two", "other words entirely")];
  const withFile = [doc("One", "other words entirely", ["src/engine/turn.ts"]), doc("Two", "other words entirely")];
  expect(rank(query, withFile)[0]!.score).toBeGreaterThan(rank(query, plain)[0]!.score);
  expect(rank(query, withFile)[0]!.files).toEqual(["src/engine/turn.ts"]);
  expect(rank(query, withFile)[1]!.files).toEqual([]);
});

test("paths in a task, and which of them an agent touched", () => {
  expect(pathsIn("see src/a/b.ts, and `ui/x.css`; not http://example.com/y.html or README.md")).toEqual(["src/a/b.ts", "ui/x.css", "README.md"]);
  expect(sharedFiles(["b.ts", "src/c.ts"], ["src/a/b.ts", "src/c.ts"])).toEqual(["src/a/b.ts", "src/c.ts"]);
  expect(sharedFiles(["d.ts"], ["src/a/b.ts"])).toEqual([]);
});

test("at most three, best first, and none when nothing is close", () => {
  const near = ["alpha beta gamma delta", "alpha beta gamma", "alpha beta", "alpha beta gamma delta epsilon"].map((t) => doc(t, t));
  expect(closest(doc("alpha beta gamma delta epsilon", "alpha beta gamma delta epsilon"), near, { bar: 0.05 })).toHaveLength(3);
  expect(closest(doc("x", "zebra"), near)).toEqual([]);
  expect(closest(doc("x", "zebra"), [])).toEqual([]);
});
