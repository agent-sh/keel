import { expect, test } from "bun:test";
import type { StoredEvent } from "../../../src/core/types.ts";
import type { Approval } from "../../../src/safety/gate.ts";
import { lineOf, placeOf } from "./reply-calls.ts";

const ev = (seq: number, kind: string, data: any): StoredEvent => ({ id: `e${seq}`, session_id: "s", seq, parent: null, kind: kind as any, data, ts: seq });
const use = (id: string, name: string, input: any) => ({ type: "tool_use", id, name, input });
const card = (call: string, index: number, over: Partial<Approval> = {}): Approval => ({
  id: `a-${call}`, session_id: "s", call_id: call, tool: "Bash", kind: "shell", summary: "", input: {}, risk: "low", suggest: [], state: "pending", created: 1, reply: { seq: 2, index }, ...over,
});
const reply = ev(2, "assistant", { blocks: [{ type: "text", text: "Going." }, use("c1", "Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }), use("c2", "Read", { file_path: "/w/b.ts" }), use("c3", "Bash", { command: "npm test\nnpm run lint" }), use("c4", "Bash", { command: "git push origin main --force" })] });

test("a card says where its call stands in the reply and names the later calls that have not run", () => {
  const open = [card("c1", 0), card("c4", 3, { risk: "high" })];
  const p = placeOf([ev(1, "user", {}), reply], open[0]!, open);
  expect(p).toEqual({
    at: 1, of: 4,
    later: [
      { id: "c2", tool: "Read", line: "Reading /w/b.ts", asks: false, high: false },
      { id: "c3", tool: "Bash", line: "npm test", asks: false, high: false },
      { id: "c4", tool: "Bash", line: "git push origin main --force", asks: true, high: true },
    ],
  });
});

test("a later call that has its result is not waiting, and the earlier ones are not named", () => {
  const open = [card("c3", 2)];
  const events = [reply, ev(3, "tool_result", { results: [{ tool_use_id: "c1" }, { tool_use_id: "c4" }] })];
  expect(placeOf(events, open[0]!, open)).toEqual({ at: 3, of: 4, later: [] });
});

test("no place for a card with none, a reply that is not in the page, or a reply of one call", () => {
  const open = [card("c1", 0)];
  expect(placeOf([reply], { ...open[0]!, reply: undefined }, open)).toBeNull();
  expect(placeOf([ev(9, "assistant", { blocks: [] })], open[0]!, open)).toBeNull();
  expect(placeOf(undefined, open[0]!, open)).toBeNull();
  const one = ev(2, "assistant", { blocks: [use("c1", "Bash", { command: "ls" })] });
  expect(placeOf([one], open[0]!, open)).toBeNull();
  // A last call cut at the output limit never runs: it is not one of the calls.
  const cut = ev(2, "assistant", { stop: "max_tokens", blocks: [use("c1", "Bash", { command: "ls" }), use("c2", "Bash", { command: "ls -" })] });
  expect(placeOf([cut], open[0]!, open)).toBeNull();
});

test("a call's line is its command's first line, or the transcript's words, cut when long", () => {
  expect(lineOf("Bash", { command: "echo a\necho b" })).toBe("echo a");
  expect(lineOf("Write", { file_path: "/w/x.md" }, "/w")).toBe("Writing x.md");
  expect(lineOf("Bash", { command: "x".repeat(200) })).toBe(`${"x".repeat(120)}…`);
});
