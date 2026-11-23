// Keel's tools for an ACP agent: the owner's MCP servers as Keel connects
// them, offered to the agent as one MCP server of its session (ACP
// session/new mcpServers, the stdio transport every agent speaks). Editors
// pass their own servers' commands for the agent to start; Keel passes one
// server of its own instead, so every call is judged and run here, as a call
// of the session's model would be (the owner's hooks, the gate, the tool),
// and no credential of a server reaches the agent.
//
// A confined agent has no route to the daemon's port (its sandbox has a
// network of its own, src/safety/net-proxy.ts). The channel is a unix socket
// in a folder of the session's own, bound read-only into the agent's sandbox
// (a socket is reached on a read-only mount); the server's command is a small
// relay, kept in a folder of its own beside them, that passes its stdio
// through it. Nothing the agent can write is ever written by the daemon: a
// session's folder is made anew at each listen, the relay is written by a
// rename, and what an earlier daemon left is removed at start (clearServed).
//
// Spec: agentclientprotocol.com/protocol/v1/session-setup (MCP servers),
// modelcontextprotocol.io/specification/2025-11-25 (lifecycle, tools).
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { ToolResultBlock } from "../core/types.ts";

type Json = any;
export const SERVED_NAME = "keel";

// The relay the agent starts (run by this process's own runtime). Self-contained: its text is the program.
function relay() {
  const net = process.getBuiltinModule("node:net") as typeof import("node:net");
  const s = net.createConnection(process.argv[2]!);
  s.once("connect", () => { process.stdin.pipe(s); s.pipe(process.stdout); });
  s.once("error", (e) => { process.stderr.write(`keel: Keel's tools are not reachable: ${e.message}\n`); process.exit(1); });
  s.once("close", () => process.exit(0));
}
export const SERVED_RELAY_JS = `(${relay.toString()})();\n`;

export type ServedTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean };
export type ServedDeps = {
  list(): Promise<ServedTool[]>;
  call(name: string, args: Record<string, unknown>, id: string): Promise<ToolResultBlock>;
};

// The MCP versions this server speaks, newest first: a client's own is answered with itself.
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// The owner's memory a hook of Keel's adds to a result is for Keel's own model, not for another agent.
const MEMORY = /\n*<memory source="[^"]*" hook="[a-z-]+">\n[\s\S]*?\n<\/memory>\n*/g;
export const withoutMemory = (t: string) => t.replace(MEMORY, (m) => (m.startsWith("\n") && m.endsWith("\n") ? "\n" : "")).trim();

// A Keel result as an MCP tool result.
export function mcpResult(r: ToolResultBlock): Json {
  const content = typeof r.content === "string" ? [{ type: "text", text: withoutMemory(r.content) }]
    : r.content.map((b: Json) => (b.type === "image" ? { type: "image", data: b.data, mimeType: b.media_type } : { type: "text", text: withoutMemory(String(b.text ?? "")) }));
  return { content, ...(r.is_error ? { isError: true } : {}) };
}

// One message of the agent's MCP client, answered (null: a notification, or a reply to nothing asked).
export async function answer(msg: Json, deps: ServedDeps): Promise<Json | null> {
  if (msg?.id === undefined || typeof msg.method !== "string") return null;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVED_NAME, title: "Keel", version: "1" },
        instructions: "The owner's MCP servers as Keel runs them. Each call is judged by Keel's permission gate for this session, as Keel's own model's calls are.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: (await deps.list()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}) })) });
    case "tools/call": {
      if (typeof p.name !== "string") return err(-32602, "name is required");
      const args = p.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return err(-32602, "arguments must be an object");
      const r = await deps.call(p.name, args, `acp-mcp-${crypto.randomUUID()}`);
      return ok(mcpResult(r));
    }
    default:
      return err(-32601, `method not found: ${msg.method}`);
  }
}

// Where the served tools live in Keel's state: the relay's folder, and one folder a session.
const servedRoot = (state: string) => join(state, "acp");
// What an earlier daemon left (one that stopped without closing its servers): no agent of it runs now.
export function clearServed(state: string) {
  rmSync(servedRoot(state), { recursive: true, force: true });
}

// The served server of one agent connection: its socket, and the line the agent is given.
export class ServedTools {
  readonly dir: string;
  readonly sock: string;
  readonly relayFile: string;
  private server?: Server;
  private clients = new Set<Socket>();
  private listed?: string;

  readonly relayDir: string;
  // `root`: Keel's state folder. One folder a session, named short (a socket's path has about a hundred bytes).
  constructor(root: string, sessionId: string, private deps: ServedDeps, private log: (e: unknown) => void = () => {}) {
    this.dir = join(servedRoot(root), "s", createHash("sha256").update(sessionId).digest("hex").slice(0, 16));
    this.sock = join(this.dir, "mcp.sock");
    this.relayDir = join(servedRoot(root), "relay");
    this.relayFile = join(this.relayDir, "relay.js");
  }

  async listen(): Promise<void> {
    // (Made anew: whatever is in it was not made by this listen.)
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.relayDir, { recursive: true, mode: 0o700 });
    // (A rename replaces the name itself: a link left in its place is not followed.)
    const tmp = `${this.relayFile}.${process.pid}.${crypto.randomUUID()}`;
    writeFileSync(tmp, SERVED_RELAY_JS, { flag: "wx", mode: 0o600 });
    renameSync(tmp, this.relayFile);
    const server = createServer((c) => this.serve(c));
    await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(this.sock, () => { server.off("error", rej); res(); }); });
    this.server = server;
  }

  // What session/new carries for it.
  config(): Json {
    return { name: SERVED_NAME, command: process.execPath, args: [this.relayFile, this.sock], env: [{ name: "BUN_BE_BUN", value: "1" }] };
  }

  private serve(c: Socket) {
    this.clients.add(c);
    c.on("error", () => {});
    c.on("close", () => this.clients.delete(c));
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("utf8");
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: Json;
        try { msg = JSON.parse(line); } catch { c.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); continue; }
        void answer(msg, this.answering).then(
          (r) => { if (r) c.write(JSON.stringify(r) + "\n"); },
          (e) => { this.log(e); c.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: (e as Error).message } }) + "\n"); },
        );
      }
    });
  }

  // (What was last listed to the agent is kept: a change from it is told.)
  private answering: ServedDeps = {
    list: async () => { const l = await this.deps.list(); this.listed = JSON.stringify(l); return l; },
    call: (n, a, id) => this.deps.call(n, a, id),
  };

  // The tools offered now, compared with what the agent last listed: a change is told to it, and it lists again.
  async refresh(): Promise<void> {
    if (!this.clients.size || this.listed === undefined) return;
    const now = JSON.stringify(await this.deps.list());
    if (now !== this.listed) for (const c of this.clients) c.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n");
  }

  close() {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
