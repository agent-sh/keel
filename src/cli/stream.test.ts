import { expect, test } from "bun:test";
import { parseInput } from "./stream.ts";

test("an input line is a prompt, an interrupt or an answer; anything else is said back, never thrown", () => {
  const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  expect(parseInput(JSON.stringify({ type: "user", uuid: "u", message: { role: "user", content: [{ type: "text", text: "look" }, png, { type: "text", text: "here" }] } })))
    .toEqual({ kind: "user", text: "look\nhere", images: [{ type: "image", media_type: "image/png", data: "AAAA" }], uuid: "u" });
  expect(parseInput('{"type":"user","message":{"content":"  "}}').kind).toBe("bad");
  expect(parseInput('{"type":"user","message":{"content":[{"type":"tool_result"}]}}').kind).toBe("bad");
  expect(parseInput('{"type":"control_request","request_id":"a","request":{"subtype":"interrupt"}}')).toEqual({ kind: "interrupt", request_id: "a" });
  // What the session may do without asking is not changed from inside the stream.
  for (const sub of ["set_permission_mode", "set_model", "initialize"]) expect(parseInput(JSON.stringify({ type: "control_request", request_id: "a", request: { subtype: sub, mode: "full-auto" } })).kind).toBe("refused");
  const answer = (response: unknown, subtype = "success") => parseInput(JSON.stringify({ type: "control_response", response: { subtype, request_id: "r", response } }));
  expect(answer({ behavior: "allow" })).toEqual({ kind: "answer", request_id: "r", allow: true, message: undefined });
  expect(answer({ behavior: "deny", message: "no" })).toMatchObject({ allow: false, message: "no" });
  // An answer that says neither is not an allow.
  expect([answer({}).kind, answer({ behavior: "always" }).kind, answer({ behavior: "allow" }, "error")]).toEqual(["bad", "bad", expect.objectContaining({ allow: false })]);
  expect(answer({ answers: { 0: { picked: ["Teal"] } } })).toMatchObject({ allow: true, answers: { 0: { picked: ["Teal"] } } });
  for (const l of ["", "nope", "[1]", "null", '"text"', '{"type":"assistant"}', '{"type":"control_request"}']) expect(parseInput(l).kind).toBe("bad");
});
