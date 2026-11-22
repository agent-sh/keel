// The vocabulary: one word per state, the same for a session and an agent,
// and counts that add up.
import { expect, test } from "bun:test";
import { stateOf, type SessionState, type Watch } from "./watch.ts";
import { stateWord } from "../automation/state.ts";
import { ALERT_GROUPS, COUNTERS, STATE_WORD, agentState, agentWhy, alertGroup, alertWord, askAction, backgroundWord, countName, countWord, heldWords, inBackground, queuedWord, stateAlone, stateLabel, stateWords, agentTally as tally, waitsOnOwner, wentWrongWord } from "./state-words.ts";

const st = (watch: Watch, more: Partial<SessionState> = {}): SessionState => ({ watch, agents: 0, ...more });

test("each state has one word, in sentence case, and no two states of work share another", () => {
  for (const w of Object.values(STATE_WORD)) expect(w).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
  // The words the vocabulary retired are no state's word.
  for (const old of ["Running", "Asks you", "Finished", "Steer", "Idle"]) expect(Object.values(STATE_WORD)).not.toContain(old);
  expect(stateWords(st("work")).word).toBe("Working");
  expect(stateWords(st("done")).phrase).toBe("Done");
  expect(stateWords(st("idle")).phrase).toBe("Not started");
  expect(stateWords(st("declined")).phrase).toBe("Declined");
});

test("a state says what it is with: what it needs, what it waits for, how it failed", () => {
  expect(stateWords(st("need", { why: "approval" }))).toEqual({ watch: "need", word: "Needs you", what: "an approval", phrase: "Needs you: an approval" });
  expect(stateWords(st("need", { why: "question" })).what).toBe("a question");
  expect(stateWords(st("need", { why: "plan" })).what).toBe("a plan");
  expect(stateWords(st("need", { why: "secret" })).what).toBe("a secret");
  expect(stateWords(st("wait", { why: "timer" })).phrase).toBe("Waiting for a timer");
  expect(stateWords(st("wait", { why: "wait", on: "file" })).phrase).toBe("Waiting for a file");
  expect(stateWords(st("wait", { why: "agent" })).phrase).toBe("Waiting for an agent");
  expect(stateWords(st("wait", { why: "wait" })).phrase).toBe("Waiting");
  expect(stateWords(st("resume")).phrase).toBe("Waiting to resume");
  // One fixed word a class: a failure of the account is billing wherever it is said.
  expect(stateWords(st("fail", { cls: "quota" })).phrase).toBe("Failed: billing");
  expect(stateWords(st("fail", { cls: "other" })).phrase).toBe("Failed");
  expect(stateWords(st("stop", { why: "max_steps" })).phrase).toBe("Stopped at the step budget");
});

test("a command left in the background and a request on its way are work, never waiting", () => {
  const s = { id: "s", phase: "idle", settings: { last_end: "end_turn" }, usage: { output: 1 } } as never;
  const bg = stateOf(s, undefined, { pending: [{ kind: "command", text: "make test", since: 3 }] });
  expect(stateWords(bg)).toMatchObject({ word: "Working", what: "command in background" });
  expect(bg.text).toBe("Command in background: make test");
  expect(stateWord(bg)).toBe("working (command in background)");
  const calling = stateOf({ ...(s as object), phase: "working" } as never, undefined, { status: { kind: "model", since: 9, model: "m" }, turn: 1 });
  expect(stateWords(calling).word).toBe("Working");
  expect(calling.text).not.toMatch(/wait/i);
});

test("a tool hears the same words as the page", () => {
  expect(stateWord(st("need", { why: "approval" }))).toBe("needs you (an approval)");
  expect(stateWord(st("wait", { why: "timer" }))).toBe("waiting for a timer");
  expect(stateWord(st("wait", { why: "wait", on: "file" }))).toBe("waiting for a file");
  expect(stateWord(st("fail", { cls: "quota" }))).toBe("failed (billing)");
  expect(stateWord(st("done"))).toBe("done");
});

test("the head counts the agents that work, of how many, so the number beside it is the same", () => {
  expect(stateLabel(st("work", { agents: 3, parked: 1 }))).toBe("Working · 2 of 3 agents");
  expect(stateLabel(st("work", { agents: 1 }))).toBe("Working · 1 agent");
  expect(stateLabel(st("work", { agents: 3 }))).toBe("Working · 3 agents");
  expect(stateLabel(st("work", { agents: 2, parked: 2 }))).toBe("Working");
  expect(stateLabel(st("need", { agents: 3 }))).toBe("Needs you");
});

test("where the word stands alone, a session that only keeps a command going says so and is counted apart", () => {
  const bg = st("work", { why: "command" });
  expect(stateLabel(bg)).toBe("Working");
  expect(stateAlone(bg)).toBe("Command in background");
  expect(stateAlone(st("work", { agents: 2 }))).toBe("Working · 2 agents");
  expect(stateAlone(st("wait", { why: "timer" }))).toBe("Waiting");
  expect([inBackground(bg), inBackground(st("work", { why: "tool" })), inBackground(undefined)]).toEqual([true, false, false]);
  expect(backgroundWord(1)).toBe("1 in background");
});

test("what waits on the owner is one count of things, each once", () => {
  // A session with three requests is three; a session that works or failed is none.
  expect(waitsOnOwner([st("need", { asks: 3 }), st("need"), st("work"), st("fail"), undefined])).toBe(4);
  expect(waitsOnOwner([])).toBe(0);
  expect(countWord("need", 1)).toBe("1 needs you");
  expect(countWord("need", 4)).toBe("4 need you");
  expect(countName("fail", 2)).toBe("failed");
  // Sessions that went wrong: failed, declined by the model, or both, said as what they are.
  expect([wentWrongWord(2, 0), wentWrongWord(0, 1), wentWrongWord(1, 1)]).toEqual(["failed", "declined", "failed or declined"]);
  expect(queuedWord(2)).toBe("2 queued");
});

test("an agent's word is its session's, so every surface agrees", () => {
  // Live: what its session needs or does wins over the record's bare status.
  expect(agentState({ status: "running" }, st("need", { why: "approval", text: "Approve Bash: git push" })).watch).toBe("need");
  expect(stateWords(agentState({ status: "running" }, undefined)).word).toBe("Working");
  expect(stateWords(agentState({ status: "waiting" }, st("wait", { why: "timer" }))).phrase).toBe("Waiting for a timer");
  expect(stateWords(agentState({ status: "waiting" }, undefined)).word).toBe("Waiting");
  // A live record whose session is told at rest (the end is being settled) still works.
  expect(agentState({ status: "running" }, st("done")).watch).toBe("work");
  // Ended: the record is the word, the session's failure the class.
  expect(stateWords(agentState({ status: "completed" }, st("done"))).word).toBe("Done");
  expect(stateWords(agentState({ status: "failed" }, st("fail", { cls: "quota" }))).phrase).toBe("Failed: billing");
  expect(stateWords(agentState({ status: "failed" }, undefined)).word).toBe("Failed");
  expect(stateWords(agentState({ status: "stopped", stopped_by: "owner" }, undefined)).word).toBe("Stopped");
  expect(agentWhy({ status: "stopped", stopped_by: "owner" })).toBe("You stopped this agent");
  // One that did not finish reads as its session does: declined, failed at the output limit, stopped at its budget.
  expect(stateWords(agentState({ status: "incomplete", end_reason: "refusal" }, undefined)).word).toBe("Declined");
  expect(stateWords(agentState({ status: "incomplete", end_reason: "max_tokens" }, undefined)).phrase).toBe("Failed: output limit");
  expect(stateWords(agentState({ status: "incomplete", end_reason: "max_steps" }, undefined)).phrase).toBe("Stopped at the step budget");
});

test("a summary counts every agent once, so its numbers add up, and hides no state", () => {
  const eight: Watch[] = ["work", "work", "work", "wait", "wait", "fail", "need", "done"];
  const t = tally(eight);
  expect(t.text).toBe("8 agents: 1 needs you, 1 failed, 3 working, 2 waiting, 1 done");
  expect(t.parts.reduce((n, p) => n + p.n, 0)).toBe(t.total);
  // What needs the owner and what failed stand first: a line cut short still says them.
  expect(t.parts.map((p) => p.w).slice(0, 2)).toEqual(["need", "fail"]);
  // A state with none is left out; one agent is not "agents".
  expect(tally(["done"]).text).toBe("1 agent: 1 done");
  expect(tally(["need", "need", "stop", "resume", "declined"]).text).toBe("5 agents: 2 need you, 1 declined, 1 waiting, 1 stopped");
  expect(tally([]).text).toBe("");
});

test("a message that waits says when it is taken", () => {
  expect(heldWords({ steer: true })).toEqual({ word: "Queued", when: "held until its current step ends" });
  expect(heldWords({ steer: false })).toEqual({ word: "Queued", when: "held until its turn ends" });
  expect(heldWords({ steer: true, held: true }).when).toBe("held until it is resumed");
});

test("each counter says the one thing it counts", () => {
  expect(COUNTERS.waiting(3)).toBe("3 things wait on you: approvals, questions, plans and secrets");
  expect(COUNTERS.waiting(1)).toMatch(/^1 thing waits on you/);
  expect(COUNTERS.unread(12)).toBe("12 unread: new since you last looked");
  expect(COUNTERS.errors(1)).toBe("1 error in Keel you have not looked at");
  expect(COUNTERS.errors(0)).toBe("No new errors in Keel");
});

test("the inbox puts what still waits on the owner above everything else, read or not", () => {
  // In the order they came: an approval that waits and was looked at, two finishes, an approval that waits, a question that was answered, a failure, a finish that was seen.
  const alerts = [
    { kind: "approval", read: true, open: true }, { kind: "finished", read: false }, { kind: "finished", read: false },
    { kind: "approval", read: false, open: true }, { kind: "question", read: true }, { kind: "failed", read: false }, { kind: "finished", read: true },
  ];
  const order = [...alerts].sort((a, b) => ALERT_GROUPS.indexOf(alertGroup(a)) - ALERT_GROUPS.indexOf(alertGroup(b)));
  expect(order.map(alertGroup)).toEqual(["need", "need", "new", "new", "new", "seen", "seen"]);
  // Looking at a request does not answer it; an answered one waits no more, unread or not.
  expect(alertGroup({ kind: "approval", read: true, open: true })).toBe("need");
  expect(alertGroup({ kind: "approval", read: true })).toBe("seen");
  expect(alertGroup({ kind: "approval", read: false })).toBe("new");
});

test("an alert says what it is: a plan, a secret, a turn the model declined", () => {
  expect(alertWord({ kind: "question", read: false })).toBe("Question");
  expect(alertWord({ kind: "question", read: false, data: { plan_id: "p" } })).toBe("Plan");
  expect(alertWord({ kind: "question", read: false, data: { secret_id: "c" } })).toBe("Secret");
  expect(alertWord({ kind: "finished", read: false })).toBe("Done");
  expect(alertWord({ kind: "finished", read: false }, true)).toBe("Declined");
  expect(alertWord({ kind: "declined", read: false })).toBe("Declined");
  expect(alertWord({ kind: "failed", read: false })).toBe("Failed");
  expect([askAction({ kind: "approval", read: false }), askAction({ kind: "question", read: false }), askAction({ kind: "question", read: false, data: { plan_id: "p" } }), askAction({ kind: "question", read: false, data: { secret_id: "c" } })])
    .toEqual(["Review", "Answer", "Review", "Open"]);
});
