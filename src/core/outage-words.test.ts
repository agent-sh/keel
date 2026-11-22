// A provider that cannot be reached, as the state says it: a session's own turn, its agents, and the words.
import { expect, test } from "bun:test";
import { agentState, stateLabel, stateWords } from "./state-words.ts";
import type { Session } from "./types.ts";
import { hhmm, stateLine, stateOf, whyText } from "./watch.ts";

const s = (over: Partial<Session> = {}): Session => ({
  id: "p", title: "", model: "m", workspace: "/w", created: 0, updated: 0, phase: "idle", archived: false,
  usage: { input: 0, output: 10 } as Session["usage"], head: null, settings: { last_end: "end_turn" }, ...over,
});
const since = new Date(2026, 10, 22, 16, 56).getTime();

test("a turn whose provider cannot be reached waits, with since when, and is not said to work or to have failed", () => {
  const st = stateOf(s({ phase: "working" }), undefined, { status: { kind: "retry", attempt: 0, max: 0, at: 0, message: "getaddrinfo EAI_AGAIN", unreachable: since }, turn: since - 5_000, outage: { since, message: "getaddrinfo EAI_AGAIN" } });
  expect(st).toEqual({ watch: "wait", agents: 0, why: "unreachable", text: "The provider cannot be reached", since });
  expect(stateLabel(st)).toBe("Waiting");
  expect(stateWords(st).phrase).toBe("Waiting for the provider");
  expect(whyText(st)).toBe(`The provider cannot be reached since ${hhmm(since)}; trying again`);
  expect(whyText(st)).toBe("The provider cannot be reached since 16:56; trying again");
  expect(stateLine(st, since + 240_000)).toBe("waiting: The provider cannot be reached since 16:56; trying again, for 4m");
  // An approval that waits still leads: the owner is asked first.
  expect(stateOf(s({ phase: "working" }), undefined, { outage: { since }, approvals: 1 }).watch).toBe("need");
  // The provider answers and the request is on its way before the status changes: working, never "retry 0 of 0".
  expect(stateOf(s({ phase: "working" }), undefined, { status: { kind: "retry", attempt: 0, max: 0, at: 0, message: "x", unreachable: since }, turn: since })).toMatchObject({ watch: "work", why: "model", text: "Calling the model" });
  // An agent is its session: it waits, it has not failed.
  expect(agentState({ status: "running" }, st).watch).toBe("wait");
});

test("a parent whose agents all wait for the provider says so once, for all of them", () => {
  const pending = Array.from({ length: 12 }, (_, i) => ({ kind: "unreachable", agent: `Worker ${i + 1}`, since: since + i }));
  // Its own turn ended: nothing of its own runs.
  const st = stateOf(s(), undefined, { agents: 12, parked: 12, pending });
  expect(st).toEqual({ watch: "wait", agents: 12, parked: 12, why: "unreachable", text: "12 agents wait: the provider cannot be reached", since });
  expect(whyText(st)).toBe("12 agents wait: the provider cannot be reached since 16:56");
  expect(stateOf(s(), undefined, { agents: 1, parked: 1, pending: [pending[0]!] }).text).toBe("1 agent waits: the provider cannot be reached");
  // Its turn only waits for those agents (a blocking call): the same.
  expect(stateOf(s({ phase: "working" }), undefined, { agents: 12, parked: 12, pending, outage: { since, agents: 12 } })).toMatchObject({ watch: "wait", why: "unreachable", text: "12 agents wait: the provider cannot be reached" });
  // One of them works: the parent works, and the head counts the ones that do.
  const mixed = stateOf(s(), undefined, { agents: 12, parked: 11, pending: pending.slice(1) });
  expect(mixed.watch).toBe("work");
  expect(stateLabel(mixed)).toBe("Working · 1 of 12 agents");
  // One waits for the provider and another on a timer it set: what is due first leads, as before.
  expect(stateOf(s(), undefined, { agents: 2, parked: 2, pending: [pending[0]!, { kind: "timer", agent: "Scout", until: since + 60_000 }] })).toMatchObject({ watch: "wait", why: "agent" });
});
