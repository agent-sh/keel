import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { RESTART_CUT } from "../core/stops.ts";
import { DID_MAX, didLine } from "./report-did.ts";

let n = 0;
const step = (...uses: [string, unknown][]) => ({ kind: "assistant", data: { blocks: [{ type: "text", text: "words-marker" }, ...uses.map(([name, input]) => ({ type: "tool_use", id: `c${++n}`, name, input }))] } }) as unknown as StoredEvent;
const result = (id: string, o: { is_error?: boolean; content?: string } = {}) => ({ kind: "tool_result", data: { results: [{ type: "tool_result", tool_use_id: id, content: o.content ?? "output-marker", is_error: o.is_error }] } }) as unknown as StoredEvent;

test("an agent's report carries what it did: steps, calls, which tools failed and the files it edited", () => {
  n = 0;
  // Three failed builds, then one that passed: its own words were "Done with 4 calls. Last result: recovered".
  const evs = [
    step(["Bash", { command: "make secret-marker" }]), result("c1", { is_error: true, content: "Exit code 2\nerror-marker" }),
    step(["Bash", {}]), result("c2", { is_error: true }),
    step(["Bash", {}]), result("c3", { is_error: true }),
    step(["Bash", {}]), result("c4"),
    step(),
  ];
  expect(didLine(evs)).toBe("(What it did: 5 steps, 4 tool calls, 3 failed (Bash 3).)");
  // Files written with the edit tools of each family; a failed edit changed nothing, and a call a restart cut is not a failure.
  n = 0;
  const edits = [
    step(["Write", { file_path: "/work/repo/src/good-1.txt", content: "body-marker" }], ["Edit", { file_path: "/work/repo/src/a.ts" }]), result("c1"), result("c2"),
    step(["apply_patch", { input: "*** Begin Patch\n*** Update File: lib/b.ts\n@@\n-x\n+y\n*** Add File: lib/c.ts\n+z\n*** End Patch" }]), result("c3"),
    step(["Edit", { file_path: "/work/repo/never.ts" }], ["Read", { file_path: "/nonexistent" }]), result("c4", { is_error: true }), result("c5", { is_error: true }),
    step(["Bash", {}]), result("c6", { is_error: true, content: RESTART_CUT }),
    step(),
  ];
  expect(didLine(edits)).toBe("(What it did: 5 steps, 5 tool calls, 2 failed (Edit, Read); edited 4 files: src/good-1.txt, src/a.ts, lib/b.ts, 1 more.)");
  expect(didLine(edits)).not.toContain("marker");
  // An agent that only answered has nothing to add.
  expect(didLine([step()])).toBe("");
  // Whatever it did, the line stays within its budget.
  n = 0;
  const many = Array.from({ length: 40 }, (_, i) => [step([`tool_with_a_long_name_${i}`, {}]), result(`c${i + 1}`, { is_error: true })]).flat();
  expect(didLine(many).length).toBeLessThanOrEqual(DID_MAX);
});
