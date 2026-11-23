import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { unreadRestart } from "./turn.ts";

test("a restart message not read yet is looked for back to the last reply, reading prompts alone", () => {
  let reads = 0;
  const ev = (seq: number, kind: StoredEvent["kind"], data: any): StoredEvent => {
    const e = { id: `e${seq}`, session_id: "s", seq, parent: seq > 1 ? `e${seq - 1}` : null, kind, ts: seq } as StoredEvent;
    Object.defineProperty(e, "data", { enumerable: true, get: () => { reads++; return data; } });
    return e;
  };
  // A long history of prompts and replies, a reply, then a cut turn's prompt and its tool result.
  const old = Array.from({ length: 400 }, (_, i) => ev(i + 1, i % 2 ? "assistant" : "user", i % 2 ? { blocks: [] } : { text: `p${i}` }));
  const tail = [ev(401, "assistant", { blocks: [] }), ev(402, "turn_start", {}), ev(403, "user", { text: "go" }), ev(404, "tool_result", { results: [] })];
  reads = 0;
  expect(unreadRestart([...old, ...tail])).toBe(false);
  expect(reads).toBe(1);
  // A restart message after the last reply is found, and one a reply came after is not.
  const told = ev(405, "user", { origin: "restart", text: "[harness] restarted" });
  expect(unreadRestart([...old, ...tail, told])).toBe(true);
  expect(unreadRestart([...old, ...tail, told, ev(406, "assistant", { blocks: [] })])).toBe(false);
  expect(unreadRestart([])).toBe(false);
});
