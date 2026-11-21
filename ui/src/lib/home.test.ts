import { expect, test } from "bun:test";
import { needs, pickRows, rowKind, say, sayMore, unseenFailures, watchSummary, wholeCommand } from "./home.ts";

test("the headline counts what the rows list: a held turn too, a failure until it was looked at", () => {
  const list = [{ id: "a", w: "need" }, { id: "b", w: "work" }, { id: "c", w: "fail" }, { id: "d", w: "fail" }, { id: "e", w: "resume" }, { id: "f", w: "done" }] as const;
  const s = watchSummary([...list], new Set(["c"]));
  expect(s.head.map((p) => say(p.w, p.ids.length))).toEqual(["1 needs you", "1 waits to resume", "1 failed", "1 working"]);
  expect(s.attention.map((r) => r.id)).toEqual(["a", "e", "c"]);
  expect(s.working.map((r) => r.id)).toEqual(["b"]);
  // Only a turn held after a restart: the headline says so, it never reads as nothing.
  const held = watchSummary([{ id: "e", w: "resume" }], new Set());
  expect(held.head.map((p) => p.w)).toEqual(["resume"]);
  expect(held.attention).toHaveLength(1);
  // Every failure looked at, nothing else: nothing to say, nothing listed.
  expect(watchSummary([{ id: "c", w: "fail" }, { id: "f", w: "done" }], new Set())).toEqual({ head: [], attention: [], working: [] });
  expect(say("need", 2)).toBe("2 need you");
  expect(say("resume", 2)).toBe("2 wait to resume");
});

test("Allow once is offered only for a command the row shows whole", () => {
  const shell = (command: string, o: object = {}) => ({ kind: "shell", risk: "low", summary: command, input: { command }, ...o });
  expect(wholeCommand(shell("rm -rf dist build"))).toBe("rm -rf dist build");
  // Long, many lines, high risk, or not a command: read on its card.
  expect(wholeCommand(shell(`python3 scripts/backfill.py ${"--table invoices ".repeat(14)}&& python3 scripts/drop_table.py --table invoices_legacy --yes`))).toBeNull();
  expect(wholeCommand(shell("for f in logs/*.log; do gzip $f; done\nrm -rf /var/archive/old"))).toBeNull();
  expect(wholeCommand(shell("git push --force", { risk: "high" }))).toBeNull();
  expect(wholeCommand({ kind: "edit", risk: "low", summary: "/w/a.ts", input: { file_path: "/w/a.ts" } })).toBeNull();
  // The row shows the summary: it must be the command itself, not a short form of it.
  expect(wholeCommand({ kind: "shell", risk: "low", summary: "npm test", input: { command: "npm test && rm -rf /" } })).toBeNull();
  expect(wholeCommand(undefined)).toBeNull();
  // A character that hides or reorders what is shown: a right-to-left override, a zero-width space, a tab.
  for (const odd of ["echo \u202Etxt.x > r.txt", "rm -rf di\u200Bst", "ls\t-la", "echo a\u2028b"]) expect(wholeCommand(shell(odd))).toBeNull();
  // Nor one that draws nothing or as a plain space, nor letters a renderer reorders: printable ASCII only.
  for (const odd of ["cp \u05d0 1 2 \u05d1 > \u05d2", "rm -rf a\u3164b", "ls a\ufe0f", "ls a\u034fb", "rm -rf a\u2800b", "rm -rf a\u00a0b", "rm -rf a\u3000b", "echo caf\u00e9"]) expect(wholeCommand(shell(odd))).toBeNull();
  expect(rowKind("need", { approval: { kind: "shell" } })).toBe("Command");
  expect(rowKind("need", { asking: true })).toBe("Question");
  expect(rowKind("fail", {})).toBe("Failed");
});

test("a failure is unseen until some device showed it; a new failure is news again", () => {
  const s = (id: string, failed_ms?: number, fail_seen_ms?: number) => ({ id, settings: { failed_ms, fail_seen_ms } });
  const w = { a: "fail", b: "fail", c: "done" } as const;
  expect([...unseenFailures([s("a", 100, 0), s("b", 200), s("c")], w)]).toEqual(["a", "b"]);
  expect([...unseenFailures([s("a", 100, 100), s("b", 200, 0), s("c")], w)]).toEqual(["b"]);
  // A failure known only from the events keeps its mark whatever the session's activity.
  expect([...unseenFailures([s("a"), s("b", undefined, -1)], { a: "fail", b: "fail" })]).toEqual(["a"]);
  // It failed again later: the stamp moved past the one that was seen.
  expect([...unseenFailures([s("a", 300, 100)], { a: "fail" })]).toEqual(["a"]);
});

test("a state the headline counts keeps a row, and the line under the rows says what did not fit", () => {
  const rows = [..."abcdef"].map((id) => ({ id, w: "need" as const })).concat([{ id: "r", w: "resume" as never }, { id: "x", w: "fail" as never }, { id: "y", w: "fail" as never }]);
  const { shown, more } = pickRows(rows, 6);
  // Four of the six that need the owner, the held one and the first failure: in the order of attention.
  expect(shown.map((r) => r.id)).toEqual(["a", "b", "c", "d", "r", "x"]);
  expect(sayMore(more)).toBe("3 more: 2 need you, 1 failed");
  expect(pickRows(rows.slice(0, 5), 6)).toEqual({ shown: rows.slice(0, 5), more: [] });
});

test("a waiting plan, a secret and an agent's request count as needing the owner, each with its word", () => {
  expect(needs("work", { plan: true })).toBe("need");
  expect(needs("work", { secret: true })).toBe("need");
  expect(needs("work", { agent: true })).toBe("need");
  expect(needs("work", {})).toBe("work");
  expect(needs("fail", { plan: true })).toBe("fail");
  expect(rowKind("need", { plan: true })).toBe("Plan");
  expect(rowKind("need", { secret: true })).toBe("Secret");
  expect(rowKind("need", { approval: { kind: "shell" }, agent: true })).toBe("Agent's command");
  expect(rowKind("need", { approval: { kind: "shell" } })).toBe("Command");
});
