import { expect, test } from "bun:test";
import type { SessionState } from "../../../src/core/watch.ts";
import { pickRows, rowKind, rowLine, say, sayMore, unseenFailures, watchSummary, wholeCommand } from "./home.ts";

const st = (watch: SessionState["watch"], more: Partial<SessionState> = {}): SessionState => ({ watch, agents: 0, ...more });

test("the headline counts what the rows list, from the served states", () => {
  const list = [
    { id: "a", st: st("need", { why: "approval", asks: 3 }) }, { id: "h", st: st("need", { why: "resume" }) },
    { id: "b", st: st("work") }, { id: "c", st: st("fail") }, { id: "d", st: st("fail") }, { id: "n", st: st("declined") },
    { id: "t", st: st("wait", { why: "timer" }) }, { id: "e", st: st("resume") },
    { id: "s", st: st("stop", { why: "max_steps" }) }, { id: "o", st: st("stop") }, { id: "f", st: st("done") },
  ];
  const s = watchSummary(list, new Set(["c", "n"]));
  // What needs the owner is counted by the things that wait (three requests and a held turn), as the tab's title counts.
  expect(s.head.map((p) => say(p.w, p.n))).toEqual(["4 need you", "1 failed", "1 declined", "1 working", "2 waiting", "1 stopped"]);
  // A failure and a declined turn until looked at; a stop the daemon gives a reason for, not one the owner made.
  expect(s.attention.map((r) => r.id)).toEqual(["a", "h", "c", "n", "s"]);
  // What goes on by itself: at work, waiting on something it set up, or about to be resumed.
  expect(s.working.map((r) => r.id)).toEqual(["b", "t", "e"]);
  // Every failure looked at, nothing else: nothing to say, nothing listed.
  expect(watchSummary([{ id: "c", st: st("fail") }, { id: "o", st: st("stop") }, { id: "f", st: st("done") }], new Set())).toEqual({ head: [], attention: [], working: [] });
  expect(say("need", 1)).toBe("1 needs you");
});

test("a row's kind comes from the daemon's reason, and its line is the served text without the kind", () => {
  const need = (why: string, text: string, more: Partial<SessionState> = {}) => st("need", { why, text, ...more });
  expect(rowKind(need("approval", ""), "shell")).toBe("Command");
  expect(rowKind(need("approval", ""), "edit")).toBe("Edit");
  expect(rowKind(need("approval", ""), "other")).toBe("Tool call");
  expect(rowKind(need("approval", ""))).toBe("Approval");
  expect(["question", "plan", "secret", "resume", "unsent", "owner"].map((why) => rowKind(need(why, "")))).toEqual(["Question", "Plan", "Secret", "Held after a restart", "Not sent", "Your answer"]);
  // A request of one of the session's agents says whose it is.
  expect(rowKind(need("approval", "", { child: "k" }), "shell")).toBe("Agent's command");
  expect(rowKind(need("plan", "", { child: "k" }))).toBe("Agent's plan");
  // A failure says its class where the class has a word.
  expect(rowKind(st("fail", { cls: "rate_limit" }))).toBe("Failed: rate limit");
  expect(rowKind(st("fail", { cls: "other" }))).toBe("Failed");
  expect([rowKind(st("declined")), rowKind(st("stop")), rowKind(st("wait")), rowKind(st("work"))]).toEqual(["Declined", "Stopped", "Waiting", "Working"]);
  // The line is the daemon's text; the words that say the kind are the row's own.
  expect(rowLine(need("approval", "Approve Bash: rm -rf dist, and 2 more"))).toBe("Bash: rm -rf dist, and 2 more");
  expect(rowLine(need("question", "Question: Which plan names?"))).toBe("Which plan names?");
  expect(rowLine(need("plan", "Plan to approve: Retry policy"))).toBe("Retry policy");
  expect(rowLine(need("secret", "Secret to give: SPEC_TOKEN"))).toBe("SPEC_TOKEN");
  expect(rowLine(need("approval", "Agent Scout: Approve Bash: touch a.txt", { child: "k" }))).toBe("Scout: Bash: touch a.txt");
  expect(rowLine(need("plan", "Plan to approve"))).toBe("Plan to approve");
  expect(rowLine(need("resume", "Resume the turn a restart cut"))).toBe("Resume the turn a restart cut");
  expect(rowLine(st("fail", { cls: "quota", text: "HTTP 402: your credit balance is too low" }))).toBe("HTTP 402: your credit balance is too low");
  expect(rowLine(st("wait", { why: "resume", text: "Resumes by itself", until: new Date(2026, 0, 1, 14, 5).getTime() }))).toBe("Resumes by itself at 14:05");
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
  // Where it runs is not said on a row: another machine, a folder that is not the session's, another shell.
  expect(wholeCommand(shell("rm -rf build"), true)).toBeNull();
  expect(wholeCommand({ kind: "shell", risk: "low", summary: "rm -rf build", input: { command: "rm -rf build", machine: "build-box" } })).toBeNull();
  expect(wholeCommand({ ...shell("rm -rf build"), at: { cwd: "/srv/app", away: true } })).toBeNull();
  expect(wholeCommand({ ...shell("rm -rf build"), at: { cwd: "/w", shell: "zsh" } })).toBeNull();
  expect(wholeCommand({ ...shell("rm -rf build"), at: { cwd: "/w/sub", sub: "sub" } })).toBeNull();
  // A character that hides or reorders what is shown: a right-to-left override, a zero-width space, a tab.
  for (const odd of ["echo \u202Etxt.x > r.txt", "rm -rf di\u200Bst", "ls\t-la", "echo a\u2028b"]) expect(wholeCommand(shell(odd))).toBeNull();
  // Nor one that draws nothing or as a plain space, nor letters a renderer reorders: printable ASCII only.
  for (const odd of ["cp \u05d0 1 2 \u05d1 > \u05d2", "rm -rf a\u3164b", "ls a\ufe0f", "ls a\u034fb", "rm -rf a\u2800b", "rm -rf a\u00a0b", "rm -rf a\u3000b", "echo caf\u00e9"]) expect(wholeCommand(shell(odd))).toBeNull();
});

test("a failure is unseen until some device showed it; a new failure is news again", () => {
  const s = (id: string, failed_ms?: number, fail_seen_ms?: number) => ({ id, settings: { failed_ms, fail_seen_ms } });
  const w = { a: "fail", b: "declined", c: "done" } as const;
  expect([...unseenFailures([s("a", 100, 0), s("b", 200), s("c")], w)]).toEqual(["a", "b"]);
  expect([...unseenFailures([s("a", 100, 100), s("b", 200, 0), s("c")], w)]).toEqual(["b"]);
  // A failure known only from the events keeps its mark whatever the session's activity.
  expect([...unseenFailures([s("a"), s("b", undefined, -1)], { a: "fail", b: "fail" })]).toEqual(["a"]);
  // It failed again later: the stamp moved past the one that was seen.
  expect([...unseenFailures([s("a", 300, 100)], { a: "fail" })]).toEqual(["a"]);
});

test("a state the headline counts keeps a row, and the line under the rows says what did not fit", () => {
  const rows = [..."abcdef"].map((id) => ({ id, w: "need" as const })).concat([{ id: "r", w: "declined" as never }, { id: "x", w: "fail" as never }, { id: "y", w: "fail" as never }]);
  const { shown, more } = pickRows(rows, 6);
  // Four of the six that need the owner, the declined one and the first failure: in the order of attention.
  expect(shown.map((r) => r.id)).toEqual(["a", "b", "c", "d", "r", "x"]);
  expect(sayMore(more)).toBe("3 more: 2 need you, 1 failed");
  expect(pickRows(rows.slice(0, 5), 6)).toEqual({ shown: rows.slice(0, 5), more: [] });
});
