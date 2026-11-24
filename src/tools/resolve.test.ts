// A call's name that is another tool's by case or as its job's name in another harness.
import { expect, test } from "bun:test";
import { pauseNote, resolveToolName } from "./resolve.ts";

const tool = (name: string, required: string[] = []) => ({ name, input_schema: { type: "object", required } });
const claude = [tool("Bash", ["command"]), tool("Read", ["file_path"]), tool("Edit", ["file_path", "old_string", "new_string"]), tool("WebFetch", ["url"]), tool("Glob", ["pattern"])];
const gpt = [tool("exec_command", ["cmd"]), tool("write_stdin"), tool("apply_patch")];

test("one case-insensitive match is the tool the call names", () => {
  expect(resolveToolName("bash", claude, { command: "ls" })).toEqual({ as: claude[0]!, how: "case" });
  expect(resolveToolName("webfetch", claude, { url: "https://x" })).toEqual({ as: claude[3]!, how: "case" });
  expect(resolveToolName("EXEC_COMMAND", gpt, { cmd: "ls" })).toEqual({ as: gpt[0]!, how: "case" });
});

test("a name from another family's tool set is the offered tool of the same job", () => {
  expect(resolveToolName("shell", claude, { command: "ls" })).toEqual({ as: claude[0]!, how: "alias" });
  expect(resolveToolName("exec_command", claude, { command: "ls" })).toEqual({ as: claude[0]!, how: "alias" });
  expect(resolveToolName("bash", gpt, { cmd: "ls" })).toEqual({ as: gpt[0]!, how: "alias" });
  expect(resolveToolName("read_file", claude, { file_path: "/a" })).toEqual({ as: claude[1]!, how: "alias" });
});

test("a call whose input is another tool's is not run as it: the error names the nearest offered tools", () => {
  expect(resolveToolName("exec_command", claude, { cmd: "ls" })).toEqual({ near: ["Bash"] });
  expect(resolveToolName("bash", gpt, { command: "ls" })).toEqual({ near: ["exec_command"] });
});

test("two matches, or none, run nothing", () => {
  expect(resolveToolName("bash", [tool("Bash"), tool("BASH")], {})).toEqual({ near: ["Bash", "BASH"] });
  expect(resolveToolName("Reed", claude, {})).toEqual({ near: ["Read"] });
  expect(resolveToolName("frobnicate", claude, {})).toEqual({ near: [] });
});

test("a stand-in name for doing nothing is told the pause tool and the shell tool of its family", () => {
  const withWait = [...claude, tool("WaitFor", ["kind"])];
  expect(pauseNote("bash_placeholder", withWait)).toBe(' bash_placeholder does nothing: to pause, call WaitFor with kind "timer" and seconds; to run a command, call Bash.');
  expect(pauseNote("noop", [...gpt, tool("wait_for", ["kind"])])).toBe(' noop does nothing: to pause, call wait_for with kind "timer" and seconds; to run a command, call exec_command.');
  expect(pauseNote("frobnicate", withWait)).toBe("");
  expect(pauseNote("Read", withWait)).toBe("");
});
