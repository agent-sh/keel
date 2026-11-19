import { expect, test } from "bun:test";
import { continuation } from "./responses-ws.ts";

// A request continues the previous response only when nothing but its input
// grew: the previous answer's own items are skipped, the new ones are sent.
test("continuation sends only the new input items", () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] };
  const prev = { rest: JSON.stringify({ model: "m", tools: [] }), input: [user], id: "resp_1" };
  const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
  const out = { type: "function_call_output", call_id: "c1", output: "1" };
  expect(continuation(prev, { model: "m", tools: [], input: [user, call, out] })).toEqual({ id: "resp_1", input: [out] });
  // A changed field, a shorter or rewritten input: sent whole.
  expect(continuation(prev, { model: "m", tools: [], service_tier: "priority", input: [user, call, out] })).toBeNull();
  expect(continuation(prev, { model: "m", tools: [], input: [] })).toBeNull();
  expect(continuation(prev, { model: "m", tools: [], input: [{ ...user, content: [] }, out] })).toBeNull();
  expect(continuation(undefined, { model: "m", input: [user] })).toBeNull();
});
