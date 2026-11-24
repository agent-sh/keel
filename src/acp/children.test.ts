import { expect, test } from "bun:test";
import { messageText, patchChild, readState, turnReason } from "./children.ts";

test("a subagent_update is a patch: a field left out keeps its value, null clears it, a value replaces it", () => {
  const first = patchChild(undefined, { sessionUpdate: "subagent_update", sessionId: "c1", title: "Test investigator", description: "Finds failures.", capabilities: { cancel: {} }, cwd: "/w/one", additionalDirectories: ["/w/a"] });
  expect(first).toEqual({ title: "Test investigator", description: "Finds failures.", cancel: true, cwd: "/w/one", dirs: ["/w/a"] });
  // Only the state: everything else stays.
  const running = patchChild(first, { sessionId: "c1", state: { state: "running" } });
  expect(running).toEqual({ ...first, state: { state: "running" } });
  // A new title replaces the old; null clears the description and the working directory; [] says "no more folders".
  const next = patchChild(running, { sessionId: "c1", title: "Investigator", description: null, cwd: null, additionalDirectories: [] });
  expect(next.title).toBe("Investigator");
  expect("description" in next).toBe(false);
  expect("cwd" in next).toBe(false);
  expect(next.dirs).toEqual([]);
  // The state is replaced whole (the stop reason of an earlier idle goes with it); cleared, it is unconfirmed, not idle.
  expect(patchChild(patchChild(next, { state: { state: "idle", stopReason: "end_turn" } }), { state: { state: "running" } }).state).toEqual({ state: "running" });
  expect("state" in patchChild(running, { state: null })).toBe(false);
});

test("a child permits nothing until its capabilities say cancel, and a new set replaces the old whole", () => {
  expect(patchChild(undefined, { sessionId: "c" }).cancel).toBe(false);
  expect(patchChild(undefined, { capabilities: {} }).cancel).toBe(false);
  expect(patchChild(undefined, { capabilities: { cancel: null } }).cancel).toBe(false);
  const can = patchChild(undefined, { capabilities: { cancel: {} } });
  expect(can.cancel).toBe(true);
  expect(patchChild(can, { title: "later" }).cancel).toBe(true);
  expect(patchChild(can, { capabilities: null }).cancel).toBe(false);
  expect(patchChild(can, { capabilities: {} }).cancel).toBe(false);
});

test("a child's state is read as a row's status: running only when the agent said so, idle by its stop reason", () => {
  // Never given, or unknown: no confirmed work, the row waits and the page says why.
  expect(readState(undefined)).toMatchObject({ status: "waiting", state: "unconfirmed" });
  expect(readState({ state: "unknown" })).toMatchObject({ status: "waiting", state: "unknown" });
  expect(readState({ state: "_vendor" })).toMatchObject({ status: "waiting", state: "_vendor" });
  expect(readState({ state: "running" })).toMatchObject({ status: "running", state: "running" });
  // Blocked on the owner: still its work; the card says what it asks.
  expect(readState({ state: "requires_action" })).toMatchObject({ status: "running", state: "requires_action" });
  expect(readState({ state: "idle" })).toMatchObject({ status: "completed" });
  expect(readState({ state: "idle", stopReason: "end_turn" })).toMatchObject({ status: "completed" });
  expect(readState({ state: "idle", stopReason: "cancelled" })).toMatchObject({ status: "stopped" });
  expect(readState({ state: "idle", stopReason: "error", error: { code: -32000, message: "Authentication required" } })).toMatchObject({ status: "failed", end_reason: "error", failure: "Authentication required" });
  expect(readState({ state: "idle", stopReason: "error" }).failure).toBe("the agent reported an error");
  expect(readState({ state: "idle", stopReason: "max_tokens" })).toMatchObject({ status: "incomplete", end_reason: "max_tokens" });
  expect(readState({ state: "idle", stopReason: "refusal" })).toMatchObject({ status: "incomplete", end_reason: "refusal" });
  expect(readState({ state: "idle", stopReason: "max_turn_requests" })).toMatchObject({ status: "incomplete", end_reason: "max_steps" });
  // How the child's transcript says its work ended.
  expect(turnReason(readState({ state: "idle", stopReason: "cancelled" }))).toBe("interrupted");
  expect(turnReason(readState({ state: "idle", stopReason: "error" }))).toBe("error");
  expect(turnReason(readState({ state: "idle", stopReason: "max_turn_requests" }))).toBe("max_steps");
  expect(turnReason(readState({ state: "idle" }))).toBe("end_turn");
});

test("a session message's text is its text blocks; another kind of block is named", () => {
  expect(messageText([{ type: "text", text: "Find out why." }, { type: "text", text: "Then report." }])).toBe("Find out why.\nThen report.");
  expect(messageText([{ type: "text", text: "See" }, { type: "image", data: "x" }])).toBe("See\n[image]");
  expect(messageText({ type: "text", text: "one" })).toBe("one");
  expect(messageText(undefined)).toBe("");
});
