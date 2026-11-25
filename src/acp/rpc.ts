// One JSON-RPC connection to an ACP agent over stdio (newline-delimited
// messages, agentclientprotocol.com/protocol/v1/transports). Keel is the
// client: it sends requests and notifications, and answers the agent's
// requests (permission, files) through `onRequest`.
import { pumpLines, pumpText } from "../core/proc.ts";
import { begin } from "../admin/activity.ts";
import { scrubbedEnv } from "../safety/env-secret.ts";

type Json = any;
export type RpcFailure = Error & { code?: number; data?: unknown };

// The most characters Keel reads in one line from an agent. Messages are lines, and what a tool shows is cut by the
// agent itself to far less than this (a file read or a command's output is tens of KB), so a line this long is
// not a message to take: reading one holds the loop for as long as it takes to parse (about 0.04 s a MB).
export const LINE_MAX = 4 * 1024 * 1024;

// How much of a dropped line is read to learn which request it answered.
const HEAD_CHARS = 1024;
const SIMPLE = /\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)\s*/y;
const KEY = /\s*"((?:[^"\\]|\\.)*)"\s*:/y;

// The id of the response a line's first characters begin, or undefined. The leading members are read one at a
// time while their values are plain (a string, a number, true, false, null): a "result" or "error" member
// makes the line a response, a "method" a request or a notification. A line whose members cannot be told
// that way, or whose "id" is cut by the head, names nothing.
export function responseId(head: string): number | undefined {
  let i = head.search(/\S/);
  if (i < 0 || head[i] !== "{") return undefined;
  i++;
  let id: number | undefined;
  for (;;) {
    KEY.lastIndex = i;
    const k = KEY.exec(head);
    if (!k) return undefined;
    if (k[1] === "method") return undefined;
    if (k[1] === "result" || k[1] === "error") return id;
    SIMPLE.lastIndex = KEY.lastIndex;
    const v = SIMPLE.exec(head);
    if (!v) return undefined;
    if (k[1] === "id") id = /^\d+$/.test(v[1]!) && SIMPLE.lastIndex < head.length ? Number(v[1]) : undefined;
    i = SIMPLE.lastIndex;
    if (head[i] !== ",") return undefined;
    i++;
  }
}

export class AcpConnection {
  private proc: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: RpcFailure) => void }>();
  private stderr = "";
  readonly exited: Promise<number>;
  // A line the agent wrote that is longer than LINE_MAX is dropped unread (told here and in the log with its length).
  onOversize: (chars: number) => void = () => {};
  onNotification: (method: string, params: Json) => void = () => {};
  // `id`: the request's own id, which the agent's `$/cancel_request` names (ACP v2 cancels a permission request that way).
  onRequest: (method: string, params: Json, id: number | string) => Promise<Json> = async (m) => { throw Object.assign(new Error(`method not found: ${m}`), { code: -32601 }); };

  constructor(argv: string[], opts: { cwd: string; env?: Record<string, string>; pass?: string[] }, private log: (m: string) => void = () => {}) {
    this.proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.pass ? scrubbedEnv(process.env, opts.pass, opts.env) : { ...process.env, ...opts.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const end = begin("acp_agents");
    void this.proc.exited.then(end, end);
    void pumpLines(this.proc.stdout as ReadableStream<Uint8Array>, (l) => this.line(l), "acp agent stdout", {
      max: LINE_MAX,
      head: HEAD_CHARS,
      over: (n, head) => {
        const id = responseId(head);
        this.log(`a line of ${n} characters from the agent was dropped (the most Keel reads in one is ${LINE_MAX})${id === undefined ? "" : `; it answered request ${id}`}`);
        // A response dropped unread would leave its request waiting for ever.
        const p = id === undefined ? undefined : this.pending.get(id);
        if (p) {
          this.pending.delete(id!);
          p.reject(Object.assign(new Error(`the agent's answer was ${n} characters, more than the ${LINE_MAX} Keel reads in one line, and was dropped`), { code: -32603 }));
        }
        this.onOversize(n);
      },
    });
    // The tail of what the agent wrote to stderr: said when it ends early.
    void pumpText(this.proc.stderr as ReadableStream<Uint8Array>, (t) => { this.stderr = (this.stderr + t).slice(-4000); }, "acp agent stderr");
    this.exited = this.proc.exited.then((code) => {
      const why = this.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      for (const p of this.pending.values()) p.reject(Object.assign(new Error(`the agent exited (code ${code})${why ? `: ${why}` : ""}`), { code: -32603 }));
      this.pending.clear();
      return code;
    });
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  private write(msg: Json) {
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(msg) + "\n");
    sink.flush();
  }

  request(method: string, params: Json): Promise<Json> {
    if (!this.alive) return Promise.reject(Object.assign(new Error("the agent is not running"), { code: -32603 }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json) {
    if (this.alive) this.write({ jsonrpc: "2.0", method, params });
  }

  private line(l: string) {
    if (!l.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(l); } catch { return this.log(`not JSON from the agent: ${l.slice(0, 200)}`); }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message ?? "the agent failed")), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id === undefined) return this.onNotification(msg.method, msg.params ?? {});
    this.onRequest(msg.method, msg.params ?? {}, msg.id).then(
      (result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
      (e: RpcFailure) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
    );
  }

  // Its input ends: an agent that ends with it has said all it had to say by then. Resolves when it ended or after `ms`.
  async finish(ms: number): Promise<void> {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>((r) => { t = setTimeout(r, ms); })]);
    clearTimeout(t);
  }

  close() {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    this.proc.kill();
  }
}
