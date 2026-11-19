// A stand-in ACP agent for the e2e of keel-bun as an ACP client (bun
// acp-agent-standin.ts). Over stdio it answers initialize and session/new,
// and a prompt with: a thought, a plan, a command it asks permission for, a
// file it writes through the client, a usage update and a reply. A prompt
// with "wait" hangs until session/cancel; "again" answers with what it was
// told before, so a test sees the agent keep its own history.
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let next = 1;
const waiting = new Map<number, (m: any) => void>();
const ask = (method: string, params: unknown) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); out({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId: string, u: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const said: string[] = [];
let cwd = "";
let cancel: (() => void) | null = null;
let cost = 0;

async function prompt(id: number, p: any) {
  const s = p.sessionId;
  const text = (p.prompt ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
  if (/again/.test(text)) {
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Before, you said: ${said.join(" | ")}` } });
    said.push(text);
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  said.push(text);
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
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "standin", version: "1" }, authMethods: [] } });
    else if (m.method === "session/new") { cwd = m.params.cwd; out({ jsonrpc: "2.0", id: m.id, result: { sessionId: `standin-${Date.now()}` } }); }
    else if (m.method === "session/prompt") void prompt(m.id, m.params);
    else if (m.method === "session/cancel") cancel?.();
    else if (m.method === "session/close") out({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
