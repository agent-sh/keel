import { expect, test } from "bun:test";
import type { Session } from "./types.ts";
import { askBrief, askText, briefText, clockText, LIST_TIER, liveAgentCounts, pendingText, span, stateLine, stateOf, WATCH_LABEL, watchLabel, watchOf, watchWord, whyText } from "./watch.ts";

const s = (over: Partial<Session> = {}): Session => ({
  id: "p", title: "", model: "m", workspace: "/w", created: 0, updated: 0, phase: "idle", archived: false,
  usage: { input: 0, output: 10 } as Session["usage"], head: null, settings: { last_end: "end_turn" }, ...over,
});

test("a parent whose turn ended works while its agents do", () => {
  expect(watchOf(s(), undefined)).toBe("done");
  expect(watchOf(s(), undefined, { agents: 2 })).toBe("work");
  // A failed or stopped turn with agents still at work is working too; a card waiting is still the owner's.
  expect(watchOf(s({ settings: { failed_ms: 1, last_end: "error" } }), undefined, { agents: 1 })).toBe("work");
  expect(watchOf(s(), undefined, { agents: 1, approvals: 1 })).toBe("need");
  expect(watchOf(s({ phase: "working" }), undefined, { asking: true, agents: 1 })).toBe("need");
});

test("the words name the agents", () => {
  expect(watchLabel("work", 3)).toBe("Working · 3 agents");
  expect(watchLabel("work", 1)).toBe("Working · 1 agent");
  expect(watchLabel("done", 0)).toBe("Done");
  expect(watchWord("work", 1)).toBe("working, 1 agent is still at work");
  expect(watchWord("work", 2, "working (tool)")).toBe("working (tool), 2 agents are still at work");
  expect(liveAgentCounts([{ parent_id: "a", status: "running" }, { parent_id: "a", status: "waiting" }, { parent_id: "a", status: "completed" }, { parent_id: "b", status: "stopped" }])).toEqual({ a: 2 });
});

test("what waits on the owner leads the state, oldest first, in one form", () => {
  const st = stateOf(s({ phase: "working" }), undefined, { agents: 1, asks: [
    { kind: "question", text: "Which database?", since: 20 },
    { kind: "plan", text: "Resumable uploads", since: 10 },
  ] });
  expect(st).toEqual({ watch: "need", agents: 1, why: "plan", text: "Plan to approve: Resumable uploads, and 1 more", asks: 2, since: 10 });
  expect(askText({ kind: "approval", text: "Bash: rm -rf dist" })).toBe("Approve Bash: rm -rf dist");
  expect(askText({ kind: "question", text: "Which\n database?" })).toBe("Question: Which database?");
  expect(askText({ kind: "plan" })).toBe("Plan to approve");
  expect(askText({ kind: "unsent" })).toBe("A message was not sent");
  // An agent's card names the agent it waits in.
  expect(stateOf(s(), undefined, { asks: [{ kind: "approval", text: "Bash: ls", child: "c", agent: "Scout" }] })).toMatchObject({ watch: "need", child: "c", text: "Agent Scout: Approve Bash: ls" });

});

test("a pane's head names the call its card shows whole: the kind and the tool, and how many more", () => {
  const two = stateOf(s(), undefined, { asks: [{ kind: "approval", text: "Bash: git push origin HEAD:retry-cap", since: 1 }, { kind: "question", text: "Which?", since: 2 }] });
  expect(askBrief(two, "Bash")).toBe("Approve Bash, and 1 more");
  const agent = stateOf(s(), undefined, { asks: [{ kind: "approval", text: "Bash: ls", child: "c", agent: "Push: the branch" }] });
  expect(askBrief(agent, "Bash")).toBe("Agent Push: the branch: Approve Bash");
  // Another tool's card, or a text of another shape, leaves the reason whole.
  expect(askBrief(agent, "Edit")).toBe("Agent Push: the branch: Approve Bash: ls");
  expect(askBrief({ watch: "need", why: "question", text: "Question: Which?" }, "Bash")).toBe("Question: Which?");
});

test("a session whose turn ended waits while something it set up will wake it", () => {
  const timer = { kind: "timer", text: "check the deploy", since: 5, until: 900 };
  const command = { kind: "command", text: "make test", since: 3 };
  const file = { kind: "file", text: "the build marker", since: 9 };
  // What is due first leads; the rest is counted. A wait that is not a timer says its kind.
  expect(stateOf(s(), undefined, { pending: [file, timer] })).toEqual({ watch: "wait", agents: 0, why: "timer", text: "Timer: check the deploy, and 1 more", since: 5, until: 900 });
  expect(stateOf(s(), undefined, { pending: [file] })).toEqual({ watch: "wait", agents: 0, why: "wait", on: "file", text: "File: the build marker", since: 9 });
  // A command it left running in the background is work, not a wait, whatever else is armed.
  expect(stateOf(s(), undefined, { pending: [command, timer] })).toEqual({ watch: "work", agents: 0, why: "command", text: "Command in background: make test", since: 3 });
  expect(stateOf(s(), undefined, { pending: [command, { ...command, since: 4 }] })).toMatchObject({ watch: "work", why: "command", text: "Command in background: make test, and 1 more" });
  // A failure or the owner's Stop is still said first.
  expect(stateOf(s({ settings: { failed_ms: 1, last_end: "error" } }), undefined, { pending: [command] }).watch).toBe("fail");
  expect(stateOf(s({ settings: { last_end: "interrupted" } }), undefined, { pending: [command] }).watch).toBe("stop");
  // An agent that waits is waited on, with what it waits for; one that runs is work.
  expect(stateOf(s(), undefined, { agents: 1, parked: 1, pending: [{ kind: "timer", until: 50, agent: "Scout" }] })).toMatchObject({ watch: "wait", why: "agent", text: "Agent Scout: timer", until: 50 });
  // The head counts the agents that work: one of the two here.
  expect(stateOf(s(), undefined, { agents: 2, parked: 1, pending: [{ kind: "timer", agent: "Scout" }] })).toMatchObject({ watch: "work", agents: 2, parked: 1 });
  // A running turn works, a stopped one stays stopped, a card is still the owner's.
  expect(stateOf(s({ phase: "working" }), undefined, { pending: [timer] }).watch).toBe("work");
  expect(stateOf(s({ settings: { last_end: "interrupted" } }), undefined, { pending: [timer] }).watch).toBe("stop");
  expect(stateOf(s(), undefined, { pending: [timer], asks: [{ kind: "plan" }] }).watch).toBe("need");
});

test("a command given no description is named in words, its shell text kept for the tooltip", () => {
  const raw = { kind: "command", text: "sleep 3000 && echo built", raw: true, since: 3 };
  const said = { kind: "command", text: "Wait for the build", since: 4 };
  // Its own shell text is the whole reason; the brief says what it is.
  const st = stateOf(s(), undefined, { pending: [raw] });
  expect(st).toEqual({ watch: "work", agents: 0, why: "command", text: "Command in background: sleep 3000 && echo built", brief: "Command in background", since: 3 });
  expect(briefText(st)).toBe("Command in background");
  expect(whyText(st)).toBe("Command in background: sleep 3000 && echo built");
  // The brief counts the rest as the whole does.
  expect(stateOf(s(), undefined, { pending: [raw, said] })).toMatchObject({ text: "Command in background: sleep 3000 && echo built, and 1 more", brief: "Command in background, and 1 more" });
  // A command with a description is words already: no brief, and the whole is what a head shows.
  const words = stateOf(s(), undefined, { pending: [said] });
  expect(words.brief).toBeUndefined();
  expect(briefText(words)).toBe("Command in background: Wait for the build");
  // An agent's command: the agent is named, its shell text is not.
  const agent = stateOf(s(), undefined, { agents: 1, parked: 1, pending: [{ ...raw, agent: "Scout" }] });
  expect(agent).toMatchObject({ watch: "wait", why: "agent", text: "Agent Scout: command: sleep 3000 && echo built", brief: "Agent Scout: command in background" });
  expect(pendingText({ ...said, agent: "Scout" }, true)).toBe("Agent Scout: command: Wait for the build");
});

test("a running turn says what it does now, and a stream that went silent says for how long", () => {
  const on = s({ phase: "working" });
  expect(stateOf(on, undefined, { status: { kind: "tool", since: 7, names: ["Bash"] }, turn: 1 })).toEqual({ watch: "work", agents: 0, why: "tool", text: "Running Bash", since: 7 });
  expect(stateOf(on, undefined, { status: { kind: "model", since: 9, model: "m" }, turn: 1 })).toMatchObject({ why: "model", text: "Calling the model", since: 9 });
  expect(stateOf(on, undefined, { status: { kind: "idle" }, turn: 1, output: 5 })).toEqual({ watch: "work", agents: 0, why: "turn", text: "The model is answering", since: 1 });
  const stalled = stateOf(on, undefined, { status: { kind: "model", since: 60_000, model: "m", connected: 60_000, quiet: 60_000 }, turn: 1 });
  expect(stalled).toMatchObject({ watch: "work", why: "stalled", since: 60_000 });
  expect(whyText(stalled, 100_000)).toBe("The model is answering, no output for 40s");
});

test("a failure is not hidden by a wait still armed; a provider's wait that ends by itself is waiting", () => {
  const failed = s({ settings: { failed_ms: 500, last_end: "error" } });
  const timer = { kind: "timer", text: "poll the queue", since: 5, until: 900 };
  // Billing failed while a timer is armed: Failed, with its class, not Waiting.
  expect(stateOf(failed, undefined, { pending: [timer], failure: { cls: "quota", text: "HTTP 402: no credit", at: 500 } })).toEqual({ watch: "fail", agents: 0, why: "quota", cls: "quota", text: "HTTP 402: no credit", since: 500 });
  expect(stateOf(failed, undefined, { pending: [timer] }).watch).toBe("fail");
  // The provider asked for a long wait and the session continues by itself: waiting, until then.
  const resumes = s({ settings: { failed_ms: 500, last_end: "error", continue_at: { at: 9000, after: "e1" } } as Session["settings"] });
  const st = stateOf(resumes, undefined, { failure: { cls: "rate_limit", at: 500 }, pending: [timer] });
  expect(st).toEqual({ watch: "wait", agents: 0, why: "resume", text: "Resumes by itself", since: 500, until: 9000, cls: "rate_limit" });
  expect(whyText(st)).toMatch(/^Resumes by itself at \d\d:\d\d$/);
  // It gave up after its rounds, or the owner called it off: the mark is gone and it is Failed.
  expect(stateOf(failed, undefined, { failure: { cls: "rate_limit", at: 500 } }).watch).toBe("fail");
  // A secret to give is asked of the owner like a question; a turn whose every call waits on them needs them too.
  expect(stateOf(s({ phase: "working" }), undefined, { asks: [{ kind: "secret", text: "DEPLOY_KEY", since: 3 }] })).toMatchObject({ watch: "need", why: "secret", text: "Secret to give: DEPLOY_KEY" });
  expect(stateOf(s({ phase: "working" }), undefined, { asking: true, owner: true })).toEqual({ watch: "need", agents: 0, why: "owner", text: "Waits for your answer", asks: 1 });
});

test("a turn the model declined, cut at the output limit or stopped at its step budget is not done", () => {
  expect(stateOf(s({ settings: { last_end: "refusal" } }), undefined)).toEqual({ watch: "declined", agents: 0, why: "refusal", text: "The model declined the turn" });
  expect(stateOf(s({ settings: { last_end: "max_tokens" } }), undefined)).toEqual({ watch: "fail", agents: 0, why: "max_tokens", cls: "max_tokens", text: "Cut at the output limit" });
  expect(stateOf(s({ settings: { last_end: "max_steps" } }), undefined)).toEqual({ watch: "stop", agents: 0, why: "max_steps", text: "The step budget ran out" });
  // The same from the events of a loaded session.
  const ended = (reason: string) => [{ kind: "user", data: {} }, { kind: "turn_start", data: {} }, { kind: "turn_end", data: { reason } }] as any;
  expect(stateOf(s(), ended("refusal")).watch).toBe("declined");
  expect(stateOf(s(), ended("max_tokens")).watch).toBe("fail");
  expect(stateOf(s(), ended("end_turn")).watch).toBe("done");
  // Declined is a failure under its own word: ranked and listed with the failed ones.
  expect(WATCH_LABEL.declined).toBe("Declined");
  expect(LIST_TIER.declined).toBe(LIST_TIER.fail);
  expect(stateLine(stateOf(s({ settings: { last_end: "refusal" } }), undefined))).toBe("declined: The model declined the turn");
});

test("a turn a restart cut that was not continued needs the owner; a stopped session says what its queue holds", () => {
  const cut = s({ settings: { last_end: "restart" } });
  expect(stateOf(cut, undefined).watch).toBe("resume");
  expect(stateOf(cut, undefined, { held: { text: "continued three times in a row", since: 70 } })).toEqual({ watch: "need", agents: 0, why: "resume", text: "Resume the turn a restart cut", asks: 1, since: 70 });
  const stopped = s({ settings: { last_end: "interrupted" } });
  expect(stateOf(stopped, undefined, { queue: { held: true, queued: 2 } })).toEqual({ watch: "stop", agents: 0, why: "held", text: "2 queued prompts wait until you resume" });
  expect(stateOf(stopped, undefined, { queue: { held: true, queued: 0 }, pending: [{ kind: "timer", until: 5 }] })).toEqual({ watch: "stop", agents: 0 });
});

test("one clock: a retry says when it goes again, a connected model is answering, minutes round as the timeline's do", () => {
  const on = s({ phase: "working" });
  expect(stateOf(on, undefined, { status: { kind: "retry", attempt: 1, max: 9, at: 4000, message: "429" }, turn: 1 })).toEqual({ watch: "work", agents: 0, why: "retry", text: "Retry 1 of 9 of the model request", since: 1, until: 4000 });
  expect(stateOf(on, undefined, { status: { kind: "model", since: 9, model: "m", connected: 10 }, turn: 1 }).text).toBe("The model is answering");
  expect([span(59_000), span(90_000), span(41.6 * 60_000), span(3_600_000), span(26 * 3_600_000)]).toEqual(["59s", "2m", "42m", "1h 00m", "1d"]);
  expect(clockText({ watch: "wait", agents: 0, until: 16 * 60_000 }, 60_000)).toBe("due in 15m");
  // Agents that run with a reason of their own (a goal's check) say it.
  expect(stateOf(s(), undefined, { agents: 1, running: "Checking that the goal is met" })).toEqual({ watch: "work", agents: 1, why: "agents", text: "Checking that the goal is met" });
});
