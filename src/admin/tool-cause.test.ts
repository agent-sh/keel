// The cause list: each kind of kept failure line lands in the short list, and a line that says nothing is "other".
import { expect, test } from "bun:test";
import { causeOf, TOOL_CAUSES } from "./tool-cause.ts";

test("a failed call's kept line is one of a short list of causes", () => {
  const cases: [string, string][] = [
    ["File does not exist: /w/a.ts", "missing_file"],
    ["ls: cannot access 'node_modules': No such file or directory (exit code 2)", "missing_file"],
    ["FileNotFoundError: [Errno 2] No such file or directory: 'a.png' (exit code 1)", "missing_file"],
    ["Write did not run, its input is invalid: the required field `content` is missing", "bad_input"],
    ["No tool named bash_placeholder. It does nothing", "bad_input"],
    ["The old_string was not found in the file.", "bad_input"],
    ["TimeoutError: click: Timeout 30000ms exceeded. (exit code 1)", "timeout"],
    ["the command reached its time limit", "timeout"],
    ["TypeError: Unable to connect. Is the computer able to access the url? (exit code 1)", "network"],
    ["HTTP 404", "network"],
    ["no process of this session listens on 47711 yet: start the server", "network"],
    ["/w/src/a.ts exists and was not read in this ses...", "refused"],
    ["AGENT_LIMIT: 16 agent slots of this session are in use", "refused"],
    ["Permission denied", "refused"],
    ["0 (exit code 1)", "nonzero_exit"],
    ["Exit code 1", "nonzero_exit"],
    ["UU src/engine/turn.ts (exit code 1)", "nonzero_exit"],
    ["something unexpected happened", "other"],
    ["", "other"],
  ];
  for (const [line, cause] of cases) expect([line, causeOf(line)]).toEqual([line, cause]);
  expect(causeOf(null)).toBe("other");
  // A more specific cause wins over the exit status that ended the command.
  expect(causeOf("tail: cannot open 'x.log' for reading (exit code 1)")).toBe("missing_file");
  for (const [, cause] of cases) expect(TOOL_CAUSES).toContain(cause as never);
});
