// A tool's output schema: what the model is given when the structured content
// conforms, and the error it is given when it does not.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./client.ts";
import { McpManager } from "./manager.ts";
import { toOutput } from "./result.ts";
import { schemaCheck, schemaProblems, slowPattern } from "./schema.ts";

const weather = {
  type: "object",
  properties: { temperature: { type: "number" }, conditions: { type: "string", enum: ["sunny", "cloudy"] }, humidity: { type: "integer", minimum: 0, maximum: 100 } },
  required: ["temperature", "conditions"],
  additionalProperties: false,
};
const ctx = { spillDir: mkdtempSync(join(tmpdir(), "keel-mcp-out-")) } as any;

test("the subset of JSON Schema servers use is checked, and what is not checked passes", () => {
  expect(schemaProblems({ temperature: 22.5, conditions: "sunny", humidity: 65 }, weather)).toEqual([]);
  expect(schemaProblems({ temperature: "22", conditions: "rain", humidity: 65.5, wind: 3 }, weather)).toEqual([
    "$.temperature: expected number, got string",
    '$.conditions: "rain" is not one of "sunny", "cloudy"',
    "$.humidity: expected integer, got number",
    '$: "wind" is not a property this schema allows',
  ]);
  expect(schemaProblems({}, weather)).toEqual(['$: "temperature" is required and missing', '$: "conditions" is required and missing']);
  const list = { type: "object", properties: { items: { type: "array", items: { $ref: "#/$defs/item" }, maxItems: 2 } }, $defs: { item: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[a-z]+$" } } } } };
  expect(schemaProblems({ items: [{ id: "ab" }, { id: "A1" }, {}] }, list)).toEqual([
    "$.items: more than 2 items",
    '$.items[1].id: "A1" does not match the pattern ^[a-z]+$',
    '$.items[2]: "id" is required and missing',
  ]);
  expect(schemaProblems(3, { anyOf: [{ type: "string" }, { type: "null" }] })).toEqual(["$: matches none of the 2 schemas it may take (expected string, got number; expected null, got number)"]);
  expect(schemaProblems(null, { type: ["string", "null"] })).toEqual([]);
  // Keywords not checked here (a format, a condition) never make a result wrong.
  expect(schemaProblems({ at: "not a date" }, { properties: { at: { type: "string", format: "date-time" } }, if: { required: ["at"] }, then: { required: ["never"] } })).toEqual([]);
  // A schema that refers to itself ends.
  expect(schemaProblems({ next: { next: {} } }, { $ref: "#" })).toEqual([]);
});

test("conforming structured content reaches the model once, as its JSON", async () => {
  const data = { temperature: 22.5, conditions: "cloudy" };
  const r = { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }, { type: "text" as const, text: "Updated a minute ago." }], structuredContent: data };
  expect(await toOutput(r, ctx, "w__get", weather)).toEqual({ content: `${JSON.stringify(data)}\nUpdated a minute ago.`, is_error: undefined });
  // No schema: the text as the server wrote it, as before.
  expect((await toOutput(r, ctx, "w__get")).content).toBe(`${JSON.stringify(data, null, 2)}\nUpdated a minute ago.`);
});

test("structured content that does not conform, or is missing, is an error naming what is wrong", async () => {
  const bad = await toOutput({ content: [{ type: "text", text: '{"temperature":"hot"}' }], structuredContent: { temperature: "hot" } }, ctx, "w__get", weather);
  expect(bad.is_error).toBe(true);
  expect(bad.content).toBe('w__get returned structured content that does not match its output schema: $: "conditions" is required and missing; $.temperature: expected number, got string.\nWhat it sent:\n{"temperature":"hot"}');
  const none = await toOutput({ content: [{ type: "text", text: "22 degrees" }] }, ctx, "w__get", weather);
  expect(none).toEqual({ content: "w__get declares an output schema, and its result has no structured content.\nWhat it sent:\n22 degrees", is_error: true });
  // A tool's own error result is not held to the schema.
  expect(await toOutput({ content: [{ type: "text", text: "no such city" }], isError: true }, ctx, "w__get", weather)).toEqual({ content: "no such city", is_error: true });
});

test("a call is checked against the output schema its tool was listed with", async () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  (m as any).addEntry("weather", { command: "x" });
  const e = (m as any).entries.get("weather");
  const client = Object.create(McpClient.prototype) as McpClient;
  Object.assign(client, { pending: new Map(), capabilities: { tools: {} }, closed: false });
  (client as any).rpc = async () => ({ content: [{ type: "text", text: '{"temperature":"hot"}' }], structuredContent: { temperature: "hot" } });
  Object.assign(e, { client, state: "ready", tools: [{ name: "get", outputSchema: weather }, { name: "free" }] });
  const call = (tool: string) => m.call("weather", tool, {}, { ...ctx, sessionId: "s1", cwd: "/", signal: new AbortController().signal });
  const out = await call("get");
  expect(out.is_error).toBe(true);
  expect(String(out.content)).toStartWith('weather__get returned structured content that does not match its output schema: $: "conditions" is required and missing; $.temperature: expected number, got string.');
  expect(await call("free")).toEqual({ content: '{"temperature":"hot"}', is_error: undefined });
});

// The check runs on the daemon's loop after a result: every schema ends quickly, whatever it is.
test("a schema that loops, branches without end or holds a slow pattern is checked in bounded time", () => {
  const quick = (f: () => unknown) => { const t = performance.now(); const r = f(); expect(performance.now() - t).toBeLessThan(500); return r; };
  // A reference that loops through anyOf: the same reference for the same value passes.
  expect(quick(() => schemaProblems(1, { $defs: { a: { anyOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/a" }] } }, $ref: "#/$defs/a" }))).toEqual([]);
  // Branches nested 22 deep: past the budget the result is not checked.
  let x: any = { type: "string" };
  for (let i = 0; i < 22; i++) x = { anyOf: [x, x] };
  expect(quick(() => schemaCheck(1, x))).toEqual({ problems: [], checked: false });
  // A pattern that backtracks exponentially is not run; a plain one still is.
  expect(quick(() => schemaProblems("a".repeat(40) + "!", { type: "string", pattern: "^(a+)+$" }))).toEqual([]);
  expect(schemaProblems("ab1", { type: "string", pattern: "^[a-z]+$" })).toHaveLength(1);
  expect(["(a+)+", "(a|aa)*", "(\\w+\\s?){2,}", "(x)\\1"].map(slowPattern)).toEqual([true, true, true, true]);
  expect(["^[a-z]+$", "^(ab)+$", "^\\d{3}-\\d{4}$", "[(+)]+"].map(slowPattern)).toEqual([false, false, false, false]);
});
