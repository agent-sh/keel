import { expect, test } from "bun:test";
import { inputLines, parseInput, sameJson } from "./stream.ts";

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

test("an allow says what input it wants run and whether it asked for a standing rule; a deny says neither", () => {
  const answer = (response: unknown) => parseInput(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "r", response } }));
  expect(answer({ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ type: "addRules" }] })).toEqual({ kind: "answer", request_id: "r", allow: true, message: undefined, updated: { command: "ls" }, grants: true });
  expect(answer({ behavior: "allow", updatedPermissions: [] })).toEqual({ kind: "answer", request_id: "r", allow: true, message: undefined });
  expect(answer({ behavior: "deny", updatedInput: { command: "ls" } })).toEqual({ kind: "answer", request_id: "r", allow: false, message: undefined });
  // The same input in another key order is the same input.
  expect([sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }), sameJson({ a: 1 }, { a: 1, b: 2 }), sameJson([1, 2], [2, 1]), sameJson({ a: null }, { a: undefined }), sameJson("x", "x")]).toEqual([true, false, false, false, true]);
});

test("input is read a line at a time: a line over the limit is dropped as it comes and said, and the next one is read", async () => {
  const enc = new TextEncoder();
  async function* src(parts: string[]) { for (const p of parts) yield enc.encode(p); }
  const read = async (parts: string[], max: number) => { const out = []; for await (const l of inputLines(src(parts), max)) out.push(l); return out; };
  // Lines split across chunks, an empty line, a last line with no newline, text of more than one byte a character.
  expect(await read(["one\ntw", "o\n\n", "thr", "ee é\nlast"], 100)).toEqual(["one", "two", "three é", "last"]);
  // Over the limit: its bytes are counted, not kept, and what follows is whole.
  expect(await read(["ok\n", "x".repeat(40), "x".repeat(40), "\nnext\n", "y".repeat(11)], 10)).toEqual(["ok", { over: 80 }, "next", { over: 11 }]);
  expect(await read(["exactly ten\n".slice(0, 10) + "\n"], 10)).toEqual(["exactly te"]);
});
