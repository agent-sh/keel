// `keel acp [--url http://127.0.0.1:47960]`: speak the Agent Client Protocol on
// stdio for an editor, driving the running daemon at --url (or KEEL_URL).
// Zed: "agent_servers": { "Keel": { "command": "keel", "args": ["acp"] } }.
import { parseArgs } from "node:util";
import { AcpBridge, type DaemonApi } from "../acp/bridge.ts";
import { findDaemon } from "./client.ts";

export function daemonApi(base: string): DaemonApi {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const b = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { code: r.status === 404 ? -32002 : -32603 });
    return b;
  };
  return {
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
    frames: (on) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
        ws.onopen = () => resolve(() => ws.close());
        ws.onerror = () => reject(new Error(`cannot reach the Keel daemon at ${base}`));
        ws.onmessage = (m) => { try { on(JSON.parse(String(m.data))); } catch {} };
        ws.onclose = () => process.exit(0); // the daemon went away: the editor sees the agent end
      }),
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
  for await (const chunk of Bun.stdin.stream()) {
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
  bridge.close();
  await Promise.allSettled([...inflight]);
  return 0;
}

export const acpCommands = { acp };
