import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Editor } from "./acp-editor.ts";
import { ask, HAIKU, openPanel, SCRIPTED, scriptBash, shoot } from "./shots.ts";

// Feature: an editor drives Keel over the Agent Client Protocol. It makes a
// session, picks the model
// and mode, prompts, answers the gate's approval as a permission request, sees
// the tool call and the reply stream, and the same session is in the
// workbench. Loading it replays the history; cancel ends a turn as cancelled.
// The stand-in's words for "ask me to pick a color": its reply ends with the tool's result, which names the answer.
const pickColor = `script:calls ${JSON.stringify([{ name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color do you pick?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] } }])}`;

test("acp", async ({ page, request, baseURL }) => {
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
  const switched = await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: HAIKU });
  // The model's listed levels are a thought_level option; picking one sets the session's effort.
  const levels = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === HAIKU).efforts as string[];
  const level = switched.configOptions.find((o: any) => o.category === "thought_level");
  if (levels.length) {
    expect(level.options.map((o: any) => o.value)).toEqual(["default", ...levels]);
    const picked = await ed.call("session/set_config_option", { sessionId: id, configId: level.id, value: levels[0] });
    expect(picked.configOptions.find((o: any) => o.id === level.id).currentValue).toBe(levels[0]);
    expect((await (await request.get(`/api/sessions/${id}`)).json()).session.settings.effort).toBe(levels[0]);
  } else expect(level).toBeUndefined();
  await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
  // The daemon's MCP prompts are the editor's slash commands (none on a scratch daemon is fine; the update comes).
  await expect.poll(() => ed.kinds(id)).toContain("available_commands_update");

  const asked: any[] = [];
  ed.onRequest = (m) => {
    asked.push(m);
    return { outcome: { outcome: "selected", optionId: "once" } };
  };
  const r = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: ask("Run exactly this Bash command and nothing else: touch acp.txt. Then reply with one word: done.", scriptBash("touch acp.txt")) }] });
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
  // The size is the model's window, as its listing has it.
  const window = (await (await request.get("/api/models")).json()).models.find((m: any) => m.id === HAIKU).context as number;
  expect(window).toBeGreaterThan(10_000);
  expect(usage.size).toBe(window);
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
  const q = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: ask("Use the AskUserQuestion tool once to ask me to pick a color, with exactly the options Red and Blue. Then reply with only the color I picked.", pickColor) }] });
  expect(q.stopReason).toBe("end_turn");
  const form = asked.find((m) => m.method === "elicitation/create");
  expect(form.params.mode).toBe("form");
  expect(JSON.stringify(form.params.requestedSchema)).toContain("Blue");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/blue/i, { timeout: 30_000 });

  // Cancel: the turn ends as cancelled.
  await ed.call("session/set_mode", { sessionId: id, modeId: "full-auto" });
  const before = ed.updates.length;
  const turn = ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: ask("Run exactly this Bash command: sleep 30. Then reply: slept.", scriptBash("sleep 30")) }] });
  await expect.poll(() => ed.updates.slice(before).some((u) => u.update.sessionUpdate === "tool_call"), { timeout: 60_000 }).toBe(true);
  ed.notify("session/cancel", { sessionId: id });
  expect((await turn).stopReason).toBe("cancelled");

  // A request sent again after its stream broke: what the editor shows of the reply is not sent
  // again, and a short line says why it stopped. A reply that says something else comes whole, marked.
  // (The stand-in breaks a stream on demand; a real model cannot be made to.)
  if (SCRIPTED) {
    const said = async (text: string) => {
      const from = ed.updates.length;
      expect((await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] })).stopReason).toBe("end_turn");
      return ed.updates.slice(from).filter((u) => u.sessionId === id && u.update.sessionUpdate === "agent_message_chunk").map((u) => u.update.content.text).join("");
    };
    const line = "\n\n[Keel: the model request failed and is sent again.]\n\n";
    expect(await said("script:drop-same")).toBe(`The same start ${line}and the whole rest.`);
    expect(await said("script:drop")).toBe(`This half reply is dropped with the stream${line}\n\n[Keel: the model request failed and was sent again; the reply it gave is:]\n\nThe whole reply, after the dropped stream.`);
  } else test.info().annotations.push({ type: "skipped: a real model", description: "a stream broken on demand needs the scripted stand-in" });
  ed.close();
});

// Feature: an editor passes its own MCP servers with the session. Keel says
// which transports it takes and starts the server for that session only, with
// the session's permissions and nothing more: its command gets what the
// editor gave as it was given and none of the daemon's own settings, it runs
// inside the session's sandbox when that is on, its tools are asked about as
// the mode says, no other session and no list of the owner's has it, a server
// of the owner's with its name wins the name, and it ends with the session or
// with the editor, however the editor went. The owner sees it: the session's
// panel lists what runs (the command and its arguments, never a value of its
// environment), and its start and end are in the session's activity. One that
// does not connect is said to the editor by name.
test("acp mcp servers", async ({ page, request, baseURL }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-mcp-${Date.now()}`);
  const outside = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-mcp-outside-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const server = join(import.meta.dirname, "fixtures/editor-mcp.ts");
  const ed = new Editor(baseURL!);
  const init = await ed.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  // Streamable HTTP is spoken; the older SSE transport is not, so it is not offered.
  expect(init.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false });

  // What the editor gives names variables of the daemon: none of it is filled in.
  const s = await ed.call("session/new", { cwd: ws, mcpServers: [
    { name: "editor-notes", command: "bun", args: [server, "${HOME}", "${KEEL_DEFAULT_MODEL:-none}"], env: [{ name: "EDITOR_NOTE", value: "1" }, { name: "FROM_DAEMON", value: "${KEEL_DEV_DIR}" }] },
    { type: "sse", name: "old-stream", url: "http://127.0.0.1:9/sse", headers: [] },
    { name: "not-there", command: join(ws, "no-such-server"), args: ["--port", "1"], env: [{ name: "NOT_THERE_TOKEN", value: "value-of-the-token" }] },
  ] });
  const id = s.sessionId as string;
  await ed.call("session/set_config_option", { sessionId: id, configId: "model", value: HAIKU });
  await ed.call("session/set_mode", { sessionId: id, modeId: "ask" });
  // The one it cannot take is said to the editor, by name; the other connects.
  await expect.poll(() => ed.updates.some((u) => u.sessionId === id && /old-stream/.test(JSON.stringify(u.update)))).toBe(true);
  const list = async (sid: string) => ((await (await request.get(`/api/sessions/${sid}/mcp`)).json()).servers as any[]);
  // (The one that never connects is listed with why; the cases below are about the ones that run.)
  const mine = async (sid = id) => (await list(sid)).filter((x) => x.session && x.name !== "not-there");
  await expect.poll(async () => (await mine())[0]?.state, { timeout: 30_000 }).toBe("ready");
  expect((await mine())[0]).toMatchObject({ name: "editor-notes", session: id, transport: "stdio", tool_names: ["echo", "started", "write"] });
  // A command that does not start is said to the editor too, by name and in one line, when it fails.
  await expect.poll(() => ed.updates.some((u) => u.sessionId === id && /could not connect the MCP server not-there/.test(JSON.stringify(u.update)))).toBe(true);
  expect((await list(id)).find((x) => x.name === "not-there")).toMatchObject({ session: id, state: "error", target: `${join(ws, "no-such-server")} --port 1` });

  // The owner sees what the editor made the session run: in its panel, as the
  // command and its arguments, and in its activity when it started. No value
  // of its environment is in either.
  await page.goto(`/s/${id}`);
  await openPanel(page, "session");
  const servers = page.getByTestId("editor-servers");
  await expect(servers).toContainText("editor-notes");
  await expect(servers).toContainText(`bun ${server} \${HOME} \${KEEL_DEFAULT_MODEL:-none}`);
  await expect(servers.getByTestId("editor-server-state")).toHaveText(["Running", "Failed"]);
  await servers.scrollIntoViewIfNeeded();
  await shoot(page, "acp-02-editor-servers");
  const activity = async () => ((await (await request.get(`/api/activity?session_id=${id}`)).json()).items as any[]).map((a) => `${a.sub}: ${a.text}`);
  expect(await activity()).toEqual(expect.arrayContaining([expect.stringContaining(`mcp: MCP server editor-notes, passed by the editor, started: bun ${server}`), expect.stringContaining("mcp-failed: MCP server not-there, passed by the editor, did not connect")]));
  expect(JSON.stringify([await activity(), await list(id), await servers.innerText()])).not.toContain("value-of-the-token");
  // Not the owner's server: their list and their file do not have it.
  const owners = async () => (await (await request.get("/api/mcp/servers")).json()).servers as any[];
  expect((await owners()).some((x) => /editor-notes/.test(x.name))).toBe(false);

  // Its tools run in this session, asked about as the mode says (also one the server calls a read).
  const asked: any[] = [];
  ed.onRequest = (m) => (asked.push(m), { outcome: { outcome: "selected", optionId: "once" } });
  const calls = (...c: { tool: string; arguments?: unknown }[]) => `script:calls ${JSON.stringify(c.map((x) => ({ name: "mcp_call", input: { tool: x.tool, arguments: x.arguments ?? {} } })))}`;
  const results = async (sid: string) => ((await (await request.get(`/api/sessions/${sid}/events`)).json()).events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r) => (typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join("")));
  const r = await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: calls({ tool: "editor-notes__echo", arguments: { text: "from the editor" } }, { tool: "editor-notes__started" }) }] });
  expect(r.stopReason).toBe("end_turn");
  expect(asked.map((m) => m.method)).toEqual(["session/request_permission", "session/request_permission"]);
  const got = await results(id);
  expect(got[0]).toContain("echo: from the editor");
  // What the command was started with: the editor's values as written, and of
  // the daemon's environment only what any program needs to run. No setting
  // of the daemon or of a provider is among them.
  const started = JSON.parse(got[1]!.slice(got[1]!.indexOf("{")));
  expect(started.argv).toEqual(["${HOME}", "${KEEL_DEFAULT_MODEL:-none}"]);
  expect([started.env.EDITOR_NOTE, started.env.FROM_DAEMON]).toEqual(["1", "${KEEL_DEV_DIR}"]);
  expect(Object.keys(started.env).filter((k) => !/^(HOME|LOGNAME|PATH|SHELL|TERM|USER|LANG|LC_[A-Z_]+|TZ|TMPDIR|EDITOR_NOTE|FROM_DAEMON|_|PWD|SHLVL|OLDPWD)$/.test(k))).toEqual([]);

  // Another session does not have it: the same call finds no such tool there.
  const other = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: ws } })).json()).session.id as string;
  expect(await mine(other)).toEqual([]);
  await request.put(`/api/sessions/${other}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${other}/messages`, { data: { text: calls({ tool: "editor-notes__echo", arguments: { text: "x" } }) } });
  await expect.poll(async () => (await results(other)).join(" "), { timeout: 30_000 }).toContain("No tool named editor-notes__echo");

  // The owner adds a server of that name: the name is theirs, here too, and the editor's goes by another.
  const echo = join(import.meta.dirname, "fixtures/echo-mcp.ts");
  expect((await request.post("/api/mcp/servers", { data: { name: "editor-notes", command: "bun", args: [echo] } })).ok()).toBe(true);
  try {
    await expect.poll(async () => (await list(id)).filter((x) => /^editor-notes/.test(x.name)).map((x) => [x.name, !!x.session, x.state]), { timeout: 30_000 }).toEqual([["editor-notes", false, "ready"], ["editor-notes-editor", true, "ready"]]);
    ed.onRequest = () => ({ outcome: { outcome: "selected", optionId: "once" } });
    await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: calls({ tool: "editor-notes__add", arguments: { a: 2, b: 3 } }, { tool: "editor-notes-editor__echo", arguments: { text: "still here" } }) }] });
    expect((await results(id)).slice(-2)).toEqual([expect.stringContaining("5"), expect.stringContaining("echo: still here")]);
  } finally {
    await request.delete("/api/mcp/servers/editor-notes");
  }

  // The session's sandbox is turned on: the command is started again inside
  // it, and cannot write where the session's own commands cannot.
  const { sandbox } = await (await request.get("/api/permissions/settings")).json();
  // The editor's server is a file outside the session's folder: a sandbox shows it once the owner lists its folder for the workspace.
  if (sandbox.available) expect((await request.put("/api/permissions/sandbox", { data: { workspace: { scope: ws, read: [dirname(server)] } } })).ok()).toBe(true);
  const put = await request.put(`/api/sessions/${id}/permissions`, { data: { sandbox: "read-only" } });
  if (sandbox.available) {
    expect(put.ok()).toBe(true);
    await expect.poll(async () => (await mine())[0]?.state, { timeout: 30_000 }).toBe("ready");
    const target = join(outside, "written-by-the-server.txt");
    await ed.call("session/prompt", { sessionId: id, prompt: [{ type: "text", text: calls({ tool: "editor-notes-editor__write", arguments: { path: target } }) }] });
    expect((await results(id)).at(-1)).toContain("not written");
    expect(existsSync(target)).toBe(false);
  } else {
    // No sandbox on this machine: the session cannot be put in one, so the command stays as it was.
    expect(put.status()).toBe(409);
  }

  // Closing the session ends its server, which its activity says and its panel shows.
  await ed.call("session/close", { sessionId: id });
  await expect.poll(async () => (await mine()).length).toBe(0);
  await expect.poll(async () => (await activity()).some((a) => /^mcp: MCP server editor-notes-editor, passed by the editor, ended/.test(a))).toBe(true);
  await expect(page.getByTestId("editor-servers")).toHaveCount(0);

  // An editor that is killed takes its servers with it: no session of its own is left holding a process.
  const marks = [1, 2, 3].map((n) => join(outside, `started-${n}`));
  const ids: string[] = [];
  for (const mark of marks) ids.push((await ed.call("session/new", { cwd: ws, mcpServers: [{ name: "held", command: "bun", args: [server, "--mark", mark], env: [] }] })).sessionId);
  await expect.poll(async () => (await Promise.all(ids.map((x) => mine(x)))).map((l) => l[0]?.state), { timeout: 30_000 }).toEqual(["ready", "ready", "ready"]);
  expect(marks.map((m) => existsSync(m))).toEqual([true, true, true]);
  ed.kill();
  await expect.poll(async () => (await Promise.all(ids.map((x) => mine(x)))).map((l) => l.length), { timeout: 15_000 }).toEqual([0, 0, 0]);

  // And one that leaves in order does too, for every session it opened.
  const ed2 = new Editor(baseURL!);
  await ed2.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const again: string[] = [];
  for (let n = 0; n < 3; n++) again.push((await ed2.call("session/new", { cwd: ws, mcpServers: [{ name: "held", command: "bun", args: [server], env: [] }] })).sessionId);
  await expect.poll(async () => (await Promise.all(again.map((x) => mine(x)))).map((l) => l[0]?.state), { timeout: 30_000 }).toEqual(["ready", "ready", "ready"]);
  ed2.close();
  await expect.poll(async () => (await Promise.all(again.map((x) => mine(x)))).map((l) => l.length), { timeout: 15_000 }).toEqual([0, 0, 0]);
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
  // The plan update is a line of the rail; its list opens on demand.
  await page.locator('[data-testid="tool-call"][data-kind="plan"] > .k-line').first().click();
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
  // A machine that cannot build a sandbox (the daemon says which, and why) has none to stay in:
  // the step is left out there, and the test says so.
  const { sandbox } = await (await request.get("/api/permissions/settings")).json();
  if (sandbox.available) {
    await expect(page.getByTestId("note").filter({ hasText: "runs in the command sandbox (workspace-write)" })).toHaveCount(1);
    const outside = join(process.env.HOME!, ".cache/keel-work/bun", `acp-escape-${Date.now()}.txt`);
    await page.getByTestId("composer").fill(`escape ${outside}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-text").last()).toContainText("Blocked:", { timeout: 30_000 });
    expect(existsSync(outside)).toBe(false);
    await shoot(page, "acp-13-sandboxed");
  } else test.info().annotations.push({ type: "skipped: no sandbox on this machine", description: `the agent's write outside its folder was not tried (${sandbox.reason})` });

  // Stop cancels the agent's turn; the call it left running ends with it.
  await page.getByTestId("composer").fill("wait for me");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tool-call").filter({ hasText: "sleep 600" })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("turn-end")).toHaveCount(sandbox.available ? 4 : 3, { timeout: 30_000 });
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
  // The agent's next start has the folder in its sandbox, and writes there. With no sandbox on
  // the machine no folder is given to anything (the first skip above says so).
  if (sandbox.available) {
    await page.getByTestId("acp-agent-standin").getByTestId("acp-agent-start").click();
    await expect(page).toHaveURL(/\/s\//);
    const id2 = page.url().split("/s/")[1]!.split(/[?#]/)[0]!;
    await request.put(`/api/sessions/${id2}/permissions`, { data: { mode: "ask", sandbox: "workspace-write" } });
    await page.getByTestId("composer").fill(`escape ${own}/written.txt`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-text").last()).toContainText("I wrote outside the folder.", { timeout: 30_000 });
    expect(readFileSync(join(own, "written.txt"), "utf8")).toBe("outside");
  }
  // Back to the guess.
  await page.goto("/settings/acp-agents");
  await folderCard.getByTestId("acp-folder-reset").click();
  await expect(folderCard).toHaveAttribute("data-own", "false");
  rmSync(own, { recursive: true, force: true });
  await request.delete("/api/acp/agents/standin");
});

// Feature: an ACP agent Keel drives gets Keel's tools and terminals. Its
// session/new carries one MCP server of Keel's, which serves the owner's MCP
// servers' tools through a socket the agent's sandbox reaches; each call is
// judged by the gate as the session's own model's would be (one card, not a
// second for the agent's own permission request). Its terminal/create runs
// the command as a command of the session: judged, confined, and its output
// shown in the call that embeds it.
test("acp client tools", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  const echo = join(import.meta.dirname, "fixtures/echo-mcp.ts");
  const server = `acpecho${Date.now().toString(36)}`;
  await request.delete("/api/acp/agents/standin-t").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: server, command: "bun", args: [echo] } })).ok()).toBe(true);
  expect((await request.post("/api/acp/agents", { data: { id: "standin-t", command: "bun", args: [standin] } })).ok()).toBe(true);
  try {
    await expect.poll(async () => ((await (await request.get("/api/mcp/servers")).json()).servers as { name: string; state: string }[]).find((x) => x.name === server)?.state, { timeout: 20_000 }).toBe("ready");
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-tools-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:standin-t" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "workspace-write" } });
    await page.goto(`/s/${session.id}`);

    await page.getByTestId("composer").fill("keel tools");
    await page.keyboard.press("Enter");
    const card = page.getByTestId("approval").first();
    await expect(card.getByTestId("approval-summary")).toContainText("through keel", { timeout: 30_000 });
    await expect(page.getByTestId("approval")).toHaveCount(1);
    await shoot(page, "acp-16-served-card");
    await card.getByTestId("allow-once").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    // (Among the tools of every server the daemon runs.)
    await expect(page.getByTestId("assistant-text").last()).toContainText(`${server}__add, ${server}__echo`);
    await expect(page.getByTestId("assistant-text").last()).toContainText("permission: yes; result: echo: through keel");

    // The agent asks about its command, then runs it in a terminal of Keel's: one card for both.
    await page.getByTestId("composer").fill("terminal");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("approval").first().getByTestId("approval-summary")).toContainText("echo made > term.txt", { timeout: 30_000 });
    await page.getByTestId("approval").first().getByTestId("allow-once").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("exit 0; output: from the terminal");
    expect(readFileSync(join(ws, "term.txt"), "utf8")).toBe("made\n");
    const cards = ((await (await request.get(`/api/sessions/${session.id}/approvals?all=1`)).json()).approvals as { summary: string }[]);
    expect(cards.filter((a) => a.summary.includes("echo made > term.txt"))).toHaveLength(1);
    const call = page.getByTestId("tool-call").filter({ hasText: "echo made > term.txt" }).last();
    await expect(call).toHaveAttribute("data-state", "ok");
    const results = ((await (await request.get(`/api/sessions/${session.id}/events`)).json()).events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
    expect(JSON.stringify(results.at(-1).content)).toContain("from the terminal");
    await call.locator(".k-line").first().click();
    await expect(call).toContainText("from the terminal");
    await shoot(page, "acp-17-terminal");

    // The owner's Stop stops what a terminal of the turn still runs.
    await page.getByTestId("composer").fill("terminal wait");
    await page.keyboard.press("Enter");
    // (A command that only waits asks nothing.)
    const long = async () => ((await (await request.get(`/api/sessions/${session.id}/terminal`)).json()).commands as { command: string; state: string; job_id?: string }[]).filter((j) => j.command === "sleep 600" && j.job_id);
    await expect.poll(async () => (await long()).map((j) => j.state === "running")).toEqual([true]);
    await page.getByTestId("stop").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 });
    await expect.poll(async () => (await long()).map((j) => j.state === "running")).toEqual([false]);
  } finally {
    await request.delete("/api/acp/agents/standin-t");
    await request.delete(`/api/mcp/servers/${server}`);
  }
});

// Feature: an ACP agent's slash commands. What it advertises
// (available_commands_update) is offered in the message box of its sessions,
// with its description and input hint, also before the session's first turn
// (Keel asks each agent once what it offers), and goes to the agent as typed.
test("acp agent commands", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  await request.delete("/api/acp/agents/standin-c").catch(() => {});
  expect((await request.post("/api/acp/agents", { data: { id: "standin-c", command: "bun", args: [standin] } })).ok()).toBe(true);
  try {
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-commands-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:standin-c" } })).json();
    // Asked of the agent when it was added: a session that has not started it has them too.
    await expect.poll(async () => ((await (await request.get(`/api/acp/sessions/${session.id}/commands`)).json()).commands as { name: string }[]).map((c) => c.name), { timeout: 60_000 }).toEqual(["web", "test"]);
    await page.goto(`/s/${session.id}`);
    const box = page.getByTestId("composer");
    await box.fill("/");
    const web = page.getByRole("option").filter({ hasText: "/web" });
    await expect(web).toContainText("Search the web for information");
    await expect(web).toContainText("query to search for");
    await expect(page.getByRole("option").filter({ hasText: "/test" })).toContainText("Run the project's tests");
    await shoot(page, "acp-18-agent-commands");
    await web.click();
    await expect(box).toHaveValue("/web ");
    await box.pressSequentially("agent client protocol");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-text").last()).toContainText("ran /web with: agent client protocol", { timeout: 30_000 });
    // One without an input runs when picked.
    await box.fill("/tes");
    await page.getByRole("option").filter({ hasText: "/test" }).click();
    await expect(page.getByTestId("assistant-text").last()).toContainText("ran /test", { timeout: 30_000 });
    await expect(page.getByTestId("turn-end")).toHaveCount(2);
  } finally {
    await request.delete("/api/acp/agents/standin-c");
  }
});

// Feature: an ACP agent's on and off options (boolean session config
// options). Keel says it shows them, lists them in the session panel (known
// from the agent before its session starts it), and sends the owner's setting
// before the next prompt. One about what the agent may do without asking is
// held, and turned off when the agent has it on: Keel's permission mode and
// sandbox decide that.
test("acp agent options", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  await request.delete("/api/acp/agents/standin-o").catch(() => {});
  expect((await request.post("/api/acp/agents", { data: { id: "standin-o", command: "bun", args: [standin] } })).ok()).toBe(true);
  try {
    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-options-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:standin-o" } })).json();
    const switches = async () => ((await (await request.get(`/api/acp/sessions/${session.id}/switches`)).json()).switches as { id: string; held?: true }[]);
    // (Learned when the agent was asked what it offers.)
    await expect.poll(async () => (await switches()).map((x) => `${x.id}${x.held ? " held" : ""}`), { timeout: 60_000 }).toEqual(["brief", "brave_mode held"]);
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "session");
    const panel = page.getByTestId("agent-switches");
    const brief = panel.getByTestId("agent-switch-brief");
    await expect(brief).toHaveAttribute("aria-checked", "false");
    await expect(panel.getByTestId("agent-switch-held")).toHaveCount(1);
    await expect(panel).toContainText("this session's permission mode and sandbox decide that");
    expect((await request.put(`/api/acp/sessions/${session.id}/switches`, { data: { id: "brave_mode", value: true } })).status()).toBe(409);
    await brief.click();
    await expect(brief).toHaveAttribute("aria-checked", "true");
    await panel.scrollIntoViewIfNeeded();
    await shoot(page, "acp-19-agent-options");
    await page.getByTestId("composer").fill("which model are you on");
    await page.keyboard.press("Enter");
    // (The held one the agent had on is turned off before the prompt.)
    await expect(page.getByTestId("assistant-text").last()).toContainText("brief on, brave off", { timeout: 30_000 });
    // Back to the agent's own: the switch shows what the agent has (on, as it was told).
    await request.put(`/api/acp/sessions/${session.id}/switches`, { data: { id: "brief", value: null } });
    await expect.poll(async () => (await switches()).find((x) => x.id === "brief")).toMatchObject({ current: true });
  } finally {
    await request.delete("/api/acp/agents/standin-o");
  }
});

// Feature: an ACP agent's models. ACP states them only in a session's setup
// (session config options, category model; a reasoning level is category
// thought_level): Keel asks each agent once, lists each model under the
// agent in the picker, with its levels as efforts, and a session moves
// between them in place, the agent keeping its conversation.
test("acp agent models", async ({ page, request }) => {
  const standin = join(import.meta.dirname, "fixtures/acp-agent-standin.ts");
  await request.delete("/api/acp/agents/standin-m").catch(() => {});
  expect((await request.post("/api/acp/agents", { data: { id: "standin-m", command: "bun", args: [standin] } })).ok()).toBe(true);
  try {
    const models = async () => ((await (await request.get("/api/models")).json()).models as any[]).filter((m) => m.provider === "acp" && m.model.split("/")[0] === "standin-m");
    await expect.poll(async () => (await models()).map((m) => m.id).sort(), { timeout: 60_000 }).toEqual(["acp:standin-m", "acp:standin-m/busy", "acp:standin-m/deep", "acp:standin-m/fast"]);
    const deep = (await models()).find((m) => m.id === "acp:standin-m/deep");
    expect(deep).toMatchObject({ name: "standin-m: Deep", efforts: ["low", "high"] });

    const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `acp-models-${Date.now()}`);
    mkdirSync(ws, { recursive: true });
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: "acp:standin-m/deep" } })).json();
    expect((await request.patch(`/api/sessions/${session.id}`, { data: { settings: { effort: "high" } } })).ok()).toBe(true);
    await page.goto(`/s/${session.id}`);
    const which = async (n: number) => {
      await page.getByTestId("composer").fill("which model are you on");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
    };
    await which(1);
    await expect(page.getByTestId("assistant-text").last()).toContainText("model deep, effort high");

    // The picker has the agent's models; the session moves to another in place.
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("standin-m");
    await expect(page.getByTestId("model-option").filter({ hasText: "standin-m: Fast" })).toBeVisible();
    await shoot(page, "acp-15-agent-models");
    await page.getByTestId("model-option").filter({ hasText: "standin-m: Fast" }).click();
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.model).toBe("acp:standin-m/fast");
    await which(2);
    await expect(page.getByTestId("assistant-text").last()).toContainText("model fast, effort high");
    // A switch the agent refuses: the turn goes on with what it had, and the session is told.
    expect((await request.patch(`/api/sessions/${session.id}`, { data: { model: "acp:standin-m/busy" } })).ok()).toBe(true);
    await which(3);
    await expect(page.getByTestId("assistant-text").last()).toContainText("model fast, effort high");
    await expect(page.getByTestId("note").filter({ hasText: "refused to switch to model busy" })).toHaveCount(1);
    // To another agent's model it does not move: that agent would not know what was said.
    expect((await request.patch(`/api/sessions/${session.id}`, { data: { model: HAIKU } })).status()).toBe(409);
  } finally {
    await request.delete("/api/acp/agents/standin-m");
  }
});
