import { expect, test } from "bun:test";
import type { RepoFacts } from "./autonomy.ts";
import { namedPlaces, settleOwn, shapeOf, type OwnPlace, type PartRisk } from "./own-places.ts";
import { precisionOf } from "./precision.ts";
import { splitCommand } from "./shell.ts";

const H = "/h";

test("a folder is the reader's own only where the words name it so", () => {
  const task = [
    "Scratch dir /h/.cache/work/lanes/W2-U3/. Report per the brief.",
    "(scratch dir /h/.cache/work/lanes/L01/; keep it small)",
    "Your scratch folder: ~/.cache/audit-2/ (the earlier audit used ~/.cache/audit-1/: do not reuse it).",
    "Use ~/.cache/audit-follow2/ for everything.",
    "The audit report with its evidence paths is /h/.cache/work/audits/ui.md.",
    "Scratch files go under ~/.cache/work/lanes/<TASK-ID>/, never /tmp.",
    "Scratch dir ~/.ssh/keys and scratch dir ~ and scratch: /h/.cache and scratch dir /usr/local/share.",
  ].join("\n");
  expect(namedPlaces(task, H).sort()).toEqual(["/h/.cache/audit-2", "/h/.cache/audit-follow2", "/h/.cache/work/lanes/L01", "/h/.cache/work/lanes/W2-U3"]);
});

const facts = (dirty: number | null, untracked: number | null, root = "/h/wt"): RepoFacts => ({
  root, branch: "keel/x", upstream: null, remotes: {}, defaultOf: () => null, dirty: () => dirty, untracked: () => untracked, merged: () => null,
});
const own: OwnPlace[] = [{ path: "/h/wt", from: "worktree" }, { path: "/h/.cache/lane", from: "parent" }];
const settle = (command: string, look: (dir: string) => RepoFacts | null, risks?: PartRisk[]) => {
  const parts = splitCommand(command)!;
  const at = risks ?? parts.map((_, i) => i).filter((i) => /\bgit\b.*\b(reset|checkout|clean|worktree)\b/.test(parts[i]!.text)).map((i) => ({ at: i, rule: "destroys" as const, why: "discards uncommitted work" }));
  return settleOwn({ parts, risks: at, cwd: "/h/wt", home: H, places: own, look });
};

test("a discard in the session's own folders is settled by what it would lose", () => {
  // Nothing to lose: settled. A hard reset leaves untracked files.
  expect(settle("git reset --hard origin/main", () => facts(0, 1))).toMatchObject({ allow: expect.stringContaining("no uncommitted tracked change") });
  expect(settle("git fetch -q origin main && git reset -q --hard origin/main", () => facts(0, 3))).toMatchObject({ allow: expect.any(String) });
  // Something to lose: refused, with the way to save it.
  const lost = settle("git checkout w2-final -- .", () => facts(13, 0));
  const deny = lost && "deny" in lost ? lost.deny : "";
  expect(lost && "lost" in lost ? lost.lost : 0).toBe(13);
  expect(deny).toContain("13 uncommitted tracked changes");
  expect(deny).toContain("commit them, or write a patch");
  expect(settle("git -C /h/.cache/lane/base worktree remove --force /h/.cache/lane/base", (d) => facts(0, 2, d))).toMatchObject({ lost: 2 });
  expect(settle("git worktree remove --force /h/.cache/lane/base", (d) => facts(0, 0, d))).toMatchObject({ allow: expect.stringContaining("nothing uncommitted") });
  // A checkout of some paths with changes elsewhere: the count is not what it loses, so the judge reads it.
  expect(settle("git checkout HEAD -- src/a/", () => facts(4, 0))).toBeNull();
});

test("what Keel's facts cannot show is left to the judge", () => {
  // Outside the session's own folders.
  expect(settle("cd /h/other && git reset --hard", () => facts(0, 0, "/h/other"))).toBeNull();
  // A line that changes files before the discard, with nothing to lose now.
  expect(settle("python3 fix.py && git checkout -- .", () => facts(0, 0))).toBeNull();
  // git cannot say.
  expect(settle("git reset --hard", () => facts(null, 0))).toBeNull();
  expect(settle("git reset --hard", () => null)).toBeNull();
  // Another reason the rules flagged it, or the line as a whole.
  expect(settle("git reset --hard", () => facts(0, 0), [{ at: 0, rule: "remote", why: "x" }])).toBeNull();
  expect(settle("git reset --hard", () => facts(0, 0), [{ at: null, rule: "destroys", why: "x" }])).toBeNull();
  // A delete that is not one of git's discards.
  expect(settle("rm -rf build", () => facts(0, 0), [{ at: 0, rule: "destroys", why: "deletes build" }])).toBeNull();
});

test("the shape of a call folds what changes between runs", () => {
  const places = ["/h/wt", "/h/.cache/lane"];
  expect(shapeOf("Bash", "cd /h/wt && git reset --hard 1a2b3c4d", places)).toBe(shapeOf("Bash", "cd /h/wt  && git reset --hard 9f8e7d6c5b", places));
  expect(shapeOf("Bash", "git reset --hard x", places)).not.toBe(shapeOf("Bash", "git checkout -- .", places));
});

test("precision is the share of refusals the owner left standing", () => {
  const p = precisionOf([
    { day: "2026-11-22", by: "judge", class: "destroys", place: "own", decision: "deny", n: 4, taken_back: 1 },
    { day: "2026-11-22", by: "judge", class: "ordinary", place: "own", decision: "allow", n: 6, taken_back: 0 },
    { day: "2026-11-23", by: "rule", class: "destroys", place: "own", decision: "deny", n: 2, taken_back: 0 },
  ], 0);
  expect(p.total).toMatchObject({ reviewed: 12, refused: 6, taken_back: 1, precision: 5 / 6 });
  expect(p.days.map((d) => d.key)).toEqual(["2026-11-23", "2026-11-22"]);
  expect(p.classes.find((c) => c.key === "judge:ordinary:own")!.precision).toBeNull();
  expect(p.classes[0]!.key).toBe("judge:destroys:own");
});
