// A stand-in ACP agent for the e2e of keel-bun as an ACP client (bun
// acp-agent-standin.ts). Over stdio it answers initialize and session/new,
// and a prompt with: a thought, a plan, a command it asks permission for, a
// file it writes through the client, a usage update and a reply. A prompt
// with "wait" hangs until session/cancel; "again" answers with what it was
// told before, so a test sees the agent keep its own history. Its models and
// reasoning levels are config options; "which model" names the current ones.
// "keel tools" starts the MCP server the client passed in session/new, lists
// its tools and calls one; "terminal" runs a command in a client terminal.
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
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: config.model, options: [{ group: "main", name: "Main", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep", description: "Slower, thinks longer" }, { value: "busy", name: "Busy", description: "Listed, and refused when asked for" }] }] },
  { id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue: config.effort, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];

async function prompt(id: number, p: any) {
  const s = p.sessionId;
  const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  if (/which model/.test(text)) {
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `model ${config.model}, effort ${config.effort}` } });
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

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    if (m.method === "initialize") clientCaps = m.params?.clientCapabilities ?? {};
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "standin", version: "1" }, authMethods: [] } });
    else if (m.method === "session/new") { cwd = m.params.cwd; mcpServers = m.params.mcpServers ?? []; out({ jsonrpc: "2.0", id: m.id, result: { sessionId: `standin-${Date.now()}`, configOptions: configOptions() } }); }
    else if (m.method === "session/set_config_option") {
      const key = m.params.configId === "model" ? "model" : m.params.configId === "effort" ? "effort" : null;
      if (!key) out({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `no option ${m.params.configId}` } });
      else if (m.params.value === "busy") out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "that model is busy" } });
      else { config[key] = String(m.params.value); out({ jsonrpc: "2.0", id: m.id, result: { configOptions: configOptions() } }); }
    }
    else if (m.method === "session/prompt") void prompt(m.id, m.params);
    else if (m.method === "session/cancel") cancel?.();
    else if (m.method === "session/close") out({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
