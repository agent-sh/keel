import { describe, expect, test } from "bun:test";
import { aged, claudeReader, codexReader, exitCodeOf, patchPaths, splitGrown, total, withOwnWord } from "./facts.ts";

const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, s)).toISOString();
const base = { cwd: "/w/app", sessionId: "c1", isSidechain: false, userType: "external", entrypoint: "cli" };
const user = (s: number, content: any, extra: any = {}) => ({ ...base, type: "user", timestamp: at(s), message: { role: "user", content }, ...extra });
const reply = (s: number, id: string, content: any[], usage: any, stop: string | null = null, model = "claude-opus-5-5") =>
  ({ ...base, type: "assistant", timestamp: at(s), message: { id, role: "assistant", model, content, usage, stop_reason: stop } });

describe("Claude Code records", () => {
  test("state: working through a turn, waiting on a question, done at its end", () => {
    const r = claudeReader();
    r.push(user(1, "Fix the bug"));
    expect(r.facts().state).toBe("working");
    r.push(reply(2, "m1", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }], { input_tokens: 10, output_tokens: 5 }));
    expect(r.facts().state).toBe("working");
    r.push(user(3, [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]));
    r.push(reply(4, "m2", [{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [] } }], { input_tokens: 3, output_tokens: 2 }));
    expect(r.facts()).toMatchObject({ state: "waiting", waiting_for: "your answer to a question", since: Date.parse(at(4)) });
    r.push(user(5, [{ type: "tool_result", tool_use_id: "t2", content: "Blue" }]));
    expect(r.facts().state).toBe("working");
    expect(r.facts().waiting_for).toBeUndefined();
    r.push(reply(6, "m3", [{ type: "text", text: "Done." }], { input_tokens: 4, output_tokens: 1 }));
    expect(r.facts().state).toBe("working");
    r.push({ ...base, type: "system", subtype: "turn_duration", timestamp: at(7), durationMs: 6000 });
    expect(r.facts()).toMatchObject({ state: "done", since: Date.parse(at(7)), last_ts: Date.parse(at(7)), files: ["/w/app/src/a.ts"] });
  });

  test("a reply that stopped by itself ends the turn; an interruption does too", () => {
    const r = claudeReader();
    r.push(user(1, "Hi"));
    r.push(reply(2, "m1", [{ type: "text", text: "Hello" }], { input_tokens: 1, output_tokens: 1 }, "end_turn"));
    expect(r.facts().state).toBe("done");
    r.push(user(3, "Run it"));
    r.push(reply(4, "m2", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 100" } }], { input_tokens: 1, output_tokens: 1 }));
    r.push(user(5, [{ type: "text", text: "[Request interrupted by user for tool use]" }]));
    expect(r.facts().state).toBe("done");
  });

  test("usage: the records of one reply count once, at their last usage; each model its own", () => {
    const r = claudeReader();
    r.push(user(1, "Go"));
    r.push(reply(2, "m1", [{ type: "thinking", thinking: "" }], { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 1 }));
    r.push(reply(3, "m1", [{ type: "text", text: "a" }], { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 40 }));
    r.push(reply(4, "m2", [{ type: "text", text: "b" }], { input_tokens: 7, output_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 20 }, cache_creation_input_tokens: 20 }, "end_turn", "claude-sonnet-5-5"));
    expect(r.facts().usage).toEqual({
      "claude-opus-5-5": { input: 100, output: 40, cache_read: 1000, cache_write: 50 },
      "claude-sonnet-5-5": { input: 7, output: 3, cache_read: 0, cache_write: 20, cache_write_1h: 20 },
    });
  });

  test("failures: a failed call and a model error, not a call the owner refused; a failed edit changed no file", () => {
    const r = claudeReader();
    r.push(user(1, "Go"));
    r.push(reply(2, "m1", [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/w/app/x.ts", content: "" } },
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/w/app/y.ts" } },
    ], { input_tokens: 1, output_tokens: 1 }));
    r.push(user(3, [
      { type: "tool_result", tool_use_id: "t1", content: "make: *** No rule to make target", is_error: true },
      { type: "tool_result", tool_use_id: "t2", content: "The user doesn't want to proceed with this tool use.", is_error: true },
      { type: "tool_result", tool_use_id: "t3", content: [{ type: "text", text: "String not found" }], is_error: true },
    ]));
    r.push({ ...reply(4, "m2", [{ type: "text", text: "API Error: 529 overloaded" }], undefined), isApiErrorMessage: true });
    const f = r.takeFailures();
    expect(f.map((x) => [x.tool, x.kind, x.text])).toEqual([
      ["Bash", "tool", "make: *** No rule to make target"],
      ["Edit", "tool", "String not found"],
      ["model", "provider", "API Error: 529 overloaded"],
    ]);
    expect(r.takeFailures()).toEqual([]);
    expect(r.facts().files).toEqual([]);
  });

  test("its own word wins while its process runs: a permission prompt is a wait", () => {
    const r = claudeReader();
    r.push(user(1, "Go"));
    r.push(reply(2, "m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm x" } }], { input_tokens: 1, output_tokens: 1 }));
    const f = withOwnWord(r.facts(), { status: "waiting", waitingFor: "approve Bash" }, 99);
    expect(f).toMatchObject({ state: "waiting", waiting_for: "approve Bash", since: 99 });
    expect(withOwnWord(r.facts(), { status: "busy" }).state).toBe("working");
    expect(withOwnWord(r.facts(), { status: "idle" }, 5).state).toBe("done");
    expect(withOwnWord(r.facts(), undefined)).toEqual(r.facts());
  });
});

describe("Codex records", () => {
  const ev = (s: number, payload: any) => ({ timestamp: at(s), type: "event_msg", payload });
  const item = (s: number, payload: any) => ({ timestamp: at(s), type: "response_item", payload });
  test("state, usage by turn total, files from apply_patch, failures by exit code", () => {
    const r = codexReader();
    r.push({ timestamp: at(0), type: "session_meta", payload: { id: "x1", cwd: "/w/svc" } });
    r.push({ timestamp: at(1), type: "turn_context", payload: { model: "gpt-6.2", cwd: "/w/svc" } });
    r.push(ev(1, { type: "task_started" }));
    expect(r.facts().state).toBe("working");
    r.push(item(2, { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: "*** Begin Patch\n*** Update File: src/main.go\n@@\n-a\n+b\n*** Add File: /w/svc/new.go\n+x\n*** End Patch" }));
    r.push(item(3, { type: "custom_tool_call_output", call_id: "p1", output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess." }));
    r.push(item(4, { type: "function_call", name: "exec_command", call_id: "e1", arguments: JSON.stringify({ cmd: ["go", "test"] }) }));
    r.push(item(5, { type: "function_call_output", call_id: "e1", output: JSON.stringify({ output: "FAIL ./...", metadata: { exit_code: 1 } }) }));
    r.push(item(5, { type: "function_call", name: "exec_command", call_id: "e2", arguments: JSON.stringify({ cmd: ["make"] }) }));
    r.push(item(5, { type: "function_call_output", call_id: "e2", output: "Exit code: 2\nWall time: 0.4 seconds\nOutput:\nmake: *** no target" }));
    r.push(ev(5, { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 } } }));
    r.push(ev(5, { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 } } }));
    r.push(item(6, { type: "function_call", name: "request_user_input", call_id: "q1", arguments: "{}" }));
    expect(r.facts()).toMatchObject({ state: "waiting", waiting_for: "your answer to a question" });
    r.push(item(7, { type: "function_call_output", call_id: "q1", output: "yes" }));
    r.push({ timestamp: at(7), type: "turn_context", payload: { model: "gpt-6.2-mini" } });
    r.push(ev(8, { type: "token_count", info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 80 } } }));
    r.push(ev(9, { type: "task_complete" }));
    const f = r.facts();
    expect(f.state).toBe("done");
    expect(f.model).toBe("gpt-6.2-mini");
    expect(f.files).toEqual(["/w/svc/src/main.go", "/w/svc/new.go"]);
    expect(f.usage).toEqual({ "gpt-6.2": { input: 200, output: 50, cache_read: 800, cache_write: 0 }, "gpt-6.2-mini": { input: 300, output: 30, cache_read: 200, cache_write: 0 } });
    expect(r.takeFailures().map((x) => [x.tool, x.text])).toEqual([["exec_command", "FAIL ./..."], ["exec_command", "make: *** no target"]]);
  });

  test("an aborted turn is done; a model error is a failure", () => {
    const r = codexReader();
    r.push(ev(1, { type: "task_started" }));
    r.push(ev(2, { type: "error", message: "stream disconnected before completion" }));
    r.push(ev(3, { type: "turn_aborted", reason: "interrupted" }));
    expect(r.facts().state).toBe("done");
    expect(r.takeFailures()).toEqual([{ tool: "model", kind: "provider", text: "stream disconnected before completion", ts: Date.parse(at(2)) }]);
  });
});

describe("reading what a file gained", () => {
  test("a line the writer has not finished waits for the next read", () => {
    const a = splitGrown("", '{"a":1}\n{"b":');
    expect(a).toEqual({ records: [{ a: 1 }], rest: '{"b":', bad: 0 });
    const b = splitGrown(a.rest, '2}\nnot json\n');
    expect(b).toEqual({ records: [{ b: 2 }], rest: "", bad: 1 });
  });
  test("an exit code from either shape Codex writes; patch paths", () => {
    expect(exitCodeOf("Exit code: 2\nWall time: 1s")).toBe(2);
    expect(exitCodeOf('{"output":"x","metadata":{"exit_code":0}}')).toBe(0);
    expect(exitCodeOf("plain")).toBeUndefined();
    expect(patchPaths("*** Delete File: a\n*** Update File: b\n*** Move to: c\n")).toEqual(["a", "b", "c"]);
  });
  test("the total: cost where each model has a price, else counted unpriced", () => {
    const t = total({ a: { input: 1e6, output: 0, cache_read: 0, cache_write: 0 }, b: { input: 1, output: 1, cache_read: 0, cache_write: 0 } }, (m) => (u) => (m === "a" ? u.input * 2 / 1e6 : undefined));
    expect(t).toMatchObject({ input: 1e6 + 1, output: 1, cost: 2, unpriced: 1 });
    // With no price known, no cost: never a zero that is not one.
    expect(total({ b: { input: 1, output: 1, cache_read: 0, cache_write: 0 } }, () => () => undefined)).toEqual({ input: 1, output: 1, cache_read: 0, cache_write: 0, unpriced: 1 });
  });
});

describe("aging", () => {
  test("working or waiting with no record for the stale time is stale, unless a running process vouches for it", () => {
    const f = { state: "waiting" as const, waiting_for: "your answer", since: 1000, last_ts: 1000, usage: {}, files: [] };
    expect(aged(f, 1000, 600_000, false, 1000 + 599_999)).toBe(f);
    expect(aged(f, 1000, 600_000, false, 1000 + 600_000)).toEqual({ state: "stale", since: 1000, last_ts: 1000, usage: {}, files: [] });
    expect(aged(f, 1000, 600_000, true, 1000 + 9e9)).toBe(f);
    const done = { ...f, state: "done" as const };
    expect(aged(done, 1000, 600_000, false, 9e9)).toBe(done);
  });
});
