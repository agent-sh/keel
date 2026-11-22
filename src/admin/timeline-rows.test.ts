import { expect, test } from "bun:test";
import { localStamp, zoneLabel } from "../core/clock.ts";
import { outcomeOf as recorded } from "./outcomes.ts";
import { ABOUT_MAX, aboutOf, activityRow, dur, errorRow, failureRow, isFailure, markRow, newSince, nowLines, originOf, outcomeOf, timelineText, turnRow, type TimelineRow } from "./timeline-rows.ts";

const start = { id: "t1", ts: 1_000 };

test("a turn's sentence leads with who started it, then how it ended and what it took", () => {
  const woke = turnRow({ start, opener: { kind: "wait", wait_id: "w1" }, end: { reason: "end_turn", ms: 180_000 }, steps: 14, tools: 20, failed_tools: 2 });
  expect(woke).toMatchObject({ kind: "turn", tone: "plain", text: "Wait wake, 14 steps, 2 failed tools", bad: "2 failed tools", ms: 180_000, turn_event: "t1", refs: { wait_id: "w1" } });
  expect(woke.turn).toMatchObject({ origin: "wait", outcome: "ok", steps: 14, tools: 20, failed_tools: 2 });
  expect(isFailure(woke)).toBe(true);

  const row = (opener: object, end: { reason: string; stopped_by?: string; crashed?: boolean; unstarted?: boolean; ms?: number } | null, steps: number, more: object = {}) =>
    turnRow({ start, opener, end, steps, tools: 0, failed_tools: 0, ...more });
  expect(row({}, { reason: "end_turn" }, 2).text).toBe("Owner prompt, 2 steps");
  expect(row({ origin: "queued", queue_id: "q1" }, { reason: "end_turn" }, 1).text).toBe("Queued prompt, 1 step");
  expect(row({ origin: "queued", kind: "peer" }, { reason: "end_turn" }, 2).text).toBe("Message from another session (queued), 2 steps");
  expect(turnRow({ start, opener: {}, end: { reason: "error" }, steps: 0, tools: 0, failed_tools: 0, error_id: "e1" })).toMatchObject({ tone: "failed", text: "Owner prompt: failed before its first step", refs: { error_id: "e1" } });
  expect(row({}, { reason: "refusal" }, 1)).toMatchObject({ tone: "failed", text: "Owner prompt: the model declined after 1 step" });
  expect(row({}, { reason: "interrupted", stopped_by: "parent" }, 2).text).toBe("Owner prompt, stopped by its parent after 2 steps");
  expect(row({}, { reason: "max_steps" }, 40).text).toBe("Owner prompt, ended at its step budget after 40 steps");
  expect(turnRow({ start, opener: { kind: "subagent" }, running: true, steps: 4, tools: 3, failed_tools: 0 })).toMatchObject({ tone: "live", open: true, sub: "running", text: "Agent report: running, 4 steps so far" });
  // No end and not running: said as it is, never guessed.
  expect(row({}, null, 1).sub).toBe("open");

  // A restart: planned or not, and the turn that went on after it. One row each.
  expect(row({}, { reason: "restart" }, 3).text).toBe("Owner prompt, cut by a daemon restart after 3 steps");
  expect(row({}, { reason: "restart", crashed: true }, 1).text).toBe("Owner prompt, cut when the daemon went down after 1 step");
  expect(row({ origin: "restart" }, { reason: "end_turn" }, 1).text).toBe("Resumed after a daemon restart, 1 step");
  // A prompt the daemon went down on before its turn began: no turn ran, and nothing took "0 ms".
  const never = row({}, { reason: "restart", crashed: true, unstarted: true, ms: 0 }, 0);
  expect(never).toMatchObject({ sub: "unstarted", tone: "plain", text: "A prompt was accepted; the daemon went down before its turn started" });
  expect(never.ms).toBeUndefined();
  // Stopped while it was set up: a turn of no length says no duration.
  expect(row({}, { reason: "interrupted", ms: 0 }, 0)).toMatchObject({ text: "Owner prompt, stopped by the owner before its first step" });
  expect(row({}, { reason: "interrupted", ms: 0 }, 0).ms).toBeUndefined();
  // A call the owner, a rule or the judge denied is a decision: it is said, and it is not a failure.
  const refused = row({}, { reason: "end_turn" }, 2, { tools: 1, denied_tools: 1 });
  expect(refused).toMatchObject({ tone: "plain", text: "Owner prompt, 2 steps, 1 denied call", turn: { denied_tools: 1, failed_tools: 0 } });
  expect(refused.bad).toBeUndefined();
  expect(isFailure(refused)).toBe(false);
  expect(row({}, { reason: "end_turn" }, 3, { failed_tools: 1, denied_tools: 2 }).text).toBe("Owner prompt, 3 steps, 1 failed tool, 2 denied calls");
  // What woke a turn is told in its row: the wait that fired, the agent whose report it is.
  expect(row({ kind: "wait", wait_id: "w1", outcome: "fired" }, { reason: "end_turn" }, 1, { wake: { kind: "timer", ms: 3_000 } }).text).toBe("Wait wake (a timer, after 3 s), 1 step");
  expect(row({ kind: "wait", wait_id: "w1" }, { reason: "end_turn" }, 1, { wake: { kind: "file" } }).text).toBe("Wait wake (a file), 1 step");
  expect(row({ kind: "subagent", agent_id: "g1", status: "completed" }, { reason: "end_turn" }, 1, { agent: { title: "Check the parser", session_id: "c1" } }))
    .toMatchObject({ text: 'Agent report from "Check the parser", 1 step', refs: { agent_id: "g1", child_session: "c1" } });
  // A turn on a branch the session does not show says so.
  // Not yet placed on a branch is said too, and is not the same as on the branch shown.
  expect(row({}, { reason: "end_turn" }, 2, { branch: "unknown" })).toMatchObject({ text: "Owner prompt, 2 steps, branch not placed yet", turn: { branch: "unknown" } });
  expect(row({}, { reason: "end_turn" }, 2, { branch: "on" }).turn!.branch).toBeUndefined();
  expect(row({}, { reason: "end_turn" }, 2, { branch: "other" })).toMatchObject({ text: "Owner prompt, 2 steps, on a branch not shown", turn: { branch: "other" } });
});

test("what a turn spent is what its rollup says, over all its requests", () => {
  const spent = turnRow({ start, opener: {}, end: { reason: "end_turn" }, usage: { input: 900, output: 70, cache_read: 4_000, cost: 0.031 }, steps: 2, tools: 1, failed_tools: 0 });
  expect(spent.turn).toMatchObject({ input: 900, output: 70, cache_read: 4_000, cost: 0.031 });
  expect(turnRow({ start, opener: {}, end: { reason: "end_turn" }, usage: { input: 1, output: 1, cost: null }, steps: 1, tools: 0, failed_tools: 0 }).turn!.cost).toBeUndefined();
});

test("who started a turn: what the prompt says it is, then how it arrived", () => {
  expect(originOf(null)).toMatchObject({ key: "owner", lead: "Owner prompt" });
  expect(originOf({ origin: "steer" }).key).toBe("steer");
  expect(originOf({ kind: "loop", origin: "queued" })).toMatchObject({ key: "loop", queued: true, lead: "Loop run" });
  expect(originOf({ kind: "something-new" })).toMatchObject({ words: "something else", lead: "Other input" });
  // The owner's Continue is stored as a harness prompt; a note the harness writes names its kind.
  expect(originOf({ origin: "harness" })).toMatchObject({ key: "continue", lead: "Owner's Resume", words: "the owner's Resume" });
  expect(originOf({ origin: "harness", kind: "harness" })).toMatchObject({ key: "harness", lead: "Harness note" });
  expect(originOf({ kind: "failures" }).lead).toBe("Failure notice");
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
  const childs = { approval_id: "p1", child_session: "c1", child_title: "Check the parser", child_turn: "t9" };
  expect(act("approval", "denied", childs)).toMatchObject({ text: 'Approval for Bash denied after 1 min, in agent "Check the parser"', turn_event: "t1", refs: { child_session: "c1", child_turn: "t9" } });
  // Read for the agent's own session it is that session's row, in that session's turn.
  const own = activityRow({ id: "a1", ts: 61_000, kind: "approval", sub: "denied", text: "x", data: childs, turn_event: "t1" }, look, true)!;
  expect(own).toMatchObject({ text: "Approval for Bash denied after 1 min", turn_event: "t9" });
  expect(own.refs?.child_session).toBeUndefined();
  expect(act("turn", "goal", {}, "Goal check: not met. The file is missing SECRET-TEXT").text).toBe("Goal check: not met");
  expect(act("turn", "goal", {}, "Goal paused: the judge said met; SECRET-TEXT. Resume to try again.").text).toBe("Goal paused");
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

test("marks: compactions, model switches and restored files, without their text", () => {
  expect(markRow({ id: "m", ts: 5, kind: "compaction", data: { mode: "summary", auto: 1, tokens_before: 150_000 } }, "t1")).toMatchObject({ kind: "compaction", text: "Context compacted by itself, from 150k tokens", turn_event: "t1" });
  expect(markRow({ id: "m", ts: 5, kind: "compaction", data: { mode: "summary", trigger: "model", auto: 1 } })!.text).toBe("The model started a fresh context");
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "model_told", from: "bedrock:model-a", to: "scripted:stand-in" } })).toMatchObject({ kind: "model", text: "Model changed from model-a to stand-in" });
  // A turn's end is told by the turn's row: a restart makes no second row saying the same.
  expect(markRow({ id: "m", ts: 5, kind: "turn_end", data: { reason: "restart", crashed: true } })).toBeNull();
  expect(markRow({ id: "m", ts: 5, kind: "turn_end", data: { reason: "end_turn" } })).toBeNull();
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "restart" } })).toMatchObject({ kind: "restart", tone: "owner" });
  // The note a checkpoint restore writes: files went back, the conversation did not.
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "rewind" } })).toMatchObject({ kind: "files", text: "Files were restored to an earlier state" });
  expect(markRow({ id: "m", ts: 5, kind: "note", data: { kind: "tasks" } })).toBeNull();
});

test("a failure row counts what happened in this session, never what happened elsewhere", () => {
  // The session's own record: its count, and how much of it was in its agents.
  expect(failureRow({ fp: "abc", cls: "overloaded", count: 3, last_ts: 9, refs: [{ id: "self", n: 1 }, { id: "g1", n: 2 }] }, { id: "e1", turn_event: "t1", span_id: "s1" }))
    .toMatchObject({ id: "f:abc", kind: "error", tone: "failed", text: "Model request failed (overloaded), 3 times, 2 in its agents", turn_event: "t1", refs: { error_id: "e1", span_id: "s1" } });
  expect(failureRow({ fp: "abc", cls: "rate_limit", count: 1, last_ts: 9 }).text).toBe("Model request failed (rate limit)");
  expect(failureRow({ fp: "abc", cls: "overloaded", count: 2, last_ts: 9, refs: [{ id: "g1", n: 2 }] }).text).toBe("Model request failed (overloaded), 2 times, all in its agents");
  // The errors table folds a kind of failure across every session: its count says so, and its message stays out.
  const row = errorRow({ id: "e1", ts: 9, source: "provider", message: "Scripted: 529 overloaded for prompt SECRET-TEXT", count: 3, turn_event: "t1", span_id: "s1" });
  expect(row).toMatchObject({ kind: "error", tone: "failed", text: "Model request error (overloaded), 3 times in all sessions", turn_event: "t1", refs: { error_id: "e1", span_id: "s1" } });
  expect(errorRow({ id: "e2", ts: 9, source: "tool", message: "x", resolved_ts: 10 })).toMatchObject({ tone: "plain", text: "Tool error, marked fixed" });
});

const quiet = { ts: 100_000, approvals: [], questions: [], waits: [], agents: [], loops: [], queue: { queued: 0, steers: 0, held: false, owed: false } };
test("now: what waits on the owner first, then what runs, then what is waited on", () => {
  const busy = nowLines({
    ...quiet,
    turn: { id: "t1", ts: 40_000, opener: { kind: "wait" }, steps: 3, status: { kind: "tool", since: 90_000, names: ["Bash"] } },
    approvals: [{ id: "p1", call_id: "c1", tool: "Bash", risk: "high", created: 95_000 }],
    waits: [{ id: "w1", kind: "timer", created: 50_000, deadline: 400_000 }],
    agents: [{ id: "g1", session_id: "c1", title: "Check the parser", status: "running", created: 60_000 }],
    queue: { queued: 2, steers: 1, held: false, owed: false },
  });
  expect(busy.state).toBe("owner");
  expect(busy.lines.map((l) => [l.kind, l.tone, l.text])).toEqual([
    ["approval", "owner", "Needs you: an approval for Bash (high risk)"],
    ["turn", "live", "Running a turn started by a wait wake: step 3, needs you: an approval"],
    ["agent", "live", 'Agent "Check the parser" is working'],
    ["wait", "plain", "Waiting for a timer"],
    ["queue", "plain", "2 queued prompts and 1 steer wait for the turn"],
  ]);
  // The ids a line leads by: the card, the turn's receipt.
  expect(busy.lines[0]).toMatchObject({ refs: { approval_id: "p1", call_id: "c1" } });
  expect(busy.lines[1]).toMatchObject({ turn_event: "t1", ts: 40_000 });
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 3, status: { kind: "model", since: 1, model: "m" } } }).lines[0]!.text).toBe("Running a turn started by the owner: step 4, waiting for the model");
  // A running turn is not a row: the calls that failed in it up to now are said on its line.
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 3, status: { kind: "tool", since: 1, names: ["Bash"] }, failed_tools: 3 } }).lines[0]).toMatchObject({ text: "Running a turn started by the owner: step 3, 3 failed tools so far, running Bash", bad: "3 failed tools" });
  // A reply that streams is the model answering; one that went silent says for how long.
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 0, status: { kind: "idle" }, output: 60_000 } }).lines[0]!.text).toBe("Running a turn started by the owner: step 1, the model is answering");
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 0, status: { kind: "idle" } } }).lines[0]!.text).toBe("Running a turn started by the owner: step 1, between steps");
  expect(nowLines({ ...quiet, ts: 100_000, turn: { id: "t1", ts: 1, steps: 0, status: { kind: "model", since: 60_000, model: "m", connected: 60_000, quiet: 60_000 } } }).lines[0]!.text)
    .toBe("Running a turn started by the owner: step 1, the model is answering, no output for 40 s");
  // A plan presented for approval waits on the owner; a command left running is waited on.
  const plan = nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 1, status: { kind: "tool", since: 1, names: ["present_plan"] } }, plans: [{ id: "p1", created: 50_000 }] });
  expect(plan.state).toBe("owner");
  expect(plan.lines[0]).toMatchObject({ kind: "question", tone: "owner", text: "Needs you: a plan", open: true, ts: 50_000 });
  expect(nowLines({ ...quiet, jobs: [{ id: "j1", started: 70_000 }] })).toMatchObject({ state: "working", lines: [{ kind: "wait", text: "A command runs in the background", ts: 70_000 }] });
  // The word follows the session's one state where that says more.
  expect(nowLines({ ...quiet, watch: "wait" }).state).toBe("waiting");
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 1, status: { kind: "idle" } }, watch: "need" }).state).toBe("owner");
  // A secret to give waits on the owner; a failed turn that resumes by itself says until when.
  expect(nowLines({ ...quiet, secrets: [{ id: "c9", created: 60_000 }] })).toMatchObject({ state: "owner", lines: [{ kind: "question", tone: "owner", text: "Needs you: a secret" }] });
  const resumes = nowLines({ ...quiet, watch: "wait", resumes: { at: 100_000 + 12 * 60_000, since: 90_000 } });
  expect(resumes.state).toBe("waiting");
  expect(timelineText({ session_id: "s", as_of: 100_000, now: resumes, rows: [], next: null } as any)).toContain("Resumes by itself when the wait the provider asked for is over, for 10 s, due in 12 min");
  // The word is the session's state: a stopped session is stopped whatever waits under it, and a loop or a held queue is a line, not a word.
  expect(nowLines({ ...quiet, watch: "stop", waits: [{ id: "w", kind: "timer", created: 1, deadline: 100_000 + 11 * 60_000 + 60_000 }], queue: { queued: 1, steers: 0, held: true, owed: false } }).state).toBe("stopped");
  expect(nowLines({ ...quiet, watch: "done", loops: [{ id: "l", name: "Daily", next_ms: 200_000 }] })).toMatchObject({ state: "done", lines: [{ kind: "loop" }] });
  expect(nowLines({ ...quiet, watch: "fail", waits: [{ id: "w", kind: "timer", created: 1, deadline: 200_000 }] }).state).toBe("failed");
  expect(nowLines({ ...quiet, watch: "declined" }).state).toBe("declined");
  expect(nowLines({ ...quiet, watch: "resume" }).state).toBe("resume");
  // One clock for a timer: it is due at its wake time, a minute before its deadline.
  const timed = nowLines({ ...quiet, waits: [{ id: "w", kind: "timer", created: 40_000, deadline: 100_000 + 15 * 60_000 + 60_000 }] });
  expect(timed.lines[0]).toMatchObject({ until: 100_000 + 15 * 60_000 });
  expect(timelineText({ session_id: "s", as_of: 100_000, now: timed, rows: [], next: null } as any)).toContain("Waiting for a timer, for 1 min, due in 15 min");
  // A line that says how long a silence has lasted is not given the turn's time after it.
  const silent = nowLines({ ...quiet, ts: 100_000, turn: { id: "t1", ts: 40_000, steps: 0, status: { kind: "model", since: 79_000, model: "m", connected: 79_000, quiet: 79_000 } } });
  expect(timelineText({ session_id: "s", as_of: 100_000, now: silent, rows: [], next: null } as any).split("\n")[2]).toMatch(/no output for 21 s  \[turn=t1\]$/);
  // A parked agent: what it waits for, and until when.
  const parked = nowLines({ ...quiet, agents: [{ id: "a1", session_id: "c1", title: "Scout", status: "waiting", created: 40_000, wait: { kind: "timer", until: 100_000 + 42 * 60_000 } }, { id: "a2", session_id: "c2", title: "Other", status: "waiting", created: 40_000 }] });
  expect(parked.lines.map((l) => l.text)).toEqual(['Agent "Scout" is waiting for a timer', 'Agent "Other" is waiting for a wake of its own']);
  expect(timelineText({ session_id: "s", as_of: 100_000, now: parked, rows: [], next: null } as any).split("\n")[2]).toContain('Agent "Scout" is waiting for a timer, for 1 min, due in 42 min');
  // A call of the turn whose card is open has not started: the turn waits on the answer, it does not run the tool.
  const asking = nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 1, status: { kind: "tool", since: 1, names: ["Bash"] } }, approvals: [{ id: "p1", tool: "Bash" }] });
  expect(asking.lines.map((l) => l.text)).toEqual(["Needs you: an approval for Bash", "Running a turn started by the owner: step 1, needs you: an approval"]);
  // An agent's open card does not mean this session's own call waits.
  expect(nowLines({ ...quiet, turn: { id: "t1", ts: 1, steps: 1, status: { kind: "tool", since: 1, names: ["Agent"] } }, approvals: [{ id: "p1", tool: "Bash", child_session: "c1" }] }).lines[1]!.text).toBe("Running a turn started by the owner: step 1, running Agent");
  // A cut turn that was not continued is said here, and names the note so its row is not shown too.
  expect(nowLines({ ...quiet, held: { since: 5, note_id: "n1" } }).lines[0]).toMatchObject({ kind: "restart", tone: "owner", refs: { note_id: "n1" } });
  // Taken up by the engine and not opened yet: it is starting, not idle.
  expect(nowLines({ ...quiet, starting: true, last: { ts: 90_000, outcome: "ok" } })).toMatchObject({ state: "working", lines: [{ kind: "turn", tone: "live", text: "Starting a turn" }] });
  const idle = nowLines({ ...quiet, last: { ts: 90_000, outcome: "error" } });
  expect(idle).toMatchObject({ state: "failed", lines: [{ kind: "idle", text: "Nothing is running or waited on. The last turn failed." }] });
  expect(nowLines({ ...quiet, waits: [{ id: "w", kind: "file", created: 1, deadline: 2 }] }).state).toBe("waiting");
  expect(nowLines({ ...quiet, queue: { queued: 1, steers: 0, held: true, owed: false } }).lines[0]).toMatchObject({ tone: "owner", text: "1 queued prompt waits: the queue is held until the owner resumes it" });
});

test("the text form: a line a row, with the ids that open its detail or that a coordinator acts on", () => {
  const rows = [
    turnRow({ start: { id: "t2", ts: Date.UTC(2026, 0, 2, 14, 32, 7) }, opener: { kind: "wait" }, end: { reason: "end_turn", ms: 180_000 }, usage: { cost: 0.0312 }, steps: 14, tools: 20, failed_tools: 2 }),
    errorRow({ id: "e1", ts: Date.UTC(2026, 0, 2, 14, 30, 59), source: "provider", message: "429 rate limit" }),
  ];
  const now = nowLines({ ...quiet, ts: 100_000, approvals: [{ id: "p1", tool: "Bash", created: 40_000, child_session: "c1", child_title: "Check the parser" }], waits: [{ id: "w1", kind: "timer", created: 70_000, deadline: 400_000 }] });
  const page = { session_id: "s1", as_of: Date.UTC(2026, 0, 2, 14, 40, 0), now, rows, next: "5:x" };
  expect(timelineText({ ...page, now: { ...now, lines: now.lines.map((l) => ({ ...l, ts: page.as_of - 60_000, until: l.until && page.as_of + 300_000 })) } }, { title: "Parser work" }).split("\n")).toEqual([
    `Timeline of session "Parser work" (s1), newest first. Times are local (${zoneLabel(page.as_of)}); read at ${localStamp(page.as_of)}.`,
    "Now: needs you.",
    '  Needs you: an approval for Bash, in agent "Check the parser", for 1 min  [approval=p1 session=c1]',
    "  Waiting for a timer, for 1 min, due in 5 min  [wait=w1]",
    `${localStamp(rows[0]!.ts).slice(5)}   Wait wake, 14 steps, 2 failed tools, 3 min, $0.03  [turn=t2]`,
    `${localStamp(rows[1]!.ts).slice(5)} ! Model request error (rate limit)  [error=e1]`,
    "Older rows: before=5:x",
  ]);
  // Without ids: for a model that only reads.
  const bare = timelineText(page, { ids: false });
  expect(bare).not.toMatch(/\[(turn|error|wait|approval|session)=/);
  expect(bare).toContain(`${localStamp(rows[0]!.ts).slice(5)}   Wait wake, 14 steps, 2 failed tools, 3 min, $0.03\n`);
  // A filtered read that stopped at its bound with nothing says how far it looked.
  expect(timelineText({ session_id: "s1", as_of: 0, rows: [], next: "5:x", scanned: 500 })).toContain("None in the newest 500 rows.");
  expect(timelineText({ session_id: "s1", as_of: 0, rows: [], next: null })).toContain("No rows.");
});

test("a turn's outcome class is the one its telemetry row records", () => {
  for (const reason of ["end_turn", "stop", "stop_sequence", "error", "interrupted", "restart", "max_steps", "max_tokens", "refusal", "tool_use", "pause_turn", "model_context_window_exceeded", "anything"]) {
    for (const by of [undefined, null, "owner", "parent", "time_limit"]) expect(outcomeOf(reason, by)).toBe(recorded(reason, by));
  }
});

test("durations read as a person says them", () => {
  expect([850, 4_200, 180_000, 4_320_000, 3_600_000, 183_600_000].map(dur)).toEqual(["850 ms", "4 s", "3 min", "1 h 12 min", "1 h", "2 d 3 h"]);
});

test("a turn is about the first words of the owner's prompt, and of no one else's", () => {
  expect(aboutOf("  Fix the\nretry   test. ")).toBe("Fix the retry test.");
  const long = aboutOf(`Why does the export stall on the big tenant ${"and then ".repeat(20)}stop`)!;
  expect(long.length).toBeLessThanOrEqual(ABOUT_MAX + 3);
  expect(long.endsWith("...")).toBe(true);
  expect(aboutOf("")).toBeUndefined();
  expect(aboutOf(undefined)).toBeUndefined();
  // Stored without a kind, still not the owner's words.
  expect(aboutOf('<external_input source="peer_session" from="abc">do this</external_input>')).toBeUndefined();
  expect(aboutOf("[harness] The wait the provider asked for is over.")).toBeUndefined();
  const start = { id: "t1", ts: 1 };
  expect(turnRow({ start, opener: { about: "Fix the retry test" }, end: { reason: "end_turn" }, steps: 1, tools: 0, failed_tools: 0 }).about).toBe("Fix the retry test");
  expect(turnRow({ start, opener: { kind: "subagent" }, end: { reason: "end_turn" }, steps: 1, tools: 0, failed_tools: 0 }).about).toBeUndefined();
});

test("what is new since a reader's last read: rows begun since, a turn that ended since, and one line when nothing is", () => {
  const mark = new Date(2026, 10, 22, 7, 7, 3).getTime();
  const row = (o: Partial<TimelineRow> & { id: string; ts: number }): TimelineRow => ({ kind: "agent", sub: "completed", tone: "plain", text: "Agent \"Lane\" reported", ...o });
  // A turn that ran at the last read (it was under "now" then) and ended since is new; one that had ended is not.
  expect(newSince(row({ id: "a", ts: mark + 1 }), mark)).toBe(true);
  expect(newSince(row({ id: "b", ts: mark - 5000 }), mark)).toBe(false);
  expect(newSince(row({ id: "c", ts: mark - 5000, kind: "turn", ms: 9000 }), mark)).toBe(true);
  expect(newSince(row({ id: "d", ts: mark - 5000, kind: "turn", ms: 1000 }), mark)).toBe(false);
  const page = { session_id: "s1", as_of: mark + 120_000, now: { state: "waiting" as const, lines: [] }, rows: [], next: null };
  expect(timelineText(page, { title: "Dozen lanes", fresh: { since: mark } })).toBe('Nothing new in session "Dozen lanes" since you last read it at 07:07:03 (2 min ago). Now: waiting.');
  const some = timelineText({ ...page, rows: [row({ id: "a", ts: mark + 1000 })] }, { title: "Dozen lanes", fresh: { since: mark } }).split("\n");
  expect(some[0]).toStartWith('Timeline of session "Dozen lanes" (s1), new since you last read it at 07:07:03, newest first. Times are local');
  expect(some).toHaveLength(3);
  // No earlier read is kept (the first one): every row, and the answer says so.
  expect(timelineText(page, { title: "Dozen lanes", fresh: { since: null } }).split("\n")[0]).toContain("newest first (no earlier read of yours is kept: every row).");
});

test("a turn whose requests were sent again says how many it made and how many failed", () => {
  // Twice overloaded, then answered: it read "Owner prompt, 1 step", as a turn of one request.
  const retried = turnRow({ start, opener: {}, end: { reason: "end_turn" }, steps: 1, tools: 0, failed_tools: 0, requests: 3, failed_requests: 2 });
  expect(retried.text).toBe("Owner prompt, 1 step, 3 requests, 2 failed");
  expect(retried.turn).toMatchObject({ steps: 1, requests: 3, failed_requests: 2 });
  // A turn with no failed attempt says its steps only.
  const plain = turnRow({ start, opener: {}, end: { reason: "end_turn" }, steps: 2, tools: 0, failed_tools: 0, requests: 2, failed_requests: 0 });
  expect(plain.text).toBe("Owner prompt, 2 steps");
  expect(plain.turn!.failed_requests).toBeUndefined();
});

test("a turn the end of a waited-on command started says so, not \"Harness note\"", () => {
  const woke = turnRow({ start, opener: { kind: "harness", job: "b1x2" }, end: { reason: "end_turn" }, steps: 1, tools: 0, failed_tools: 0 });
  expect(woke.text).toBe("Command ended, 1 step");
  expect(originOf({ kind: "harness", job: "b1x2" })).toMatchObject({ key: "command", words: "the end of a command it waited on" });
  // Any other harness input is as it was.
  expect(originOf({ kind: "harness", agent_id: "a1" }).key).toBe("harness");
});
