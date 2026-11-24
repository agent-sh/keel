// A stand-in ACP agent that announces children (bun acp-agent-children.ts), for the e2e of keel-bun as an ACP
// client that shows subagents (docs/protocol/v1/subagents.mdx). On a prompt it announces two children under its
// session when the client advertised `subagents`:
//   child-test: "Test investigator". Its parent's task arrives as a session message, it runs a command and asks
//     permission for it with its own sessionId, then reports and goes idle.
//   child-docs: "Doc checker". It reads a file, announces that it can be cancelled, and works until the client
//     sends session/cancel for it; it then goes idle with stopReason cancelled.
// The prompt answers when both are idle. A prompt that finds no `subagents` in the client's capabilities answers
// at once and announces nothing (an agent that announces none changes nothing for the client).
// Its last message names what the client answered to the child's permission request and how the other child ended.
const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
let next = 1;
const waiting = new Map<number, (m: any) => void>();
const ask = (method: string, params: unknown) => new Promise<any>((res) => { const id = next++; waiting.set(id, res); out({ jsonrpc: "2.0", id, method, params }); });
const update = (sessionId: string, u: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
let caps: any = {};
const ROOT = "children-root";
const TEST = "child-test";
const DOCS = "child-docs";
const cancelled = new Set<string>();
const cancelWaiters = new Map<string, () => void>();

const state = (child: string, s: unknown) => update(ROOT, { sessionUpdate: "subagent_update", sessionId: child, state: s });

async function testChild(): Promise<string> {
  update(ROOT, { sessionUpdate: "subagent_update", sessionId: TEST, title: "Test investigator", description: "Finds out why the integration tests fail.", capabilities: { cancel: {} } });
  update(TEST, { sessionUpdate: "session_message", messageId: "m1", senderSessionId: ROOT, recipientSessionId: TEST, content: [{ type: "text", text: "Find out why the integration tests fail on Windows." }] });
  state(TEST, { state: "running" });
  update(TEST, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The failing job runs the suite on a Windows runner." } });
  update(TEST, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running the suite once to see the failure." } });
  update(TEST, { sessionUpdate: "tool_call", toolCallId: "call_001", title: "Run the integration tests", kind: "execute", status: "pending", rawInput: { command: "touch investigated.txt" } });
  state(TEST, { state: "requires_action" });
  const r = await ask("session/request_permission", {
    sessionId: TEST,
    toolCall: { toolCallId: "call_001" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
  });
  const allowed = r.result?.outcome?.outcome === "selected" && r.result.outcome.optionId === "allow-once";
  state(TEST, { state: "running" });
  update(TEST, { sessionUpdate: "tool_call_update", toolCallId: "call_001", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "2 failed, 41 passed" : "the owner did not allow the command" } }] });
  update(TEST, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "Two tests fail: both build a path with a backslash." : "I could not run the suite." } });
  state(TEST, { state: "idle", stopReason: "end_turn" });
  return allowed ? "allowed" : "refused";
}

async function docsChild(): Promise<string> {
  update(ROOT, { sessionUpdate: "subagent_update", sessionId: DOCS, title: "Doc checker", description: "Checks the guides against the code.", capabilities: { cancel: {} } });
  update(DOCS, { sessionUpdate: "session_message", messageId: "m2", senderSessionId: ROOT, recipientSessionId: DOCS, content: [{ type: "text", text: "Check that the install guide matches the code." }] });
  state(DOCS, { state: "running" });
  update(DOCS, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the install guide." } });
  update(DOCS, { sessionUpdate: "tool_call", toolCallId: "call_001", title: "Read INSTALL.md", kind: "read", status: "in_progress", locations: [{ path: "/tmp/INSTALL.md" }], rawInput: { file_path: "/tmp/INSTALL.md" } });
  // Works until the client cancels this child.
  if (!cancelled.has(DOCS)) await new Promise<void>((res) => cancelWaiters.set(DOCS, res));
  update(DOCS, { sessionUpdate: "tool_call_update", toolCallId: "call_001", status: "failed", content: [{ type: "content", content: { type: "text", text: "cancelled" } }] });
  state(DOCS, { state: "idle", stopReason: "cancelled" });
  return "cancelled";
}

async function prompt(id: number, params: any) {
  if (!caps.subagents) {
    update(ROOT, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "No subagents: the client did not advertise them." } });
    return out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  }
  update(ROOT, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I start two children." } });
  const [a, b] = await Promise.all([testChild(), docsChild()]);
  update(ROOT, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Children done: test ${a}, docs ${b}.` } });
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  void params;
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
    if (m.method === "initialize") {
      caps = m.params?.clientCapabilities ?? {};
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "children", version: "1" }, authMethods: [] } });
    } else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: { sessionId: ROOT } });
    else if (m.method === "session/prompt") void prompt(m.id, m.params);
    else if (m.method === "session/cancel") {
      const who = m.params?.sessionId;
      cancelled.add(who);
      cancelWaiters.get(who)?.();
    } else if (m.method === "session/close") out({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
