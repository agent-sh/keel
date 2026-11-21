import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
// session, picks the model
// and mode, prompts, answers the gate's approval as a permission request, sees
// the tool call and the reply stream, and the same session is in the
// workbench. Loading it replays the history; cancel ends a turn as cancelled.
test("acp", async ({ page, baseURL }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const ed = new Editor(baseURL!);
  const init = await ed.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, elicitation: { form: {} } }, clientInfo: { name: "e2e", version: "1" } });
  expect(init.protocolVersion).toBe(1);
  expect(init.agentCapabilities.loadSession).toBe(true);
  expect(init.agentCapabilities.sessionCapabilities).toMatchObject({ resume: {}, close: {} });

  const s = await ed.call("session/new", { cwd: ws, mcpServers: [] });
  const id = s.sessionId as string;
  expect(s.configOptions.find((o: any) => o.id === "model").options.some((g: any) => g.options.some((m: any) => m.value === HAIKU))).toBe(true);
  await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: HAIKU });
  await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
  // The daemon's MCP prompts are the editor's slash commands (none on a scratch daemon is fine; the update comes).
  await expect.poll(() => ed.kinds(id)).toContain("available_commands_update");

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
  // The context and cost as the turn left them, before its answer.
  const usage = ed.updates.filter((u) => u.sessionId === id && u.update.sessionUpdate === "usage_update").at(-1)?.update;
  expect(usage.size).toBeGreaterThan(100_000);
  expect(usage.used).toBeGreaterThan(0);
  expect(usage.cost.currency).toBe("USD");

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
  // Resume opens it again without a replay; close lets go of it.
  const replayed = ed2.updates.length;
  await ed2.call("session/resume", { sessionId: id, cwd: ws, mcpServers: [] });
  expect(ed2.updates.slice(replayed).filter((u) => u.update.sessionUpdate === "user_message_chunk")).toHaveLength(0);
  expect(await ed2.call("session/close", { sessionId: id })).toEqual({});
  ed2.close();

  // A question card is the editor's elicitation form; its answer reaches the card.
  ed.onRequest = (m) => (m.method === "elicitation/create" ? (asked.push(m), { action: "accept", content: { [Object.keys(m.params.requestedSchema.properties)[0]!]: "Blue" } }) : { outcome: { outcome: "selected", optionId: "once" } });
  const q = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "Use the AskUserQuestion tool once to ask me to pick a color, with exactly the options Red and Blue. Then reply with only the color I picked." }] });
  expect(q.stopReason).toBe("end_turn");
  const form = asked.find((m) => m.method === "elicitation/create");
  expect(form.params.mode).toBe("form");
  expect(JSON.stringify(form.params.requestedSchema)).toContain("Blue");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/blue/i, { timeout: 30_000 });

  // Cancel: the turn ends as cancelled.
  await ed.call("session/set_mode", { sessionId: id, modeId: "full-auto" });
  const before = ed.updates.length;
  const turn = ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "Run exactly this Bash command: sleep 30. Then reply: slept." }] });
  await expect.poll(() => ed.updates.slice(before).some((u) => u.update.sessionUpdate === "tool_call"), { timeout: 60_000 }).toBe(true);
  ed.notify("session/cancel", { sessionId: id });
  expect((await turn).stopReason).toBe("cancelled");
  ed.close();
});

// Feature: an editor passes its own MCP servers with the session. Keel says
// which transports it takes, starts the server for that session only, the
// model finds and calls its tool through the session's permission mode (the
// editor is asked), the session's MCP list has it and the owner's list and
// other sessions do not, and closing the session lets go of it.
test("acp mcp servers", async ({ request, baseURL }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-mcp-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const echo = join(import.meta.dirname, "fixtures/echo-mcp.ts");
  const ed = new Editor(baseURL!);
  const init = await ed.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  // Streamable HTTP is spoken; the older SSE transport is not, so it is not offered.
  expect(init.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });

  const s = await ed.call("session/new", { cwd: ws, mcpServers: [
    { name: "editor-notes", command: "bun", args: [echo], env: [{ name: "EDITOR_NOTE", value: "1" }] },
    { type: "sse", name: "old-stream", url: "http://127.0.0.1:9/sse", headers: [] },
  ] });
  const id = s.sessionId as string;
  await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: HAIKU });
  await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
  // The one it cannot take is said to the editor, by name; the other connects.
  await expect.poll(() => ed.updates.some((u) => u.sessionId === id && /old-stream/.test(JSON.stringify(u.update)))).toBe(true);
  const list = async (sid: string) => ((await (await request.get(`/api/sessions/${sid}/mcp`)).json()).servers as any[]);
  await expect.poll(async () => (await list(id)).find((x) => x.name === "editor-notes")?.state, { timeout: 30_000 }).toBe("ready");
  expect((await list(id)).find((x) => x.name === "editor-notes")).toMatchObject({ session: id, transport: "stdio", tool_names: ["echo", "add"] });
  // Not the owner's server: their list and their file do not have it.
  const owners = (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  expect(owners.some((x) => /editor-notes/.test(x.name))).toBe(false);

  // Its tool runs in this session, asked about as the mode says.
  const asked: any[] = [];
  ed.onRequest = (m) => (asked.push(m), { outcome: { outcome: "selected", optionId: "once" } });
  const call = `script:calls ${JSON.stringify([{ name: "mcp_call", input: { tool: "editor-notes__echo", arguments: { text: "from the editor" } } }])}`;
  const r = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: call }] });
  expect(r.stopReason).toBe("end_turn");
  expect(asked.map((m) => m.method)).toEqual(["session/request_permission"]);
  const events = async (sid: string) => JSON.stringify((await (await request.get(`/api/sessions/${sid}/events`)).json()).events.filter((e: any) => e.kind === "tool_result"));
  expect(await events(id)).toContain("echo: from the editor");

  // Another session does not have it: the same call finds no such tool there.
  const other = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: ws } })).json()).session.id as string;
  expect((await list(other)).some((x) => x.name === "editor-notes")).toBe(false);
  await request.put(`/api/sessions/${other}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${other}/messages`, { data: { text: call } });
  await expect.poll(async () => await events(other), { timeout: 30_000 }).toContain("No tool named editor-notes__echo");

  // Loading the session again with no servers, or closing it, ends the server.
  await ed.call("session/close", { sessionId: id });
  await expect.poll(async () => (await list(id)).some((x) => x.name === "editor-notes")).toBe(false);
  ed.close();
});

// Feature: Keel drives another ACP agent. Settings lists the agents of the ACP
// registry and the owner's own; one added there answers a new session: its
// thought, plan, calls and reply show as Keel's own, the command it asks to run
// is a gate card the owner answers, the file it writes through Keel is judged
// the same way, its cost reaches the session, it keeps its own history, Stop
// cancels its turn, and a session that talked keeps its agent.
test("acp client", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  await request.delete("/api/acp/agents/standin").catch(() => {});
  await page.goto("/settings/acp-agents");
  await expect(page.getByTestId("acp-registry-count")).toContainText(/\d+ agents/);
  await page.getByTestId("acp-add-id").fill("standin");
  await page.getByTestId("acp-add-command").fill("bun");
  await page.getByTestId("acp-add-args").fill(standin);
  await page.getByTestId("acp-add").click();
  await expect(page.getByTestId("acp-agent-standin")).toBeVisible();
  await shoot(page, "acp-10-agents");
  // The card says how a new session's agent runs (the default sandbox here).
  const { default_sandbox } = await (await request.get("/api/permissions/settings")).json();
  await expect(page.getByTestId("acp-agent-sandbox").first()).toHaveAttribute("data-confined", String(default_sandbox !== "off"));

  await page.getByTestId("acp-agent-standin").getByTestId("acp-agent-start").click();
  await expect(page).toHaveURL(/\/s\//);
  const id = page.url().split("/s/")[1]!.split(/[?#]/)[0]!;
  const s = (await (await request.get(`/api/sessions/${id}`)).json()).session;
  expect(s.model).toBe("acp:standin");
  // The picker has the agent as a model of the ACP agents provider.
  await expect(page.getByText("not in current listing")).toHaveCount(0);
  // The agent's own process runs in the session's sandbox, as Keel's commands do.
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "workspace-write" } });
  const note = join(s.workspace, "acp-note.txt");
  rmSync(note, { force: true });

  await page.getByTestId("composer").fill("hello from the e2e");
  await page.keyboard.press("Enter");
  // The command the agent asks to run is the gate's card (a read-only one would run): the owner allows it.
  const card = page.getByTestId("approval").first();
  await expect(card.getByTestId("approval-summary")).toContainText("mkdir -p build", { timeout: 30_000 });
  await shoot(page, "acp-11-card");
  await card.getByTestId("allow-once").click();
  // Then the file it writes in the folder: a card too (ask mode asks for edits).
  await expect(page.getByTestId("approval").first().getByTestId("approval-summary")).toContainText("acp-note.txt", { timeout: 30_000 });
  await page.getByTestId("approval").first().getByTestId("allow-once").click();
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(note, "utf8")).toBe("hello from the e2e");
  await expect(page.getByTestId("assistant-text").last()).toContainText("The note is written.");
  await expect(page.getByTestId("tool-call").filter({ hasText: "mkdir -p build" })).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("plan").first()).toContainText("Write the note");
  const after = (await (await request.get(`/api/sessions/${id}`)).json()).session;
  expect(after.usage.cost).toBeCloseTo(0.0125, 4);
  expect(after.usage.input).toBe(900);
  await shoot(page, "acp-12-turn");

  // The agent keeps its own history: the next turn sends only the new words.
  await page.getByTestId("composer").fill("again");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-text").last()).toContainText("Before, you said: hello from the e2e", { timeout: 30_000 });

  // What the agent does outside ACP stays in the sandbox: a write outside the folder is refused.
  await expect(page.getByTestId("note").filter({ hasText: "runs in the command sandbox (workspace-write)" })).toHaveCount(1);
  const outside = join(process.env.HOME!, ".cache/keel-work/bun", `acp-escape-${Date.now()}.txt`);
  await page.getByTestId("composer").fill(`escape ${outside}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-text").last()).toContainText("Blocked:", { timeout: 30_000 });
  expect(existsSync(outside)).toBe(false);
  await shoot(page, "acp-13-sandboxed");

  // Stop cancels the agent's turn; the call it left running ends with it.
  await page.getByTestId("composer").fill("wait for me");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-call").filter({ hasText: "sleep 600" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByTestId("tool-call").filter({ hasText: "sleep 600" })).not.toHaveAttribute("data-state", "running");

  // A session that talked keeps its agent: moving it to a model is refused.
  const moved = await request.patch(`/api/sessions/${id}`, { data: { model: HAIKU } });
  expect(moved.status()).toBe(409);
  expect((await moved.json()).error).toContain("keeps its own history");

  // The folders the agent may write are set on its folderCard: a guess by its name
  // until the owner gives the list, which its next start uses.
  const own = join(process.env.HOME!, ".cache/keel-work/bun", `acp-folder-${Date.now()}`);
  for (const f of ["/", "~", "relative/x"]) expect((await request.put("/api/acp/agents/standin/folders", { data: { folders: [f] } })).status()).toBe(400);
  await page.goto("/settings/acp-agents");
  const folderCard = page.locator(".k-setting").filter({ has: page.getByTestId("acp-agent-standin") }).getByTestId("acp-agent-folders");
  await expect(folderCard).toHaveAttribute("data-own", "false");
  await folderCard.getByTestId("acp-folder-add-path").fill(own.replace(process.env.HOME!, "~"));
  await folderCard.getByTestId("acp-folder-add").click();
  await expect(folderCard).toHaveAttribute("data-own", "true");
  await expect(folderCard.getByTestId("acp-agent-folder").filter({ hasText: `acp-folder-` })).toBeVisible();
  await shoot(page, "acp-14-folders");
  await page.getByTestId("acp-agent-standin").getByTestId("acp-agent-start").click();
  await expect(page).toHaveURL(/\/s\//);
  const id2 = page.url().split("/s/")[1]!.split(/[?#]/)[0]!;
  await request.put(`/api/sessions/${id2}/permissions`, { data: { mode: "ask", sandbox: "workspace-write" } });
  await page.getByTestId("composer").fill(`escape ${own}/written.txt`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assistant-text").last()).toContainText("I wrote outside the folder.", { timeout: 30_000 });
  expect(readFileSync(join(own, "written.txt"), "utf8")).toBe("outside");
  // Back to the guess.
  await page.goto("/settings/acp-agents");
  await folderCard.getByTestId("acp-folder-reset").click();
  await expect(folderCard).toHaveAttribute("data-own", "false");
  rmSync(own, { recursive: true, force: true });
  await request.delete("/api/acp/agents/standin");
});
