import { expect, test } from "bun:test";
import { STUCK_AFTER, stuckOf, stuckText } from "./stuck.ts";

test("a step is stuck once it has made no progress past its limit", () => {
  const now = 1_000_000;
  // A silent stream and a model that has not answered count after the model's limit, a command and a long step after the tool's.
  expect(stuckOf({ what: "stream", text: "The model is answering, no output", since: now - STUCK_AFTER.model }, now)?.what).toBe("stream");
  expect(stuckOf({ what: "model", text: "No answer from the model", since: now - STUCK_AFTER.model + 1 }, now)).toBeNull();
  expect(stuckOf({ what: "tool", text: "Running make", since: now - STUCK_AFTER.model }, now)).toBeNull();
  expect(stuckOf({ what: "tool", text: "Running make", since: now - STUCK_AFTER.tool }, now)?.what).toBe("tool");
  expect(stuckOf({ what: "step", text: "Calling search", since: now - STUCK_AFTER.tool }, now)?.what).toBe("step");
  // The owner's limits, or a request's own.
  expect(stuckOf({ what: "tool", text: "Running make", since: now - 6000 }, now, { model: 5000, tool: 5000 })?.what).toBe("tool");
  // A step that waits or a turn between steps has no progress to read.
  expect(stuckOf(null, now)).toBeNull();
});

test("the answer as text names each item, an agent with its parent, and what its time measures", () => {
  expect(stuckText([])).toBe("Nothing is stuck: no turn, tool or agent has gone 2 min for a model, 10 min for a tool without progress.");
  expect(stuckText([
    { what: "tool", text: "Running make", since: 0, session_id: "a", title: "Migrate", agent: false, elapsed_ms: 720_000 },
    { what: "stream", text: "The model is answering, no output", since: 0, session_id: "b", title: "Scout", agent: true, parent_id: "a", parent_title: "Audit", elapsed_ms: 150_000 },
    { what: "step", text: "Calling search", since: 0, session_id: "c", title: "Index", agent: false, elapsed_ms: 660_000 },
    { what: "model", text: "No answer from the model", since: 0, session_id: "d", title: "Draft", agent: false, elapsed_ms: 130_000 },
  ])).toBe([
    "4 stuck (no progress for 2 min for a model, 10 min for a tool), longest first:",
    "a  Migrate: running make, no output for 12m",
    "b  agent Scout of Audit: the model is answering, no output for 3m",
    "c  Index: long step: Calling search, running for 11m",
    "d  Draft: no answer from the model for 2m",
  ].join("\n"));
});
