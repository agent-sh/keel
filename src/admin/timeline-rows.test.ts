import { expect, test } from "bun:test";
import { outcomeOf as recorded } from "./outcomes.ts";
import { activityRow, dur, errorRow, isFailure, markRow, nowLines, originOf, outcomeOf, timelineText, turnRow } from "./timeline-rows.ts";

const start = { id: "t1", ts: 1_000 };

test("a turn's sentence names who started it, how it ended and what it took", () => {
  const woke = turnRow({ start, opener: { kind: "wait", wait_id: "w1" }, end: { reason: "end_turn", ms: 180_000 }, steps: 14, tools: 20, failed_tools: 2 });
  expect(woke).toMatchObject({ kind: "turn", tone: "plain", text: "Turn started by a wait wake, 14 steps, 2 failed tools", bad: "2 failed tools", ms: 180_000, turn_event: "t1", refs: { wait_id: "w1" } });
  expect(woke.turn).toMatchObject({ origin: "wait", outcome: "ok", steps: 14, tools: 20, failed_tools: 2 });
  expect(isFailure(woke)).toBe(true);

  expect(turnRow({ start, opener: { origin: "queued", queue_id: "q1" }, end: { reason: "end_turn" }, steps: 1, tools: 0, failed_tools: 0 }).text).toBe("Turn started by a queued prompt, 1 step");
  expect(turnRow({ start, opener: { origin: "queued", kind: "peer" }, end: { reason: "end_turn" }, steps: 2, tools: 0, failed_tools: 0 }).text).toBe("Turn started by another session (queued), 2 steps");
  const failed = turnRow({ start, opener: {}, end: { reason: "error" }, steps: 0, tools: 0, failed_tools: 0, error_id: "e1" });
  expect(failed).toMatchObject({ tone: "failed", text: "Turn started by the owner failed before its first step", refs: { error_id: "e1" } });
  expect(turnRow({ start, opener: { origin: "restart" }, end: { reason: "restart" }, steps: 3, tools: 1, failed_tools: 0 }).text).toBe("Turn continued after a daemon restart, cut by a daemon restart after 3 steps");
  expect(turnRow({ start, opener: {}, end: { reason: "interrupted", stopped_by: "parent" }, steps: 2, tools: 0, failed_tools: 0 }).text).toBe("Turn started by the owner, stopped by its parent after 2 steps");
  expect(turnRow({ start, opener: {}, end: { reason: "max_steps" }, steps: 40, tools: 0, failed_tools: 0 }).text).toBe("Turn started by the owner, ended at its step budget after 40 steps");
  expect(turnRow({ start, opener: { kind: "subagent" }, running: true, steps: 4, tools: 3, failed_tools: 0 })).toMatchObject({ tone: "live", open: true, sub: "running", text: "Turn started by an agent report: running, 4 steps so far" });
  // No end and not running: said as it is, never guessed.
  expect(turnRow({ start, opener: {}, steps: 1, tools: 0, failed_tools: 0 }).sub).toBe("open");
});

test("who started a turn: what the prompt says it is, then how it arrived", () => {
  expect(originOf(null).key).toBe("owner");
  expect(originOf({ origin: "steer" }).key).toBe("steer");
  expect(originOf({ kind: "loop", origin: "queued" })).toMatchObject({ key: "loop", queued: true });
  expect(originOf({ kind: "something-new" }).words).toBe("something else");
});

test("an activity row says what its records say and never passes text through", () => {
  const look = {
    agent: () => ({ session_id: "c1", title: "Check the parser", type: "general-purpose", status: "completed", created: 1_000 }),
    wait: () => ({ kind: "timer", status: "fired", created: 1_000, deadline: 9_000 }),
    loop: () => ({ name: "Nightly sweep" }),
    approval: () => ({ tool: "Bash", risk: "high", state: "allowed", choice: "once", created: 1_000 }),
  };
  const act = (kind: string, sub: string, data: object, text = "SECRET-TEXT rm -rf /private") => activityRow({ id: "a1", ts: 61_000, kind, sub, text, data, turn_event: "t1" }, look)!;
  expect(act("agent", "started", { agent_id: "g1", child_session: "c1" })).toMatchObject({ kind: "agent", text: 'Agent "Check the parser" started (general-purpose)', turn_event: "t1", refs: { agent_id: "g1", child_session: "c1" } });
  expect(act("agent", "completed", { agent_id: "g1" })).toMatchObject({ text: 'Agent "Check the parser" reported after 1 min', ms: 60_000, refs: { child_session: "c1" } });
  expect(act("agent", "stopped", { agent_id: "g1", stopped_by: "owner" }).text).toBe('Agent "Check the parser" stopped: the owner stopped it');
  expect(act("agent", "failed", { agent_id: "g1" }).tone).toBe("failed");
  expect(act("wait", "fired", { wait_id: "w1" })).toMatchObject({ kind: "wait", text: "Wait on a timer fired after 1 min", refs: { wait_id: "w1" } });
  expect(act("wait", "timeout", { wait_id: "w1" }).tone).toBe("failed");
  expect(act("wait", "set", { wait_id: "w1" }).text).toBe("Wait set on a timer");
  expect(act("loop", "run", { loop_id: "l1", run_id: "r1" }).text).toBe('Loop "Nightly sweep" started a run');
  expect(act("loop", "skip", { loop_id: "l1" }, 'Loop "Nightly sweep" did not run: the previous run was still going').text).toBe('Loop "Nightly sweep" did not run: the previous run was still going');
  expect(act("approval", "allowed", { approval_id: "p1" })).toMatchObject({ kind: "approval", text: "Approval for Bash allowed once after 1 min" });
  expect(act("alert", "approval", { approval_id: "p1" }).text).toBe("Approval asked for Bash (high risk)");
  expect(act("approval", "refused", { call_id: "c9" }, "Bash: rm -rf /private (too broad)")).toMatchObject({ tone: "failed", text: "Bash call refused by the judge" });
  // A subagent's row is listed under its parent and says whose it is.
  expect(act("approval", "denied", { approval_id: "p1", child_session: "c1", child_title: "Check the parser", child_turn: "t9" })).toMatchObject({ text: 'Approval for Bash denied after 1 min, in agent "Check the parser"', refs: { child_session: "c1", child_turn: "t9" } });
  expect(act("turn", "goal", {}, "Goal check: not met. The file is missing SECRET-TEXT").text).toBe("Goal check: not met");
  for (const [k, s] of [["agent", "started"], ["agent", "completed"], ["wait", "fired"], ["loop", "run"], ["approval", "allowed"], ["alert", "question"]] as const) {
    expect(JSON.stringify(act(k, s, { agent_id: "g1", wait_id: "w1", loop_id: "l1", approval_id: "p1" }))).not.toContain("SECRET-TEXT");
  }
  // What the timeline says elsewhere (a turn's end), or does not tell at all.
  expect(activityRow({ id: "a", ts: 1, kind: "turn", sub: "end_turn", text: "x" })).toBeNull();
  expect(activityRow({ id: "a", ts: 1, kind: "alert", sub: "finished", text: "x" })).toBeNull();
  expect(activityRow({ id: "a", ts: 1, kind: "agent", sub: "staggered", text: "x" })).toBeNull();
  // A record that is gone leaves a row that says so.
  expect(activityRow({ id: "a", ts: 1, kind: "agent", sub: "started", text: "x", data: { agent_id: "gone" } })!.text).toBe("Agent (no longer kept) started");
});

test("marks: compactions, model switches and restarts, without their text", () => {
  expect(markRow({ id: "m", ts: 5, kind: "compaction", data: { mode: "summary", auto: 1, tokens_before: 150_000 } }, "t1")).toMatchObject({ kind: "compaction", text: "Context compacted by itself, from 150k tokens", turn_event: "t1" });
  expect(markRow({ id: "m", ts: 5, kind: "compaction", data: { mode: "summary", trigger: "model", auto: 1 } })!.text).toBe("The model started a fresh context");
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "model_told", from: "bedrock:model-a", to: "scripted:stand-in" } })).toMatchObject({ kind: "model", text: "Model changed from model-a to stand-in" });
  expect(markRow({ id: "m", ts: 5, kind: "turn_end", data: { reason: "restart", crashed: true } })).toMatchObject({ kind: "restart", sub: "crash" });
  expect(markRow({ id: "m", ts: 5, kind: "turn_end", data: { reason: "end_turn" } })).toBeNull();
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "restart" } })).toMatchObject({ kind: "restart", tone: "owner" });
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "tasks" } })).toBeNull();
});

test("an error row names its class and count, not its message", () => {
  const row = errorRow({ id: "e1", ts: 9, source: "provider", message: "Scripted: 529 overloaded for prompt SECRET-TEXT", count: 3, turn_event: "t1", span_id: "s1" });
  expect(row).toMatchObject({ kind: "error", tone: "failed", text: "Model request error (overloaded), 3 times", turn_event: "t1", refs: { error_id: "e1", span_id: "s1" } });
  expect(errorRow({ id: "e2", ts: 9, source: "tool", message: "x", resolved_ts: 10 })).toMatchObject({ tone: "plain", text: "Tool error, marked fixed" });
});

const quiet = { ts: 100_000, approvals: [], questions: [], waits: [], agents: [], loops: [], queue: { queued: 0, steers: 0, held: false, owed: false } };
test("now: what waits on the owner first, then what runs, then what is waited on", () => {
  const busy = nowLines({
    ...quiet,
    turn: { id: "t1", ts: 40_000, opener: { kind: "wait" }, steps: 3, status: { kind: "tool", since: 90_000, names: ["Bash"] } },
    approvals: [{ id: "p1", tool: "Bash", risk: "high", created: 95_000 }],
    waits: [{ id: "w1", kind: "timer", created: 50_000, deadline: 400_000 }],
    agents: [{ id: "g1", session_id: "c1", title: "Check the parser", status: "running", created: 60_000 }],
    queue: { queued: 2, steers: 1, held: false, owed: false },
  });
  expect(busy.state).toBe("owner");
  expect(busy.lines.map((l) => [l.kind, l.tone, l.text])).toEqual([
    ["approval", "owner", "Waits on the owner: approval for Bash (high risk)"],
    ["turn", "live", "Running a turn started by a wait wake: step 3, running Bash"],
    ["agent", "live", 'Agent "Check the parser" is running'],
    ["wait", "plain", "Waits on a timer"],
    ["queue", "plain", "2 queued prompts and 1 steer wait for the turn"],
  ]);
  expect(busy.lines[1]).toMatchObject({ turn_event: "t1", ts: 40_000 });
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 3, status: { kind: "model", since: 1, model: "m" } } }).lines[0]!.text).toBe("Running a turn started by the owner: step 4, waiting for the model");
  const idle = nowLines({ ...quiet, last: { ts: 90_000, outcome: "error" } });
  expect(idle).toMatchObject({ state: "idle", lines: [{ kind: "idle", text: "Nothing is running or waited on. The last turn failed." }] });
  expect(nowLines({ ...quiet, waits: [{ id: "w", kind: "file", created: 1, deadline: 2 }] }).state).toBe("waiting");
  expect(nowLines({ ...quiet, queue: { queued: 1, steers: 0, held: true, owed: false } }).lines[0]).toMatchObject({ tone: "owner", text: "1 queued prompt waits: the queue is held until the owner resumes it" });
});

test("the text form: a line a row, with the ids that open its detail", () => {
  const rows = [
    turnRow({ start: { id: "t2", ts: Date.UTC(2026, 0, 2, 14, 32) }, opener: { kind: "wait" }, end: { reason: "end_turn", ms: 180_000, usage: { cost: 0.0312 } }, steps: 14, tools: 20, failed_tools: 2 }),
    errorRow({ id: "e1", ts: Date.UTC(2026, 0, 2, 14, 30), source: "provider", message: "429 rate limit" }),
  ];
  const text = timelineText({ session_id: "s1", now: nowLines({ ...quiet, last: { ts: 1, outcome: "ok" } }), rows, next: "5:x" }, { title: "Parser work", now: 100_000 });
  expect(text.split("\n")).toEqual([
    'Timeline of session "Parser work" (s1), newest first, UTC.',
    "Now: idle.",
    "  Nothing is running or waited on. The last turn finished.",
    "01-02 14:32   Turn started by a wait wake, 14 steps, 2 failed tools, 3 min, $0.03  [turn=t2]",
    "01-02 14:30 ! Model request error (rate limit)  [error=e1]",
    "Older rows: before=5:x",
  ]);
});

test("durations read as a person says them", () => {
  expect([850, 4_200, 180_000, 4_320_000, 3_600_000, 183_600_000].map(dur)).toEqual(["850 ms", "4 s", "3 min", "1 h 12 min", "1 h", "2 d 3 h"]);
});

test("a turn's outcome class is the one its telemetry row records", () => {
  for (const reason of ["end_turn", "stop", "stop_sequence", "error", "interrupted", "restart", "max_steps", "max_tokens", "refusal", "tool_use", "pause_turn", "model_context_window_exceeded", "anything"]) {
    for (const by of [undefined, null, "owner", "parent", "time_limit"]) expect(outcomeOf(reason, by)).toBe(recorded(reason, by));
  }
});
