import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { Gate, landing } from "./gate.ts";
import { classify, decide, type Mode } from "./policy.ts";

const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);

test("an edit through a link is judged where it lands", () => {
  const ws = mkdtempSync(join(tmpdir(), "keel-ws-"));
  const out = mkdtempSync(join(tmpdir(), "keel-out-"));
  mkdirSync(join(ws, ".git/hooks"), { recursive: true });
  writeFileSync(join(ws, "notes.txt"), "");
  symlinkSync(out, join(ws, "escape"));
  symlinkSync(join(out, "f.txt"), join(ws, "f.txt"));
  symlinkSync(join(ws, ".git/hooks/pre-commit"), join(ws, "hook.sh"));
  symlinkSync(join(ws, "notes.txt"), join(ws, ".envrc"));
  const judge = (path: string, mode: Mode = "auto-edits") =>
    kind(decide(landing(classify({ name: "Write", readOnly: false, kind: "edit" }, { file_path: path }, ws)), { mode, workspace: realOf(ws), sandboxed: false, rules: [], tool: "Write" }));
  expect(judge("src/a.ts")).toBe("allow"); // a new file under a folder that does not exist yet
  expect(judge("notes.txt")).toBe("allow");
  expect(judge("escape/x.txt")).toBe("ask-low"); // a folder link out of the workspace
  expect(judge("f.txt")).toBe("ask-low"); // a file link out of it
  expect(judge("hook.sh")).toBe("ask-high"); // a link into .git/hooks
  expect(judge(".envrc")).toBe("ask-high"); // a file the repository runs, whatever it points at
  expect(judge("escape/x.txt", "full-auto")).toBe("allow");
});

// A gate over a scratch store whose sessions count as sandboxed.
const scratchGate = () => {
  const g = new Gate(new Store(mkdtempSync(join(tmpdir(), "keel-gate-"))), new Bus(), () => true);
  const session = { id: "s1", workspace: mkdtempSync(join(tmpdir(), "keel-ws-")) } as Session;
  const call = (tool: Tool, input: any, signal = new AbortController().signal): ToolCall =>
    ({ id: crypto.randomUUID(), tool, input, ctx: { sessionId: "s1", cwd: session.workspace, signal, spillDir: session.workspace, seen: new Map() } });
  return { g, session, call };
};
const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
const runCode: Tool = { ...bash, name: "run_code", kind: undefined, target: async (input) => ({ name: "run_code", readOnly: false, input, cls: { kind: "shell", command: "bun program.js", escalate: input?.sandbox_permissions === "require_escalated" || undefined } }) };

test("confinement follows the class the gate judged, not an input field", async () => {
  const { g, session, call } = scratchGate();
  g.setPerm("s1", { mode: "full-auto", sandbox: "workspace-write" });
  // A shell tool that offers no escalation runs confined whatever its input says.
  const plain = await g.beforeTool(session, call(bash, { command: "npm test", sandbox_permissions: "require_escalated" }));
  expect(plain && "ctx" in plain && typeof plain.ctx?.wrapSpawn).toBe("function");
  // A program that asks to leave the sandbox gets the escalation card, even in full auto.
  const stop = new AbortController();
  const asked = g.beforeTool(session, call(runCode, { code: "1", sandbox_permissions: "require_escalated" }, stop.signal));
  await Bun.sleep(5);
  expect(g.approvals({ session: "s1", pending: true }).map((a) => a.risk)).toEqual(["high"]);
  stop.abort();
  expect(await asked).toHaveProperty("deny");
});
