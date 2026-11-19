import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// An editor's end of ACP: `keel acp` on stdio, JSON-RPC one message a line.
class Editor {
  private proc: ChildProcess;
  private buf = "";
  private id = 100;
  private waiting = new Map<number, (m: any) => void>();
  updates: any[] = [];
  onRequest: (m: any) => any = () => ({});
  constructor(url: string) {
    this.proc = spawn("bun", [join(import.meta.dirname, "../../src/main.ts"), "acp", "--url", url], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (m.method === "session/update") this.updates.push(m.params);
        else if (m.method && m.id !== undefined) this.write({ jsonrpc: "2.0", id: m.id, result: this.onRequest(m) });
        else if (m.id !== undefined) this.waiting.get(m.id)?.(m);
      }
    });
  }
  private write(m: unknown) { this.proc.stdin!.write(JSON.stringify(m) + "\n"); }
  call(method: string, params: unknown): Promise<any> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
  kinds(sessionId: string) { return this.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate); }
  close() { this.proc.stdin!.end(); }
}

// Feature: an editor drives Keel over the Agent Client Protocol. It makes a
// session (told that its own MCP servers are not connected), picks the model
// and mode, prompts, answers the gate's approval as a permission request, sees
// the tool call and the reply stream, and the same session is in the
// workbench. Loading it replays the history; cancel ends a turn as cancelled.
test("acp", async ({ page, baseURL }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const ed = new Editor(baseURL!);
  const init = await ed.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } }, clientInfo: { name: "e2e", version: "1" } });
  expect(init.protocolVersion).toBe(1);
  expect(init.agentCapabilities.loadSession).toBe(true);

  const s = await ed.call("session/new", { cwd: ws, mcpServers: [{ name: "editor-fs", command: "true", args: [], env: [] }] });
  const id = s.sessionId as string;
  expect(s.configOptions.find((o: any) => o.id === "model").options.some((g: any) => g.options.some((m: any) => m.value === HAIKU))).toBe(true);
  await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: HAIKU });
  await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
  await expect.poll(() => ed.updates.some((u) => u.sessionId === id && JSON.stringify(u.update).includes("did not connect the editor's MCP servers"))).toBe(true);

  const asked: any[] = [];
  ed.onRequest = (m) => {
    asked.push(m);
    return { outcome: { outcome: "selected", optionId: "once" } };
  };
  const r = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "Run exactly this Bash command and nothing else: touch acp.txt. Then reply with one word: done." }] });
  expect(r.stopReason).toBe("end_turn");
  expect(asked.map((m) => m.method)).toEqual(["session/request_permission"]);
  expect(asked[0].params.toolCall.kind).toBe("execute");
  expect(asked[0].params.options.map((o: any) => o.kind)).toContain("allow_once");
  expect(existsSync(join(ws, "acp.txt"))).toBe(true);
  const kinds = ed.kinds(id);
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("tool_call_update");
  expect(kinds).toContain("agent_message_chunk");
  expect(ed.updates.filter((u) => u.update.sessionUpdate === "tool_call_update" && u.sessionId === id).map((u) => u.update.status)).toEqual(["in_progress", "completed"]);

  // The workbench has the same session.
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("tool-call").first()).toHaveAttribute("data-tool", "Bash");
  await expect(page.getByTestId("tool-call").first()).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/done/i);
  await shoot(page, "acp-01-workbench");

  // Another editor loads it: the history comes back as updates.
  const ed2 = new Editor(baseURL!);
  await ed2.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await ed2.call("session/load", { sessionId: id, cwd: ws, mcpServers: [] });
  expect(ed2.kinds(id)).toContain("user_message_chunk");
  expect(JSON.stringify(ed2.updates)).toContain("touch acp.txt");
  const listed = await ed2.call("session/list", { cwd: ws });
  expect(listed.sessions.map((x: any) => x.sessionId)).toContain(id);
  ed2.close();

  // Cancel: the turn ends as cancelled.
  await ed.call("session/set_mode", { sessionId: id, modeId: "full-auto" });
  const before = ed.updates.length;
  const turn = ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "Run exactly this Bash command: sleep 30. Then reply: slept." }] });
  await expect.poll(() => ed.updates.slice(before).some((u) => u.update.sessionUpdate === "tool_call"), { timeout: 60_000 }).toBe(true);
  ed.notify("session/cancel", { sessionId: id });
  expect((await turn).stopReason).toBe("cancelled");
  ed.close();
});
