import { expect, test } from "bun:test";
import { classify, groupsUnder, runs, tailOf, type Group, type Proc, type Tail } from "./activity.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();
const user = (s: number, content: unknown, more = {}) => ({ type: "user", timestamp: at(s), message: { role: "user", content }, ...more });
const says = (s: number, content: unknown[], stop = "tool_use") => ({ type: "assistant", timestamp: at(s), message: { role: "assistant", content, stop_reason: stop } });
const bash = (id: string, command: string, more = {}) => ({ type: "tool_use", id, name: "Bash", input: { command, ...more } });
const result = (id: string) => [{ type: "tool_result", tool_use_id: id, content: "" }];
const claude = (records: unknown[], since = 0) => tailOf("claude", [...records].reverse(), since);

test("a Claude Code call with no result yet is open, however old the file is", () => {
  const t = claude([user(1, "run the suite"), says(2, [{ type: "text", text: "Running." }]), says(3, [bash("a", "make test")])]);
  expect(t.turn).toBe("open");
  expect(t.open.map((c) => [c.id, c.kind, c.command])).toEqual([["a", "tool", "make test"]]);
});

test("a finished turn leaves nothing open; an interrupted call is not waited for", () => {
  const done = claude([user(1, "go"), says(2, [bash("a", "ls")]), user(3, result("a")), says(4, [{ type: "text", text: "Done." }], "end_turn"), { type: "system", subtype: "turn_duration", timestamp: at(5) }]);
  expect([done.turn, done.open.length]).toEqual(["closed", 0]);
  const cut = claude([user(1, "go"), says(2, [bash("a", "sleep 600")]), user(3, "[Request interrupted by user for tool use]")]);
  expect([cut.turn, cut.open.length]).toEqual(["closed", 0]);
});

test("a background call is open until the notification that names it; a subagent is a subagent", () => {
  const start = [user(1, "go"), says(2, [bash("bg", "sh bench.sh", { run_in_background: true }), { type: "tool_use", id: "ag", name: "Agent", input: { subagent_type: "Explore", description: "find the test" } }]), user(3, result("bg"))];
  const t = claude(start);
  expect(t.background.map((c) => c.id)).toEqual(["bg"]);
  expect(t.open.map((c) => [c.id, c.kind, c.label])).toEqual([["ag", "subagent", "Explore: find the test"]]);
  const told = claude([...start, user(9, "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>")]);
  expect(told.background).toEqual([]);
});

test("records from before the harness process started are not read", () => {
  const t = claude([says(1, [bash("old", "sleep 9")]), user(20, "next"), says(21, [bash("new", "ls")])], Date.parse(at(10)));
  expect(t.open.map((c) => c.id)).toEqual(["new"]);
});

test("a Codex turn is open between task_started and task_complete", () => {
  const call = { type: "response_item", timestamp: at(2), payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "cargo test"] }) } };
  const started = { type: "event_msg", timestamp: at(1), payload: { type: "task_started" } };
  const open = tailOf("codex", [call, started]);
  expect([open.turn, open.open.map((c) => c.command)]).toEqual(["open", ["bash -lc cargo test"]]);
  const closed = tailOf("codex", [{ type: "event_msg", timestamp: at(4), payload: { type: "task_complete" } }, { type: "response_item", timestamp: at(3), payload: { type: "function_call_output", call_id: "c1" } }, call, started]);
  expect([closed.turn, closed.open.length]).toEqual(["closed", 0]);
});

const proc = (pid: number, ppid: number, pgid: number, args: string, started_ms = pid): Proc => ({ pid, ppid, pgid, started_ms, args });

test("the harness's own group serves it; groups of their own are its work", () => {
  const procs = [
    proc(100, 1, 100, "claude"), proc(101, 100, 100, "node mcp-server.js"), // its MCP server: its own group
    proc(200, 100, 200, "/bin/bash -c eval 'make test'"), proc(201, 200, 200, "make test"), // a tool shell
    proc(300, 1, 300, "sh bench.sh"), // a job whose shell ended, known by its environment
    proc(400, 1, 400, "vim"),
  ];
  expect(groupsUnder(procs, 100, [300]).map((g) => [g.pgid, g.pid, g.args.length])).toEqual([[100, 101, 1], [200, 200, 2], [300, 300, 1]]);
});

test("a process is matched to the command that started it", () => {
  expect(runs("/bin/bash -c -l source /h/.claude/shell-snapshots/s.sh && eval 'sleep 600 && make \"test\"' \\< /dev/null && pwd -P >| /tmp/x", 'sleep 600 && make "test"')).toBe(true);
  expect(runs("sh bench.sh --size 10", "nohup sh bench.sh --size 10 > bench.log 2>&1 &")).toBe(true);
  expect(runs("/bin/sh -c ${CLAUDE_PLUGIN_ROOT}/bin/notify hook wait", "make test")).toBe(false);
});

const group = (pgid: number, command: string): Group => ({ pgid, pid: pgid, started_ms: 1000, command, args: [command] });
const none: Tail = { open: [], background: [], shells: [], turn: "unknown" };

test("classification: unidentified children hold the wait even without a transcript record", () => {
  const t = claude([user(1, "go"), says(2, [bash("job", "nohup sh bench.sh > log &")]), user(3, result("job")), says(4, [bash("fg", "sleep 600; make test")])]);
  const active = classify({ alive: true, tail: t, groups: [group(7, "sh bench.sh"), group(8, "sh -c sleep 600; make test"), group(9, "/bin/sh -c notify hook wait")] });
  expect([active.state, active.brief, active.why]).toEqual(["active", "1 job, 2 calls", "1 background job, 2 calls running"]);
  expect(active.in_flight.map((i) => [i.kind, i.pgid])).toEqual([["job", 7], ["tool", 8], ["tool", 9]]); // jobs first
  expect(active.helpers).toEqual([]);

  // A quiet child could belong to a subagent whose call is not in this transcript.
  expect(classify({ alive: true, status: "idle", tail: none, groups: [group(9, "/bin/sh -c notify hook wait")] }).state).toBe("active");
  // It says idle, but a job the transcript names still runs: active.
  expect(classify({ alive: true, status: "idle", tail: t, groups: [group(7, "sh bench.sh")] }).in_flight.map((i) => i.kind)).toEqual(["job"]);
  // It says idle and the open call has no process: the call is stale.
  expect(classify({ alive: true, status: "idle", tail: t, groups: [] }).state).toBe("idle");
  // No word from it: an open call with no process (an MCP call) still counts.
  expect(classify({ alive: true, tail: t, groups: [] }).in_flight.map((i) => i.kind)).toEqual(["tool"]);
  expect(classify({ alive: true, status: "busy", tail: none, groups: [] }).in_flight.map((i) => i.kind)).toEqual(["turn"]);
  expect(classify({ alive: true, status: "waiting", waiting_for: "permission prompt", tail: none, groups: [] }).in_flight[0]!.label).toContain("permission prompt");
  expect(classify({ alive: false, tail: t, groups: [] })).toMatchObject({ state: "ended", in_flight: [] });
});
