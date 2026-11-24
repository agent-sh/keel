// The schema check of a call's input before the tool runs.
import { expect, test } from "bun:test";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { inputProblem, type Checked } from "./validate.ts";

const tool = (name: string, properties: Record<string, unknown>, required: string[] = [], more: Record<string, unknown> = {}, extra: Partial<Checked> = {}): Checked =>
  ({ name, input_schema: { type: "object", properties, required, ...more }, ...extra });
const find = (list: { name: string }[], name: string) => list.find((t) => t.name === name) as unknown as Checked;

const Write = find(claudeTools, "Write");
const Bash = find(claudeTools, "Bash");
const Read = find(claudeTools, "Read");

test("a call that fits its schema is not answered", () => {
  expect(inputProblem(Bash, { command: "ls", timeout: 5000, run_in_background: false })).toBeUndefined();
  expect(inputProblem(Write, { file_path: "/a", content: "x" })).toBeUndefined();
  expect(inputProblem(Write, { file_path: "/a", content: "" })).toBeUndefined();
});

test("a field the tool reads in another field's place is that field", () => {
  expect(inputProblem(Write, { path: "/a", content: "x" })).toBeUndefined();
  expect(inputProblem(Read, { path: "/a" })).toBeUndefined();
  expect(inputProblem(find(geminiTools, "read_file"), { path: "/a" })).toBeUndefined();
  expect(inputProblem(find(gptTools, "apply_patch"), { patch: "*** Begin Patch" })).toBeUndefined();
  // A bare patch is not an object: the tool reads it as it is.
  expect(inputProblem(find(gptTools, "apply_patch"), "*** Begin Patch\n*** End Patch")).toBeUndefined();
});

test("a missing required field is named, with the fields the tool has", () => {
  const said = inputProblem(Bash, {})!;
  expect(said).toContain("Bash did not run");
  expect(said).toContain("the required field `command` is missing");
  expect(said).toContain("command (required), timeout");
  expect(inputProblem(Write, { file_path: "/a" })).toContain("the required field `content` is missing");
  // A null is a field not given.
  expect(inputProblem(Write, { file_path: "/a", content: null })).toContain("`content` is missing");
  expect(inputProblem(Bash, undefined)).toContain("`command` is missing");
});

test("a field the tool does not have is named with the closest one it has", () => {
  const said = inputProblem(Bash, { cmd: "ls" })!;
  expect(said).toContain("`cmd` is not a field of Bash (did you mean `command`?)");
  expect(said).toContain("the required field `command` is missing");
  expect(inputProblem(Write, { file_path: "/a", content: "x", contents: "y" })).toContain("`contents` is not a field of Write");
  expect(inputProblem(Read, { filePath: "/a" })).toContain("did you mean `file_path`?");
  expect(inputProblem(Read, { file_path: "/a", offsett: 3 })).toContain("did you mean `offset`?");
  // A lone stray field beside a lone missing one is that field under another name.
  expect(inputProblem(Write, { file_path: "/a", body: "x" })).toContain("did you mean `content`?");
  expect(inputProblem(Write, { file_path: "/a", zzz: "x" })).toContain("did you mean `content`?");
});

test("a value of the wrong kind says what it must be", () => {
  expect(inputProblem(Bash, { command: ["ls"] })).toContain("`command` must be a string, not a list");
  expect(inputProblem(Bash, { command: "ls", timeout: "soon" })).toContain("`timeout` must be a number, not a string");
  expect(inputProblem(Bash, { command: "ls", run_in_background: "false" })).toContain("`run_in_background` must be true or false, not a string");
  expect(inputProblem(Read, { file_path: "/a", offset: 1.5 })).toBeUndefined();
});

test("a value the tool reads as it is, is accepted", () => {
  // The tools read these with Number and String.
  expect(inputProblem(Bash, { command: "ls", timeout: "5000" })).toBeUndefined();
  expect(inputProblem(Read, { file_path: "/a", offset: "10", limit: 5 })).toBeUndefined();
  expect(inputProblem(Write, { file_path: "/a", content: 5 })).toBeUndefined();
  // A null for an optional field is not given.
  expect(inputProblem(Bash, { command: "ls", timeout: null, description: null })).toBeUndefined();
});

test("a schema without additionalProperties false allows fields it does not list", () => {
  const open = tool("mcp__s__t", { q: { type: "string" } }, ["q"]);
  expect(inputProblem(open, { q: "x", extra: 1 })).toBeUndefined();
  expect(inputProblem(open, { extra: 1 })).toBe(inputProblem(open, {}));
  expect(inputProblem(open, {})).toContain("the required field `q` is missing");
  expect(inputProblem(open, { q: 1 })).toBeUndefined();
  expect(inputProblem(open, { q: { a: 1 } })).toContain("`q` must be a string, not an object");
  const closed = tool("mcp__s__c", { q: { type: "string" } }, [], { additionalProperties: false });
  expect(inputProblem(closed, { q: "x", extra: 1 })).toContain("`extra` is not a field of mcp__s__c");
  // Another schema for the unknown ones is not the unlisted ones refused.
  expect(inputProblem(tool("m", { q: {} }, [], { additionalProperties: { type: "string" } }), { z: 1 })).toBeUndefined();
});

test("what this does not understand is not checked", () => {
  for (const more of [{ anyOf: [{ required: ["a"] }, { required: ["b"] }] }, { oneOf: [] }, { $ref: "#/x" }, { patternProperties: { "^x": {} } }])
    expect(inputProblem(tool("t", { a: { type: "string" }, b: {} }, ["a"], more), {})).toBeUndefined();
  expect(inputProblem({ name: "t", input_schema: { type: "string" } }, {})).toBeUndefined();
  expect(inputProblem({ name: "t", input_schema: { type: "object" } }, { a: 1 })).toBeUndefined();
  expect(inputProblem({ name: "t" }, {})).toBeUndefined();
  // A property that is a union or a reference is not checked for its kind.
  const t = tool("t", { a: { anyOf: [{ type: "string" }, { type: "number" }] }, b: { $ref: "#/x" }, c: { type: ["string", "null"] }, d: {} });
  expect(inputProblem(t, { a: [1], b: false, c: null, d: [] })).toBeUndefined();
  expect(inputProblem(t, { c: 4 })).toBeUndefined();
  expect(inputProblem(t, { c: [] })).toContain("`c` must be a string or a null, not a list");
});

test("declared extras and optional fields are not refused", () => {
  const t = tool("t", { a: { type: "string" }, b: { type: "string" } }, ["a", "b"], { additionalProperties: false }, { inputAlias: { a: ["alt"] }, inputOptional: ["b"], inputAlso: ["gate"] });
  expect(inputProblem(t, { alt: "x", gate: "y" })).toBeUndefined();
  expect(inputProblem(t, { a: "x", other: 1 })).toContain("`other` is not a field of t");
  expect(inputProblem(find(claudeTools, "NotebookEdit"), { notebook_path: "/n.ipynb", edit_mode: "delete", cell_id: "c" })).toBeUndefined();
});

test("the schema is read once for a tool, and again when the tool's declared names change", () => {
  const t = tool("t", { a: { type: "string" } }, ["a"], { additionalProperties: false });
  expect(inputProblem(t, { b: "x" })).toContain("`b` is not a field");
  expect(inputProblem({ ...t, inputAlias: { a: ["b"] } }, { b: "x" })).toBeUndefined();
  expect(inputProblem(t, { b: "x" })).toContain("`b` is not a field");
});

test("every tool of every family takes the calls its own examples make", () => {
  const calls: [Checked, unknown][] = [
    [find(gptTools, "exec_command"), { cmd: "ls", yield_time_ms: 1000 }],
    [find(gptTools, "view_image"), { path: "/a.png" }],
    [find(geminiTools, "run_shell_command"), { command: "ls", description: "list" }],
    [find(geminiTools, "replace"), { file_path: "/a", old_string: "a", new_string: "b" }],
    [find(geminiTools, "list_directory"), { dir_path: "/a" }],
    [find(claudeTools, "Grep"), { pattern: "x", "-i": true, "-n": true, output_mode: "content" }],
    [find(claudeTools, "TaskStop"), { shell_id: "1" }],
  ];
  for (const [t, input] of calls) expect(inputProblem(t, input)).toBeUndefined();
});
