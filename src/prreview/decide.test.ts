import { expect, test } from "bun:test";
import { asksReview, commentable, DEFAULT_POLL_S, freshComments, LONG_WAIT_S, newHeads, nextLink, pace, parseRepo, reviewBody, type Pull } from "./decide.ts";

test("a repository is owner/name, or its GitHub address", () => {
  expect(parseRepo("agent-sh/keel")).toBe("agent-sh/keel");
  expect(parseRepo(" https://github.com/agent-sh/keel.git ")).toBe("agent-sh/keel");
  for (const bad of ["keel", "a/b/c", "-x/y", "a/..", "a b/c", ""]) expect([bad, parseRepo(bad)]).toEqual([bad, null]);
});

test("a comment asks for a review when its first line starts with the trigger", () => {
  expect(asksReview("@keel review", "@keel review")).toBe(true);
  expect(asksReview("  @Keel Review please look at the parser\nthanks", "@keel review")).toBe(true);
  expect(asksReview("@keel reviewer", "@keel review")).toBe(false);
  expect(asksReview("Thanks!\n@keel review", "@keel review")).toBe(false);
  expect(asksReview("we should @keel review this", "@keel review")).toBe(false);
  expect(asksReview("@keel review", "  ")).toBe(false);
});

test("the pace is the interval GitHub states, never shorter, and its limits are obeyed", () => {
  const now = 1_000_000;
  const h = (o: Record<string, string>) => new Headers(o);
  expect(pace(304, h({ "x-poll-interval": "90" }), now)).toEqual({ next_ms: now + 90_000 });
  expect(pace(200, h({}), now)).toEqual({ next_ms: now + DEFAULT_POLL_S * 1000 });
  // retry-after wins over a shorter interval; a secondary limit with no header doubles from a minute.
  expect(pace(403, h({ "retry-after": "120", "x-poll-interval": "60" }), now).next_ms).toBe(now + 120_000);
  expect(pace(429, h({}), now, 0).next_ms).toBe(now + 60_000);
  expect(pace(429, h({}), now, 2).next_ms).toBe(now + 240_000);
  // The hourly limit used up: nothing before its reset.
  const reset = (now + 600_000) / 1000;
  expect(pace(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }), now).next_ms).toBe(reset * 1000);
  // A missing repository or refused credentials are asked again much later.
  expect(pace(404, h({}), now).next_ms).toBe(now + LONG_WAIT_S * 1000);
  expect(pace(401, h({}), now).why).toContain("credentials");
});

test("the next page comes from the Link header", () => {
  expect(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe("https://api.github.com/x?page=2");
  expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBe(null);
  expect(nextLink(null)).toBe(null);
});

const pull = (number: number, head: string, draft = false): Pull => ({ number, head: head.repeat(40).slice(0, 40), draft, title: "t", base: "main", url: "", author: "a", clone_url: "" });
test("a new head of a ready pull request is reviewed; what was open at the start is only remembered", () => {
  const seen = new Map([[1, "a".repeat(40)], [2, "b".repeat(40)]]);
  const list = [pull(1, "a"), pull(2, "c"), pull(3, "d"), pull(4, "e", true)];
  expect(newHeads(list, seen, false).map((p) => p.number)).toEqual([2, 3]);
  expect(newHeads(list, new Map(), true)).toEqual([]);
});

test("comments newer than the last handled, and whether the page reached it", () => {
  const c = (id: number) => ({ id, pr: 1, body: "", association: "OWNER", author: "o", url: "" });
  expect(freshComments([c(9), c(8), c(5)], 7)).toEqual({ fresh: [c(9), c(8)], reached: true });
  expect(freshComments([c(9), c(8)], 7)).toEqual({ fresh: [c(9), c(8)], reached: false });
  expect(freshComments([], 7)).toEqual({ fresh: [], reached: true });
});

const DIFF = [
  "diff --git a/calc.py b/calc.py",
  "index 1..2 100644",
  "--- a/calc.py",
  "+++ b/calc.py",
  "@@ -1,3 +1,4 @@",
  " def div(a, b):",
  "-    return a / b",
  "+    return a // b",
  "+    # more",
  " ",
  "@@ -20,2 +21,2 @@ def avg(xs):",
  "-    x = 1",
  "+    x = 2",
  " end",
  "diff --git a/gone.txt b/gone.txt",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
].join("\n");

test("comments go only on the new side of the diff's hunks", () => {
  expect(commentable(DIFF)).toEqual({ "calc.py": [[1, 4], [21, 22]] });
});

test("a review is a COMMENT with findings on their lines and the rest in its body", () => {
  const f = (id: number, file: string, line: number, end_line?: number, state: "open" | "dismissed" = "open") => ({ id, file, line, end_line, priority: 1 as const, title: `t${id}`, body: `b${id}`, state });
  const r = reviewBody({ findings: [f(1, "calc.py", 2), f(2, "calc.py", 3, 4), f(3, "calc.py", 10), f(4, "calc.py", 2, undefined, "dismissed")], summary: "S.", verdict: "incorrect" }, commentable(DIFF), "f".repeat(40));
  expect(r.event).toBe("COMMENT");
  expect(r.commit_id).toBe("f".repeat(40));
  expect(r.comments).toEqual([
    { path: "calc.py", line: 2, side: "RIGHT", body: "**P1** t1\n\nb1" },
    { path: "calc.py", line: 4, start_line: 3, start_side: "RIGHT", side: "RIGHT", body: "**P1** t2\n\nb2" },
  ]);
  expect(r.body).toContain("3 findings, 2 on the lines. Has problems.");
  expect(r.body).toContain("`calc.py:10` t3");
  expect(r.body).not.toContain("t4");
});
