import { expect, test } from "bun:test";
import { addedText, Book, foreground, legacyPermission, negotiated, Watch } from "./v2.ts";

test("the version an agent chose: 2 only with sessions, 1 as it falls back, nothing else", () => {
  expect(negotiated({ protocolVersion: 2, capabilities: { session: {} } })).toBe(2);
  expect(negotiated({ protocolVersion: 2, capabilities: {} })).toBeUndefined();
  expect(negotiated({ protocolVersion: 1, agentCapabilities: {} })).toBe(1);
  expect(negotiated(undefined)).toBeUndefined();
});

test("a turn ends at an idle state after work, never at the prompt's answer, and a prompt taken before is not waited for", () => {
  const w = new Watch(false);
  expect(w.state(foreground({ state: "idle" }))).toBe(false);          // a snapshot of a session at rest
  w.answer();
  expect(w.state(foreground({ state: "idle" }))).toBe(false);          // answered, but no stop reason and no work
  expect(w.state(foreground({ state: "running" }))).toBe(false);
  expect(w.state(foreground({ state: "idle", stopReason: "end_turn" }))).toBe(true);
  expect(w.ended).toEqual({ stop: "end_turn" });
  // An idle state before the answer ends work that ran; a repeat does not end it again.
  const early = new Watch(false);
  early.state(foreground({ state: "running" }));
  expect(early.state(foreground({ state: "idle", stopReason: "error", error: { code: -32603, message: "x" } }))).toBe(true);
  expect(early.ended).toEqual({ stop: "error", error: { code: -32603, message: "x" } });
  expect(early.state(foreground({ state: "idle" }))).toBe(false);
  // A prompt sent again that starts nothing is recognized; one that finds work running waits for its end.
  const again = new Watch(true, "idle");
  again.answer();
  expect(again.recognized).toBe(true);
  expect(again.state(foreground({ state: "idle", stopReason: "end_turn" }))).toBe(false);
  const busy = new Watch(true, "running");
  busy.answer();
  expect(busy.recognized).toBe(false);
  expect(busy.state(foreground({ state: "idle", stopReason: "cancelled" }))).toBe(true);
});

test("the background list replaces the one before, null is not a list, and an item is stopped alone only if it offered", () => {
  const b = new Book();
  b.terminal({ terminalId: "t1", command: "npm run dev", capabilities: { cancel: {} }, output: { data: Buffer.from("up\r\n").toString("base64") } });
  b.terminal({ terminalId: "t2", command: "tail -f x" });
  b.call({ toolCallId: "c1", title: "Watch", status: "in_progress", capabilities: { cancel: {} } });
  b.snapshot(foreground({ state: "idle", background: [{ type: "terminal", terminalId: "t1" }, { type: "terminal", terminalId: "t2" }, { type: "tool_call", toolCallId: "c1" }, { type: "future_kind" }] }));
  expect(b.views().map((v) => [v.id, v.can_stop])).toEqual([["terminal:t1", true], ["terminal:t2", false], ["tool_call:c1", true], ["work:3", false]]);
  expect(b.cancel("terminal:t1")).toEqual({ method: "terminal/cancel", params: { terminalId: "t1" } });
  expect(b.cancel("terminal:t2")).toEqual({ refused: "the agent did not offer to stop this terminal" });
  expect(b.cancel("tool_call:c1")).toEqual({ method: "tool_call/cancel", params: { toolCallId: "c1" } });
  expect(b.shown("t1")).toBe("$ npm run dev\nup");
  // The terminal exits: it no longer offers, and the next snapshot drops it.
  b.terminal({ terminalId: "t1", exitStatus: { signal: "SIGTERM" }, capabilities: null });
  expect("refused" in b.cancel("terminal:t1")).toBe(true);
  b.snapshot(foreground({ state: "idle", background: [{ type: "tool_call", toolCallId: "c1" }] }));
  expect(b.views().map((v) => v.id)).toEqual(["tool_call:c1"]);
  expect(b.isBackground("c1")).toBe(true);
  // A state that reports no list says nothing is known: nothing is listed, and nothing is taken as abandoned.
  b.snapshot(foreground({ state: "idle" }));
  expect(b.listed).toBeNull();
  expect(b.views()).toEqual([]);
  expect(b.isBackground("c1")).toBe(false);
});

test("a whole message adds only what its chunks did not, and v2's permission subject becomes the call it is for", () => {
  const seen = new Map<string, string>();
  seen.set("m:a", "Done: ");
  expect(addedText(seen, "m:a", [{ type: "text", text: "Done: yes" }])).toBe("yes");
  expect(addedText(seen, "m:a", [{ type: "text", text: "Done: yes" }])).toBe("");
  expect(addedText(seen, "m:b", [{ type: "text", text: "new" }])).toBe("new");
  expect(legacyPermission({ subject: { type: "tool_call", toolCall: { toolCallId: "c" } }, options: [] }).toolCall).toEqual({ toolCallId: "c" });
  expect(legacyPermission({ subject: { type: "command", command: "ls", cwd: "/w", toolCallId: "c2" } }).toolCall).toMatchObject({ toolCallId: "c2", kind: "execute", rawInput: { command: "ls", cwd: "/w" } });
});
