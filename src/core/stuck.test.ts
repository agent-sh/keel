import { expect, test } from "bun:test";
import { STUCK_AFTER, stuckOf, stuckText } from "./stuck.ts";

test("a step is stuck once it has made no progress past its limit", () => {
  const now = 1_000_000;
  // A silent stream and a model that has not answered count after the model's limit, a tool after its own.
  expect(stuckOf({ watch: "work", agents: 0, why: "stalled", text: "The model is answering, no output", since: now - STUCK_AFTER.model }, now)).toEqual({ what: "stream", text: "The model is answering, no output", since: now - STUCK_AFTER.model });
  expect(stuckOf({ watch: "work", agents: 0, why: "model", text: "Waiting for the model", since: now - STUCK_AFTER.model + 1 }, now)).toBeNull();
  expect(stuckOf({ watch: "work", agents: 0, why: "tool", text: "Running Bash", since: now - STUCK_AFTER.model }, now)).toBeNull();
  expect(stuckOf({ watch: "work", agents: 0, why: "tool", text: "Running Bash", since: now - STUCK_AFTER.tool }, now)?.what).toBe("tool");
  // What waits on the owner, or on a timer, is not stuck; nor is a turn between steps.
  expect(stuckOf({ watch: "need", agents: 0, why: "approval", since: 1 }, now)).toBeNull();
  expect(stuckOf({ watch: "wait", agents: 0, why: "timer", since: 1 }, now)).toBeNull();
  expect(stuckOf({ watch: "work", agents: 0, why: "turn", since: 1 }, now)).toBeNull();
  expect(stuckOf(undefined, now)).toBeNull();
});

test("the answer as text names each item, an agent with its parent", () => {
  expect(stuckText([])).toBe("Nothing is stuck: no turn, tool or agent has gone 2 min for a model, 10 min for a tool without progress.");
  expect(stuckText([
    { what: "tool", text: "Running Bash", since: 0, session_id: "a", title: "Migrate", agent: false, elapsed_ms: 720_000 },
    { what: "stream", text: "The model is answering, no output", since: 0, session_id: "b", title: "Scout", agent: true, parent_id: "a", parent_title: "Audit", elapsed_ms: 150_000 },
  ])).toBe([
    "2 stuck (no progress for 2 min for a model, 10 min for a tool), longest first:",
    "a  Migrate: running Bash, for 12m",
    "b  agent Scout of Audit: the model is answering, no output for 2m",
  ].join("\n"));
});
