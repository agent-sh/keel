import { describe, expect, test } from "bun:test";
import { agyReader, claudeReader, codexReader, READER_V, readerOf, type OutsideHarness } from "./facts.ts";
import { headHash, headLen, HEAD_BYTES, lineEnd, resumeAt, type SavedRead } from "./reads.ts";

const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, s)).toISOString();
const cbase = { cwd: "/w/app", sessionId: "c1", isSidechain: false };
const cuser = (s: number, content: any) => ({ ...cbase, type: "user", timestamp: at(s), message: { role: "user", content } });
const creply = (s: number, id: string, content: any[], usage: any, stop: string | null = null, model = "claude-opus-5-5") =>
  ({ ...cbase, type: "assistant", timestamp: at(s), message: { id, role: "assistant", model, content, usage, stop_reason: stop } });
const claude = [
  cuser(1, "Fix the bug"),
  creply(2, "m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } }], { input_tokens: 10, output_tokens: 5 }),
  creply(2, "m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts" } }], { input_tokens: 10, output_tokens: 9 }),
  cuser(3, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
  creply(4, "m2", [{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: {} }], { input_tokens: 3, output_tokens: 2 }, null, "claude-sonnet-5-5"),
  cuser(5, [{ type: "tool_result", tool_use_id: "t2", content: "Blue" }]),
  creply(6, "m3", [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: "/w/app/b.ts" } }], { input_tokens: 4, output_tokens: 1 }),
];
const ev = (s: number, payload: any) => ({ timestamp: at(s), type: "event_msg", payload });
const item = (s: number, payload: any) => ({ timestamp: at(s), type: "response_item", payload });
const codex = [
  { timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: "/w/svc" } },
  { timestamp: at(1), type: "turn_context", payload: { model: "gpt-6.2", cwd: "/w/svc" } },
  ev(1, { type: "task_started" }),
  item(2, { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: "*** Begin Patch\n*** Add File: new.go\n+x\n*** End Patch" }),
  item(3, { type: "custom_tool_call_output", call_id: "p1", output: "Exit code: 0\nOutput:\nSuccess." }),
  ev(4, { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } }),
  ev(5, { type: "exec_approval_request", call_id: "a1" }),
  item(6, { type: "function_call", name: "exec_command", call_id: "e1", arguments: JSON.stringify({ cmd: ["make"] }) }),
  ev(7, { type: "token_count", info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 80 } } }),
];
const agy = [
  { type: "USER_INPUT", created_at: "2026-11-20 10:00:01" },
  { type: "PLANNER_RESPONSE", created_at: "2026-11-20 10:00:02", model: "gemini-4", input_tokens: 10, output_tokens: 3, tool_calls: [{ name: "write_file", args: { Path: "/w/x.ts" } }, { name: "ask_question", args: {} }] },
  { type: "WRITE_FILE", created_at: "2026-11-20 10:00:03" },
];
const cases: [OutsideHarness, any[]][] = [["claude", claude], ["codex", codex], ["agy", agy]];

describe("a reader read on from a saved state", () => {
  test.each(cases)("%s: every place it can stop at gives the facts of one read from the start", (h, records) => {
    const whole = readerOf(h);
    for (const r of records) whole.push(r);
    for (let cut = 0; cut <= records.length; cut++) {
      const first = readerOf(h);
      for (const r of records.slice(0, cut)) first.push(r);
      // (As the service keeps it: JSON in a row.)
      const next = readerOf(h, JSON.parse(JSON.stringify(first.save())));
      for (const r of records.slice(cut)) next.push(r);
      expect(next.facts()).toEqual(whole.facts());
    }
  });

  test("a state of another harness or another version is not read", () => {
    const c = claudeReader();
    for (const r of claude) c.push(r);
    expect(codexReader(c.save()).facts()).toEqual(codexReader().facts());
    expect(claudeReader({ ...c.save(), v: READER_V + 1 }).facts()).toEqual(claudeReader().facts());
    expect(agyReader(c.save()).facts()).toEqual(agyReader().facts());
  });
});

describe("where a transcript is read from after a restart", () => {
  const reader = { v: READER_V, h: "codex" as const };
  const saved: SavedRead = { harness: "codex", offset: 5000, head_len: HEAD_BYTES, head: "h1", reader };
  test("the saved place, when the file is the one it was saved of", () => {
    expect(resumeAt(saved, { harness: "codex", size: 5000, head: "h1" })).toBe(5000);
    expect(resumeAt(saved, { harness: "codex", size: 90_000, head: "h1" })).toBe(5000);
  });
  test("its start otherwise: none saved, shorter, written again from its start, another harness, another version", () => {
    expect(resumeAt(undefined, { harness: "codex", size: 9000, head: "h1" })).toBe(0);
    expect(resumeAt(saved, { harness: "codex", size: 4999, head: "h1" })).toBe(0);
    expect(resumeAt(saved, { harness: "codex", size: 9000, head: "h2" })).toBe(0);
    expect(resumeAt(saved, { harness: "claude", size: 9000, head: "h1" })).toBe(0);
    expect(resumeAt({ ...saved, reader: { ...reader, v: READER_V + 1 } }, { harness: "codex", size: 9000, head: "h1" })).toBe(0);
    expect(resumeAt({ ...saved, offset: 0 }, { harness: "codex", size: 9000, head: "h1" })).toBe(0);
  });
  test("the place after the last whole line, exact in bytes whatever the text", () => {
    const b = new TextEncoder().encode('{"a":"é"}\n{"b":"日本"}\n{"c":"cut');
    expect(lineEnd(100, b)).toBe(100 + new TextEncoder().encode('{"a":"é"}\n{"b":"日本"}\n').length);
    expect(lineEnd(100, new TextEncoder().encode('{"no":"newline"'))).toBeUndefined();
    expect(headLen(10)).toBe(10);
    expect(headLen(1 << 20)).toBe(HEAD_BYTES);
    expect(headHash(b)).toBe(headHash(b.slice()));
    expect(headHash(b)).not.toBe(headHash(b.subarray(1)));
  });
});
