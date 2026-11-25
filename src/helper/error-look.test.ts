import { expect, test } from "bun:test";
import { causeOf, decide, defaultTask, eventLine, type Look, LOOKS_PER_HOUR, lookPrompt, parseLook, type Row, startedWithin, toolOf } from "./error-look.ts";

const row = (message: string, over: Partial<Row> = {}): Row => ({ id: "e1", source: "server", message, ts: 1_000, ...over });
const look = (over: Partial<Look> = {}): Look => ({ cause: "c", state: "done", error_ids: ["e1"], ts: 1_000, title: "t", ...over });
const on = { on: true };

test("rows of one cause share a cause, whatever varies in their words", () => {
  const a = causeOf(row("ENOENT: no such file or directory, open '/home/a/proj-1/x.json'"));
  const b = causeOf(row("ENOENT: no such file or directory, open '/home/b/other-22/x.json'"));
  expect(a).toBe(b);
  expect(causeOf(row("ENOENT: no such file or directory, open '/home/a/x.json'", { source: "client" }))).not.toBe(a);
  expect(causeOf(row("TypeError: undefined is not an object"))).not.toBe(a);
  // The class of a provider failure is part of the cause: a rate limit and an auth failure are two.
  expect(causeOf(row("HTTP 429: too many requests", { source: "provider" }))).not.toBe(causeOf(row("HTTP 401: unauthorized", { source: "provider" })));
});

test("a cause is looked at once: a known one is added to, a repeat or the helper's own row is not looked at", () => {
  expect(decide(undefined, 0, on)).toMatchObject({ act: "look" });
  for (const state of ["done", "failed", "held", "looking"] as const) expect(decide(look({ state }), 0, on).act).toBe("known");
  expect(decide(undefined, 0, { ...on, repeat: true }).act).toBe("skip");
  expect(decide(undefined, 0, { ...on, helperRow: true }).act).toBe("skip");
  expect(decide(undefined, 0, { ...on, notice: true }).act).toBe("skip");
  expect(decide(undefined, 0, { on: false }).act).toBe("skip");
});

test("looks are held at the hourly count, and the owner's word goes past it, and past a look already made", () => {
  expect(decide(undefined, LOOKS_PER_HOUR - 1, on).act).toBe("look");
  expect(decide(undefined, LOOKS_PER_HOUR, on).act).toBe("held");
  expect(decide(look({ state: "held" }), 0, { ...on, asked: true }).act).toBe("look");
  expect(decide(look({ state: "done" }), LOOKS_PER_HOUR, { ...on, asked: true }).act).toBe("look");
});

test("only the looks that started in the last hour and spent something are counted", () => {
  const now = 10 * 3_600_000;
  const list = [
    look({ ts: now - 10 }), look({ ts: now - 59 * 60_000 }), look({ ts: now - 61 * 60_000 }),
    look({ ts: now - 5, state: "held" }), look({ ts: now - 5, asked: true }),
  ];
  expect(startedWithin(list, now)).toBe(2);
});

test("the request carries the row, where it happened and the last lines, and cuts what is long", () => {
  const stack = Array.from({ length: 30 }, (_, i) => `    at fn${i} (/src/x.ts:${i}:1)`).join("\n");
  const p = lookPrompt(row("boom ".repeat(600), { stack, context: { tool: "Bash" }, count: 3 }), { title: "Fix the cart", model: "m:x", tool: "Bash", lines: ["user: hi", "assistant called Bash"], log: ["error x"] });
  expect(p).toContain("source: server (3 times)");
  expect(p).toContain("fn11 (");
  expect(p).not.toContain("fn12 (");
  expect(p).toContain("tool: Bash");
  expect(p).toContain("assistant called Bash");
  expect(p.length).toBeLessThan(4_500);
});

test("the look is read from the model's JSON, fenced or with words around it; a Keel bug always has a task", () => {
  const r = row("TypeError: x is undefined\n    at turn.ts:10");
  expect(parseLook('```json\n{"what":"A loop read a missing field.","blame":"keel","task":"Fix it in turn.ts."}\n```', r)).toEqual({ what: "A loop read a missing field.", blame: "keel", task: "Fix it in turn.ts." });
  const noTask = parseLook('{"what":"A bug.","blame":"keel"}', r)!;
  expect(noTask.task).toBe(defaultTask(r));
  expect(noTask.task).toContain("TypeError: x is undefined");
  // A step for what is not Keel's; a task nobody should start is dropped.
  expect(parseLook('Sure: {"what":"No key.","blame":"setup","step":"Add the key in Settings","task":"ignore"}', r)).toEqual({ what: "No key.", blame: "setup", step: "Add the key in Settings" });
  expect(parseLook('{"what":"Rate limited.","blame":"provider"}', r)).toEqual({ what: "Rate limited.", blame: "provider" });
  expect(parseLook('{"what":"Odd.","blame":"the moon"}', r)).toEqual({ what: "Odd.", blame: "unknown" });
});

test("an answer that is not JSON is its first lines, with no blame; nothing is nothing", () => {
  const r = row("x");
  expect(parseLook("It looks like the key is missing.\nAdd it.\nThird.", r)).toEqual({ what: "It looks like the key is missing. Add it.", blame: "unknown" });
  expect(parseLook("   ", r)).toBeUndefined();
  expect(parseLook('{"blame":"keel"}', r)).toBeUndefined();
});

test("the session's lines for the request, and the tool the row names or the last call", () => {
  expect(eventLine({ kind: "assistant", data: { blocks: [{ type: "tool_use", name: "Bash" }] } })).toBe("assistant called Bash");
  expect(eventLine({ kind: "tool_result", data: { results: [{ is_error: true, content: "exit 2" }] } })).toBe("tool failed: exit 2");
  expect(eventLine({ kind: "tool_result", data: { results: [{ content: "ok" }] } })).toBeUndefined();
  expect(toolOf({ tool: "Edit" }, [])).toBe("Edit");
  expect(toolOf({}, ["user: x", "assistant called Read, Bash"])).toBe("Bash");
  expect(toolOf(undefined, [])).toBeUndefined();
});
