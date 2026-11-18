// Pure logic the e2e cannot see: the wire bytes of a branch, and the tree.
import { expect, test } from "bun:test";
import { leafOf, lineage, versions } from "../core/tree.ts";
import type { StoredEvent } from "../core/types.ts";
import { toMessages } from "./turn.ts";

let seq = 0;
const ev = (id: string, parent: string | null, kind: StoredEvent["kind"], data: any): StoredEvent => ({ id, session_id: "s", seq: ++seq, parent, kind, data, ts: 0 });

const events = [
  ev("u1", null, "user", { text: "first" }),
  ev("a1", "u1", "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop: "tool_use" }),
  ev("r1", "a1", "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }),
  ev("s1", "r1", "user", { text: "steer", origin: "steer" }),
  ev("a2", "s1", "assistant", { blocks: [{ type: "text", text: "no" }], stop: "refusal" }),
  ev("u2", "u1", "user", { text: "first, edited" }), // a sibling version of u1's follow-up branch point
  ev("u1b", null, "user", { text: "first v2" }),
  ev("c1", "s1", "compaction", { mode: "summary", summary: "did ls", owner_messages: ["first", "steer"] }),
  ev("u3", "c1", "user", { text: "next" }),
];

test("toMessages is a pure function of the branch", () => {
  const line = lineage(events, "s1");
  const a = JSON.stringify(toMessages(line));
  const b = JSON.stringify(toMessages(structuredClone(line)));
  expect(a).toBe(b);
  // the steer lands after the tool results in the same user message
  const m = toMessages(line);
  expect(m.at(-1)!.content.map((c: any) => c.type)).toEqual(["tool_result", "text"]);
});

test("a declined reply is not replayed; a summary replaces what came before", () => {
  expect(toMessages(lineage(events, "a2")).at(-1)!.role).toBe("user");
  const after = toMessages(lineage(events, "u3"));
  expect(after.length).toBe(1);
  expect((after[0]!.content[0] as any).text).toContain("did ls");
  expect((after[0]!.content.at(-1) as any).text).toBe("next");
});

test("branches: versions share a parent, leafOf finds the newest end", () => {
  expect(versions(events, events[0]!).map((e) => e.id)).toEqual(["u1", "u1b"]);
  expect(leafOf(events, "u1")).toBe("u3");
  expect(lineage(events, "u1b").map((e) => e.id)).toEqual(["u1b"]);
});
