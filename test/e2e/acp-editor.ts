import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// An editor's end of ACP: `keel acp` on stdio, JSON-RPC one message a line.
// `onRequest` answers a request of the agent's; one it returns undefined for
// stays open (`requests` keeps every one) until `answer` gives its result.
export class Editor {
  private proc: ChildProcess;
  private buf = "";
  private id = 100;
  private waiting = new Map<number, (m: any) => void>();
  updates: any[] = [];
  requests: any[] = [];
  notices: any[] = []; // the agent's notifications other than session/update ($/cancel_request)
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
        else if (m.method && m.id !== undefined) {
          this.requests.push(m);
          const result = this.onRequest(m);
          if (result !== undefined) this.answer(m.id, result);
        } else if (m.method) this.notices.push(m);
        else if (m.id !== undefined) this.waiting.get(m.id)?.(m);
      }
    });
  }
  private write(m: unknown) { this.proc.stdin!.write(JSON.stringify(m) + "\n"); }
  answer(id: number, result: unknown) { this.write({ jsonrpc: "2.0", id, result }); }
  call(method: string, params: unknown): Promise<any> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : resolve(m.result)));
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
  kinds(sessionId: string) { return this.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update.sessionUpdate); }
  close() { this.proc.stdin!.end(); }
  // Gone without a word, as a crashed editor is.
  kill() { this.proc.kill("SIGKILL"); }
}
