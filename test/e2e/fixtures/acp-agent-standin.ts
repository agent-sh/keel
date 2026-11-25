// A stand-in ACP agent for the e2e of keel-bun as an ACP client (bun
// acp-agent-standin.ts). Over stdio it answers initialize and session/new,
// and a prompt with: a thought, a plan, a command it asks permission for, a
// file it writes through the client, a usage update and a reply. A prompt
// with "wait" hangs until session/cancel; "again" answers with what it was
// told before, so a test sees the agent keep its own history. Its models and
// reasoning levels are config options; "which model" names the current ones.
// "keel tools" starts the MCP server the client passed in session/new, lists
// its tools and calls one; "terminal" runs a command in a client terminal.
//
// With the argument `v2` it is also an ACP v2 (Preview) agent: asked for protocol 2 it speaks it, asked for 1 it
// is the agent above. In v2 a prompt is answered with the id of the message it inserted, and the work ends with an
// idle state_update. `session/prompt` honours its idempotencyKey (the keys and the work done are kept in files of
// the session's folder, so they outlive the process): a key it knows is answered with the message it already
// inserted, and nothing runs again. Prompts: "slow" works until session/cancel; "background" ends its turn leaving
// a terminal (that can be cancelled), a tool call (that can be cancelled) and a terminal that cannot be cancelled
// in the background list; "boom" ends in an error; anything else is a thought, a tool call and a reply.
const V2 = process.argv.includes("v2");
let v2Mode = false;
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let next = 1;
const waiting = new Map<number, (m: any) => void>();
const ask = (method: string, params: unknown) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); out({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId: string, u: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const said: string[] = [];
let cwd = "";
let cancel: (() => void) | null = null;
let cost = 0;
let mcpServers: any[] = [];
let clientCaps: any = {};

// The client's MCP server, started as an agent starts one: its command with its arguments and variables, over stdio.
async function viaMcp(server: any, calls: [string, any][]): Promise<any[]> {
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((v: any) => [v.name, v.value])) };
  const child = Bun.spawn([server.command, ...server.args], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let buf = "";
  let n = 0;
  const rpc = async (method: string, params: unknown) => {
    const id = ++n;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    child.stdin.flush();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === id) return m; continue; }
      const { value, done } = await reader.read();
      if (done) throw new Error("the MCP server ended");
      buf += new TextDecoder().decode(value);
    }
  };
  const out: any[] = [await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "standin", version: "1" } })];
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (const [m, p] of calls) out.push(await rpc(m, p));
  child.kill();
  return out;
}
// Its models and reasoning levels, as session config options; "which model" is answered with the current ones.
const config = { model: "fast", effort: "low" };
// Its on and off options, offered to a client that shows them (session.configOptions.boolean).
const switches: Record<string, boolean> = { brief: false, brave_mode: true };
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: config.model, options: [{ group: "main", name: "Main", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep", description: "Slower, thinks longer" }, { value: "busy", name: "Busy", description: "Listed, and refused when asked for" }] }] },
  { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: config.effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ...(clientCaps.session?.configOptions?.boolean ? [
    { id: "brief", name: "Brief replies", description: "Answer in one line", type: "boolean", currentValue: switches.brief },
    { id: "brave_mode", name: "Brave Mode", description: "Skip confirmation prompts and act autonomously", type: "boolean", currentValue: switches.brave_mode },
  ] : []),
];

async function prompt(id: number, p: any) {
  const s = p.sessionId;
  const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  // Its slash commands, sent as the text of a prompt.
  const cmd = text.match(/^\/(web|test)\b\s*(.*)$/s);
  if (cmd) {
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ran /${cmd[1]}${cmd[2] ? ` with: ${cmd[2]}` : ""}` } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (/which model/.test(text)) {
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `model ${config.model}, effort ${config.effort}, brief ${switches.brief ? "on" : "off"}, brave ${switches.brave_mode ? "on" : "off"}` } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (/again/.test(text)) {
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Before, you said: ${said.join(" | ")}` } });
    said.push(text);
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (/keel tools/.test(text)) {
    const keel = mcpServers.find((m) => m.name === "keel");
    if (!keel) {
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `No keel server among ${JSON.stringify(mcpServers)}` } });
      return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    const [, listed] = await viaMcp(keel, [["tools/list", {}]]);
    const names: string[] = (listed.result?.tools ?? []).map((t: any) => t.name).sort();
    const echo = names.find((n) => n.endsWith("__echo"))!;
    // Asked as Claude's agent asks for an MCP tool: the client answers it without a card of its own.
    update(s, { sessionUpdate: "tool_call", toolCallId: "call-mcp", title: `mcp__keel__${echo}`, kind: "other", status: "pending", rawInput: { text: "through keel" } });
    const perm = await ask("session/request_permission", { sessionId: s, toolCall: { toolCallId: "call-mcp", title: `mcp__keel__${echo}`, kind: "other", rawInput: { text: "through keel" } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    const [, called] = await viaMcp(keel, [["tools/call", { name: echo, arguments: { text: "through keel" } }]]);
    const said = (called.result?.content ?? []).map((c: any) => c.text).join("");
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-mcp", status: called.result?.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: said } }] });
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tools: ${names.join(", ")}; permission: ${perm.result?.outcome?.optionId}; result: ${said}` } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (/terminal/.test(text)) {
    if (!clientCaps.terminal) {
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The client has no terminal." } });
      return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    // As Claude's agent does: it asks about the command, then runs it in a terminal of the client's.
    const long = /terminal wait/.test(text);
    const line = long ? "sleep 600" : "echo made > term.txt; echo from the terminal";
    update(s, { sessionUpdate: "tool_call", toolCallId: "call-term", title: long ? "Wait a while" : "Run the note script", kind: "execute", status: "pending", rawInput: { command: line } });
    const asked = await ask("session/request_permission", { sessionId: s, toolCall: { toolCallId: "call-term", title: line, kind: "execute", rawInput: { command: line } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    if (asked.result?.outcome?.optionId !== "yes") {
      update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-term", status: "failed" });
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Not allowed." } });
      return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    const made = await ask("terminal/create", { sessionId: s, command: "bash", args: ["-c", line], cwd, outputByteLimit: 4096 });
    if (made.error) {
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Refused: ${made.error.message}` } });
      return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    const terminalId = made.result.terminalId;
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-term", status: "in_progress", content: [{ type: "terminal", terminalId }] });
    if (long) {
      // Until the client stops the turn: the command is left to the client to stop.
      await new Promise<void>((r) => (cancel = r));
      return out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
    }
    const exit = await ask("terminal/wait_for_exit", { sessionId: s, terminalId });
    const o = await ask("terminal/output", { sessionId: s, terminalId });
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-term", status: "completed" });
    await ask("terminal/release", { sessionId: s, terminalId });
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `exit ${exit.result?.exitCode}; output: ${o.result?.output.trim()}` } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  said.push(text);
  // Its own file access, outside ACP: a sandboxed agent cannot write there.
  const escape = text.match(/escape (\S+)/)?.[1];
  if (escape) {
    let r: string;
    try { require("node:fs").writeFileSync(escape, "outside"); r = "I wrote outside the folder."; } catch (e) { r = `Blocked: ${(e as Error).message}`; }
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: r } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  if (/wait/.test(text)) {
    update(s, { sessionUpdate: "tool_call", toolCallId: "call-wait", title: "sleep 600", kind: "execute", status: "in_progress", rawInput: { command: "sleep 600" } });
    await new Promise<void>((r) => (cancel = r));
    return out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
  }
  update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The owner wants a note in the folder." } });
  update(s, { sessionUpdate: "plan", entries: [{ content: "Make the build folder", priority: "medium", status: "completed" }, { content: "Write the note", priority: "medium", status: "in_progress" }] });
  update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Making the build folder first. " } });
  update(s, { sessionUpdate: "tool_call", toolCallId: "call-ls", title: "mkdir -p build", kind: "execute", status: "pending", rawInput: { command: "mkdir -p build" } });
  const perm = await ask("session/request_permission", {
    sessionId: s,
    toolCall: { toolCallId: "call-ls", title: "mkdir -p build", kind: "execute", rawInput: { command: "mkdir -p build" } },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
  });
  const allowed = perm.result?.outcome?.outcome === "selected" && perm.result.outcome.optionId !== "no";
  update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-ls", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "total 0\nnote-target" : "The client refused the command." } }] });
  const path = `${cwd}/acp-note.txt`;
  update(s, { sessionUpdate: "tool_call", toolCallId: "call-write", title: "Write acp-note.txt", kind: "edit", status: "pending", locations: [{ path }], content: [{ type: "diff", path, oldText: null, newText: text }] });
  const w = await ask("fs/write_text_file", { sessionId: s, path, content: text });
  update(s, { sessionUpdate: "tool_call_update", toolCallId: "call-write", status: w.error ? "failed" : "completed", ...(w.error ? { content: [{ type: "content", content: { type: "text", text: w.error.message } }] } : {}) });
  cost += 0.0125;
  update(s, { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: cost, currency: "USD" } });
  update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: w.error ? "I could not write the note." : "The note is written." } });
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 } } });
}


// --- ACP v2 (Preview) ---
type Bg = { type: string; terminalId?: string; toolCallId?: string };
const V2_SESSION = "standin-v2";
let fg = "idle";
let background: Bg[] = [];
let heldCancel: (() => void) | null = null;
const files = () => ({ keys: `${cwd}/.v2-keys.json`, runs: `${cwd}/.v2-runs.log` });
const readKeys = (): Record<string, string> => { try { return JSON.parse(require("node:fs").readFileSync(files().keys, "utf8")); } catch { return {}; } };
const state = (state: string, more: Record<string, unknown> = {}) => { fg = state; update(V2_SESSION, { sessionUpdate: "state_update", state, background, ...more }); };
const snapshot = () => update(V2_SESSION, { sessionUpdate: "state_update", state: fg, background });
const terms = new Map<string, { command: string; cancel: boolean; live: boolean }>();
const termUpdate = (id: string, more: Record<string, unknown>) => update(V2_SESSION, { sessionUpdate: "terminal_update", terminalId: id, ...more });
const v2Options = () => [{ configId: "model", name: "Model", category: "model", type: "select", currentValue: config.model, options: [{ groupId: "main", name: "Main", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }] }];

function v2Prompt(id: number, p: any) {
  const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  const key = typeof p.idempotencyKey === "string" ? p.idempotencyKey : undefined;
  const keys = readKeys();
  // A key it knows: the message it inserted, and nothing else.
  if (key && keys[key]) return out({ jsonrpc: "2.0", id, result: { messageId: keys[key] } });
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (key) { keys[key] = messageId; require("node:fs").writeFileSync(files().keys, JSON.stringify(keys)); }
  require("node:fs").appendFileSync(files().runs, JSON.stringify({ key: key ?? null, text, messageId }) + "\n");
  out({ jsonrpc: "2.0", id, result: { messageId } });
  update(V2_SESSION, { sessionUpdate: "user_message", messageId, content: [{ type: "text", text }] });
  void v2Work(text);
}

async function v2Work(text: string) {
  state("running");
  update(V2_SESSION, { sessionUpdate: "agent_thought", messageId: "th-1", content: [{ type: "text", text: "Thinking about it." }] });
  if (/slow/.test(text)) {
    update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-slow", title: "sleep 600", kind: "execute", status: "in_progress", rawInput: { command: "sleep 600" } });
    await new Promise<void>((r) => (heldCancel = r));
    heldCancel = null;
    update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-slow", status: "cancelled" });
    return state("idle", { stopReason: "cancelled" });
  }
  if (/boom/.test(text)) return state("idle", { stopReason: "error", error: { code: -32603, message: "The model service failed." } });
  if (/background/.test(text)) {
    for (const [id, command, cancel] of [["term-dev", "npm run dev", true], ["term-log", "tail -f server.log", false]] as const) {
      terms.set(id, { command, cancel, live: true });
      termUpdate(id, { command, cwd, output: { data: Buffer.from(`${command}: listening\r\n`).toString("base64") }, ...(cancel ? { capabilities: { cancel: {} } } : {}) });
    }
    update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-start", title: "Start the dev server", kind: "execute", status: "completed", content: [{ type: "terminal", terminalId: "term-dev" }] });
    update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-watch", title: "Watch the build", kind: "other", status: "in_progress", capabilities: { cancel: {} } });
    background = [{ type: "terminal", terminalId: "term-dev" }, { type: "terminal", terminalId: "term-log" }, { type: "tool_call", toolCallId: "call-watch" }];
    update(V2_SESSION, { sessionUpdate: "agent_message", messageId: "ag-1", content: [{ type: "text", text: "The dev server runs in the background." }] });
    return state("idle", { stopReason: "end_turn" });
  }
  // A call, a permission request in v2's shape, a reply in chunks.
  update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-ls", title: "mkdir -p build", kind: "execute", status: "pending", rawInput: { command: "mkdir -p build" } });
  state("requires_action");
  const perm = await ask("session/request_permission", { sessionId: V2_SESSION, title: "Run mkdir?", subject: { type: "tool_call", toolCall: { toolCallId: "call-ls" } },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
  state("running");
  const allowed = perm.result?.outcome?.outcome === "selected" && perm.result.outcome.optionId === "yes";
  update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-ls", status: allowed ? "completed" : "cancelled", content: [{ type: "content", content: { type: "text", text: allowed ? "made" : "refused" } }] });
  update(V2_SESSION, { sessionUpdate: "agent_message_chunk", messageId: "ag-2", content: { type: "text", text: "Done: " } });
  update(V2_SESSION, { sessionUpdate: "agent_message", messageId: "ag-2", content: [{ type: "text", text: `Done: ${allowed ? "allowed" : "refused"}` }] });
  state("idle", { stopReason: "end_turn" });
}

// True when the message was answered here (a v2 connection).
function v2(m: any): boolean {
  switch (m.method) {
    case "initialize":
      if (!(m.params?.protocolVersion >= 2)) return false;
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 2, info: { name: "standin", version: "1" }, capabilities: { session: { mcp: { stdio: {} } } }, authMethods: [] } });
      return true;
    case "session/new": case "session/resume": {
      if (m.params.cwd) cwd = m.params.cwd;
      mcpServers = m.params.mcpServers ?? [];
      if (m.method === "session/resume") snapshot();
      out({ jsonrpc: "2.0", id: m.id, result: { ...(m.method === "session/new" ? { sessionId: V2_SESSION } : {}), configOptions: v2Options(), availableCommands: [{ type: "command", name: "test", description: "Run the project's tests" }] } });
      return true;
    }
    case "session/prompt": v2Prompt(m.id, m.params); return true;
    case "session/cancel": heldCancel?.(); return true;
    case "tool_call/cancel": {
      const live = background.some((b) => b.toolCallId === m.params.toolCallId);
      if (!live || m.params.toolCallId !== "call-watch") out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "not cancellable" } });
      else {
        out({ jsonrpc: "2.0", id: m.id, result: {} });
        update(V2_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call-watch", status: "cancelled", capabilities: null });
        background = background.filter((b) => b.toolCallId !== "call-watch");
        snapshot();
      }
      return true;
    }
    case "terminal/cancel": {
      const t = terms.get(m.params.terminalId);
      if (!t?.live || !t.cancel) out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "not cancellable" } });
      else {
        out({ jsonrpc: "2.0", id: m.id, result: {} });
        t.live = false;
        termUpdate(m.params.terminalId, { exitStatus: { exitCode: null, signal: "SIGTERM" }, capabilities: null });
        background = background.filter((b) => b.terminalId !== m.params.terminalId);
        snapshot();
      }
      return true;
    }
    case "session/close": out({ jsonrpc: "2.0", id: m.id, result: {} }); return true;
    default: return false;
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    // (A v2 connection is answered by v2(); an initialize that asks for 1 is answered as before.)
    if (V2 && (m.method === "initialize" ? m.params?.protocolVersion >= 2 : v2Mode) && v2(m)) { if (m.method === "initialize") v2Mode = true; continue; }
    if (m.method === "initialize") { clientCaps = m.params?.clientCapabilities ?? {}; v2Mode = false; }
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "standin", version: "1" }, authMethods: [] } });
    else if (m.method === "session/new") {
      cwd = m.params.cwd; mcpServers = m.params.mcpServers ?? [];
      const sessionId = `standin-${Date.now()}`;
      out({ jsonrpc: "2.0", id: m.id, result: { sessionId, configOptions: configOptions() } });
      // Its slash commands, once the session is made.
      setTimeout(() => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "web", description: "Search the web for information", input: { hint: "query to search for" } },
        { name: "test", description: "Run the project's tests" },
      ] }), 0);
    }
    else if (m.method === "session/set_config_option") {
      const key = m.params.configId === "model" ? "model" : m.params.configId === "effort" ? "effort" : null;
      if (m.params.type === "boolean" && m.params.configId in switches) { switches[m.params.configId] = !!m.params.value; out({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions() } }); }
      else if (!key) out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `no option ${m.params.configId}` } });
      else if (m.params.value === "busy") out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "that model is busy" } });
      else { config[key] = String(m.params.value); out({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions() } }); }
    }
    else if (m.method === "session/prompt") void prompt(m.id, m.params);
    else if (m.method === "session/cancel") cancel?.();
    else if (m.method === "session/close") out({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
