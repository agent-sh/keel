// A placeholder in what a file tool is given reaches the file as the placeholder,
// never as the value, whichever family's tool writes it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks, type ToolCall } from "../engine/hooks.ts";
import { secretRoutes } from "../server/routes/secrets.ts";
import { claudeTools } from "../tools/claude.ts";
import { geminiTools } from "../tools/gemini.ts";
import { gptTools } from "../tools/gpt.ts";
import { vault } from "./secrets.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });
const VALUE = "TEST_TOKEN_abc123XYZ";

// The hooks the daemon runs around a call, in its order, then the tool.
async function call(session: any, tool: any, input: any, cwd: string): Promise<{ text: string; denied?: string }> {
  const ctx: any = { sessionId: session.id, cwd, signal: new AbortController().signal, spillDir: cwd, seen: new Map(), callId: "c1" };
  const c: ToolCall = { id: "c1", tool, input, ctx };
  for (const h of allHooks()) {
    const g: any = await h.beforeTool?.(session, c);
    if (g?.deny) return { text: g.deny, denied: g.deny };
    if (g?.input !== undefined) c.input = g.input;
  }
  let run = c.input;
  for (const h of allHooks()) { const x = h.execInput?.(session, c); if (x !== undefined) run = x; }
  const out = await tool.run(run, ctx);
  return { text: String(typeof out.content === "string" ? out.content : JSON.stringify(out.content)) };
}

test("a file tool never writes a secret's value or a reference to it, whichever family's tool it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-sf-"));
  const store = new Store(join(dir, "state"));
  secretRoutes({ store, bus: new Bus() } as any);
  const session: any = store.createSession({ workspace: dir, model: "m", title: "files" });
  try {
    const ph = vault.placeholder(vault.add(VALUE, "given secret", "card", session.id));
    const by = (tools: any[], n: string) => tools.find((t) => t.name === n)!;
    const bytes = (n: string) => { try { return readFileSync(join(dir, n), "utf8"); } catch { return ""; } };
    const patch = (f: string, text: string) => `*** Begin Patch\n*** Add File: ${f}\n+${text}\n*** End Patch`;
    const exec = by(gptTools, "exec_command");
    const cases: [string, any, any, string][] = [
      ["Write", by(claudeTools, "Write"), { file_path: join(dir, "w.txt"), content: `t=${ph}\n` }, "w.txt"],
      ["write_file", by(geminiTools, "write_file"), { file_path: join(dir, "g.txt"), content: `t=${ph}\n` }, "g.txt"],
      ["replace", by(geminiTools, "replace"), { file_path: join(dir, "r.txt"), instruction: "x", old_string: "", new_string: `t=${ph}\n` }, "r.txt"],
      ["apply_patch", by(gptTools, "apply_patch"), { input: patch("p.txt", `t=${ph}`) }, "p.txt"],
      ["exec_command heredoc", exec, { cmd: `apply_patch <<EOF\n${patch("eh.txt", `t=${ph}`)}\nEOF` }, "eh.txt"],
      ["exec_command quoted heredoc", exec, { cmd: `apply_patch <<'EOF'\n${patch("eq.txt", `t=${ph}`)}\nEOF` }, "eq.txt"],
      ["exec_command single quotes", exec, { cmd: `apply_patch '${patch("es.txt", `t=${ph}`)}'` }, "es.txt"],
      ["exec_command double quotes", exec, { cmd: `apply_patch "${patch("ed.txt", `t=${ph}`)}"` }, "ed.txt"],
    ];
    for (const [name, tool, input, out] of cases) {
      const r = await call(session, tool, input, dir);
      const got = bytes(out);
      expect([name, got.includes(VALUE), got.includes("KEEL_SECRET"), got === ""]).toEqual([name, false, false, true]);
      expect([name, r.denied?.includes(ph)]).toEqual([name, true]);
    }
    // Text that looks like a placeholder but was never issued is only text.
    const w = await call(session, by(claudeTools, "Write"), { file_path: join(dir, "n.txt"), content: "t=[secret:00000000]\n" }, dir);
    expect([w.denied, bytes("n.txt")]).toEqual([undefined, "t=[secret:00000000]\n"]);
    const p = await call(session, exec, { cmd: `apply_patch <<EOF\n${patch("np.txt", "t=[secret:00000000]")}\nEOF` }, dir);
    expect([p.denied, bytes("np.txt")]).toEqual([undefined, "t=[secret:00000000]\n"]);
    // A command a shell runs still gets the value (as a variable on its process).
    const bash: any = { name: "Bash", kind: "shell", readOnly: false, input_schema: { type: "object", properties: { command: {} } } };
    const c: ToolCall = { id: "c2", tool: bash, input: { command: `echo ${ph}` }, ctx: { sessionId: session.id } as any };
    const run = allHooks().map((h) => h.execInput?.(session, c)).find((x) => x !== undefined);
    expect(run.command).toBe('echo "${KEEL_SECRET_' + ph.slice(8, 16) + '}"');
  } finally {
    vault.forgetSession(session.id);
    vault.ledger = null;
    vault.parentOf = () => null;
    store.db.close();
  }
});
