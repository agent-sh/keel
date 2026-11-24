// `keel acp [--url http://127.0.0.1:47960]`: speak the Agent Client Protocol on
// stdio for an editor, driving the running daemon at --url (or KEEL_URL).
// Zed: "agent_servers": { "Keel": { "type": "custom", "command": "keel", "args": ["acp"] } }.
import { parseArgs } from "node:util";
import { AcpBridge, type DaemonApi } from "../acp/bridge.ts";
import { authHeaders, findDaemon } from "./client.ts";
import { chunks } from "../core/proc.ts";

export function daemonApi(base: string): DaemonApi {
  let socket: WebSocket | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as any;
    // (`held`: an approval's answer was not taken and its card still waits.)
    if (!r.ok) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { code: r.status === 404 ? -32002 : -32603, ...(r.status === 409 && Array.isArray(b.hold) ? { held: true } : {}) });
    return b;
  };
  return {
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
    // An editor's embedded file: stored by the daemon like a file the owner attaches.
    upload: async (name, type, bytes) => {
      const r = await fetch(`${base}/api/attachments?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type, ...authHeaders() }, body: bytes as Uint8Array<ArrayBuffer> });
      const b = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { code: -32602 });
      return b;
    },
    // Open until this process ends: the daemon drops what it holds when it closes.
    hold: (holder) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/mcp/hold?holder=${encodeURIComponent(holder)}`, { headers: authHeaders() } as any);
        ws.onmessage = () => resolve(() => ws.close());
        ws.onerror = () => reject(new Error(`the Keel daemon at ${base} took no hold for the editor's MCP servers`));
        ws.onclose = () => reject(new Error(`the Keel daemon at ${base} closed the hold for the editor's MCP servers`));
      }),
    frames: (on) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: authHeaders() } as any);
        ws.onopen = () => {
          // Only the sessions the bridge names (watch), as a page hears the ones it shows; from now on.
          ws.send(JSON.stringify({ op: "resume", cursors: {}, only: true }));
          socket = ws;
          resolve(() => ws.close());
        };
        ws.onerror = () => reject(new Error(`cannot reach the Keel daemon at ${base}`));
        ws.onmessage = (m) => { try { on(JSON.parse(String(m.data))); } catch {} };
        ws.onclose = () => process.exit(0); // the daemon went away: the editor sees the agent end
      }),
    // A cursor: the session's events stored after it come first, then its frames (no gap, no
    // repeat: the daemon replays and subscribes in one go). Null: its frames from now.
    watch: (cursors) => {
      const from = Object.fromEntries(Object.entries(cursors).filter(([, c]) => c !== null)) as Record<string, number>;
      const now = Object.keys(cursors).filter((id) => cursors[id] === null);
      socket?.send(JSON.stringify({ op: "sub", cursors: from, watch: now }));
    },
    unwatch: (ids) => socket?.send(JSON.stringify({ op: "unsub", watch: ids })),
  };
}

export async function acp(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return (console.log("keel acp [--url http://127.0.0.1:47960]: an editor drives Keel over ACP on stdio"), 0);
  const base = findDaemon({ url: values.url }).url;
  const bridge = new AcpBridge(daemonApi(base), (msg) => process.stdout.write(JSON.stringify(msg) + "\n"), (m) => process.stderr.write(`keel acp: ${m}\n`));
  const inflight = new Set<Promise<void>>();
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of chunks(Bun.stdin.stream())) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      // A prompt runs while cancel and permission answers arrive.
      const h = bridge.handle(msg).finally(() => inflight.delete(h));
      inflight.add(h);
    }
  }
  // The editor closed its end: running turns go on in the workbench; answer what is open and stop.
  const released = bridge.close();
  await Promise.allSettled([...inflight, released]);
  return 0;
}

export const acpCommands = { acp };
