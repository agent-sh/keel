import { expect, test } from "bun:test";
import type { Session } from "./types.ts";
import { askText, liveAgentCounts, stateOf, watchLabel, watchOf, watchWord } from "./watch.ts";

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
