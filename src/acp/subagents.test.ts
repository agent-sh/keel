import { expect, test } from "bun:test";
import { agentState, childInput, subagentUpdate, taskLine } from "./subagents.ts";

const agent = { id: "a1", parent_id: "p", session_id: "c1", title: "Test runner", status: "running" };

test("an agent's record is its child session's label, state and cancel", () => {
  expect(subagentUpdate(agent, { description: "Run the tests" })).toEqual({
    sessionUpdate: "subagent_update", sessionId: "c1", title: "Test runner", description: "Run the tests", capabilities: { cancel: {} }, state: { state: "running" },
  });
  // A card of its own waits on the owner.
  expect(subagentUpdate(agent, { asking: true }).state).toEqual({ state: "requires_action" });
  // Its own worktree is its folder; one on another machine says none.
  expect(subagentUpdate({ ...agent, worktree: "/w/.wt/a1" }).cwd).toBe("/w/.wt/a1");
  expect(subagentUpdate({ ...agent, worktree: "/far/a1", machine: "m" }).cwd).toBeUndefined();
  // Ended: nothing to cancel, and how it ended.
  const ended = (status: string, end_reason?: string) => subagentUpdate({ ...agent, status, end_reason });
  expect(ended("completed")).toMatchObject({ capabilities: {}, state: { state: "idle", stopReason: "end_turn" } });
  expect(ended("stopped").state).toEqual({ state: "idle", stopReason: "cancelled" });
  expect(ended("incomplete", "max_steps").state).toEqual({ state: "idle", stopReason: "max_turn_requests" });
  expect(ended("incomplete", "refusal").state).toEqual({ state: "idle", stopReason: "refusal" });
  expect(ended("failed").state).toMatchObject({ state: "idle", stopReason: "error", error: { code: -32603 } });
  // Waiting on a wait of its own: no foreground work, still stoppable.
  expect(ended("waiting")).toMatchObject({ capabilities: { cancel: {} }, state: { state: "idle" } });
  expect(agentState({ status: "waiting" }, true)).toEqual({ state: "requires_action" });
});

test("a child's inputs: its parent's task and messages are from the parent, a peer's from its session, the owner's are the user's", () => {
  const task = childInput({ id: "e1", data: { kind: "task", agent_id: "a1", text: "Run the tests" } }, "c1", "p");
  expect(task).toEqual([{ sessionUpdate: "session_message", messageId: "e1", recipientSessionId: "c1", senderSessionId: "p", content: [{ type: "text", text: "Run the tests" }] }]);
  const peers = (id: string) => (id === "a2" ? "c2" : undefined);
  expect(childInput({ id: "e2", data: { kind: "steer", agent_id: "a1", from_agent: "a2", text: "hi" } }, "c1", "p", peers)[0].senderSessionId).toBe("c2");
  // A sender it cannot name is left out, never guessed.
  expect(childInput({ id: "e3", data: { kind: "steer", agent_id: "a1", from_agent: "a9", text: "hi" } }, "c1", "p", peers)[0]).not.toHaveProperty("senderSessionId");
  expect(childInput({ id: "e4", data: { kind: "subagent", text: "report" } }, "c1", "p")[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", _meta: { keel: { input: "subagent" } } });
  expect(childInput({ id: "e5", data: { text: "from the owner" } }, "c1", "p")).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "from the owner" } }]);
  expect(taskLine("\n  Fix the build\nthen more")).toBe("Fix the build");
  expect(taskLine("x".repeat(300))!.length).toBe(200);
});
