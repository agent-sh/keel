// A language server as a child process: the protocol's start, the documents
// this client owns, and one question, "what are this document's diagnostics
// now". Nothing here waits on the server on the daemon's loop: output is
// parsed as it arrives, every answer is a promise the caller bounds, and a
// server that floods, stops answering or speaks something else is ended (the
// manager starts another, with a growing pause).
import { fileURLToPath, pathToFileURL } from "node:url";
import { chunks, pumpText } from "../core/proc.ts";
import { type Diag, fromLsp } from "./diff.ts";
import { encode, Framer, type RpcMessage } from "./rpc.ts";

export type ClientLimits = {
  initializeMs: number;   // no answer to `initialize` within this: the server is ended
  requestMs: number;      // a request not answered within this counts as a hang
  hangs: number;          // that many unanswered requests in a row: ended
  windowMs: number;       // the window the flood limits are counted over
  windowMessages: number; // more messages than this in a window: ended
  windowBytes: number;    // more bytes than this in a window: ended
  settleMs: number;       // pushed diagnostics: how long after the first push for a version the last one is taken
  busyMs: number;         // an answer given while the server says it is still loading is asked again once it is done, waited for this long at most
  openDocs: number;       // documents kept open; the oldest is closed past it
  stopMs: number;         // from `shutdown` to the kill
  backlogBytes: number;   // bytes written that the server has not taken: over this, it has stopped reading and is ended
};
// The flood limits are far above what a healthy server sends while it loads a
// large project (a few hundred log and progress lines a second at most).
export const LIMITS: ClientLimits = {
  initializeMs: 30_000, requestMs: 30_000, hangs: 3,
  windowMs: 10_000, windowMessages: 20_000, windowBytes: 64 * 1024 * 1024,
  settleMs: 150, busyMs: 60_000, openDocs: 64, stopMs: 1500, backlogBytes: 16 * 1024 * 1024,
};

export type ClientOpts = {
  name: string;
  argv: string[];                 // the command as it runs (already confined)
  cwd: string;
  env: Record<string, string>;
  root: string;                   // the workspace folder the server is told
  // The server runs in a process namespace of its own (the sandbox): it is
  // told no parent to watch. A server watches the process id it is given and
  // exits when that process is gone, and inside the sandbox the daemon's id
  // names nothing. (The sandbox ends the server with the daemon itself.)
  confined?: boolean;
  initialization?: unknown;       // initializationOptions
  settings?: unknown;             // answers workspace/configuration (by section) and didChangeConfiguration
  limits?: Partial<ClientLimits>;
  onEnd?: (why: string, started: boolean) => void;
  // Every push of diagnostics, as it arrives (a server may refine a version's diagnostics later).
  onPush?: (path: string, version: number | undefined, diags: Diag[]) => void;
};

// `mark`: the file's size and change time when its text was read, so a later look at the disk knows whether to read it again.
type Doc = { uri: string; version: number; text: string; used: number; mark: string };
type Pushed = { version?: number; diags: Diag[]; seq: number; at: number };
type Waiter = { uri: string; version: number; afterSeq: number; done: (d: Diag[] | null) => void; timer?: ReturnType<typeof setTimeout>; give?: ReturnType<typeof setTimeout>; last?: Diag[] };
// Background work a server can name at once; more than this is not tracked.
const PROGRESS_MAX = 256;

const uriOf = (path: string) => pathToFileURL(path).href;
const pathOf = (uri: string) => { try { return fileURLToPath(uri); } catch { return uri; } };
const SERVER_CANCELLED = -32802;

export class LspClient {
  readonly name: string;
  readonly root: string;
  readonly started = Date.now();
  readonly ready: Promise<void>;
  readyMs: number | null = null;
  pid = 0;
  ended: string | null = null;
  serverInfo: { name?: string; version?: string } = {};
  // What the server said it does: asked diagnostics (pull), a document's save.
  pull = false;
  private pullIds: (string | undefined)[] = [];
  private wantsSave = false;
  private watches = false;
  // Background work the server reported (progress tokens, a status that is not quiescent).
  private progress = new Set<string>();
  private quiescent = true;
  messages = 0;
  bytes = 0;
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private framer = new Framer();
  private nextId = 1;
  private waiting = new Map<number, { done: (m: RpcMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private docs = new Map<string, Doc>();
  private pushed = new Map<string, Pushed>();
  private seq = 0;
  private waiters = new Set<Waiter>();
  private lastPull = new Map<string, Diag[]>();
  private chain: Promise<void>;
  private limits: ClientLimits;
  private window = { start: Date.now(), messages: 0, bytes: 0 };
  private hung = 0;
  private stderr = "";
  private initialized = false;
  private stopWhy: string | null = null;
  // Whether the server's pushes name the version they are for (learned from its first push).
  private versioned = false;
  private backlog = 0;
  // A server that pushes: when the first question since its last push was asked.
  private silentSince: number | null = null;

  constructor(private o: ClientOpts) {
    this.name = o.name;
    this.root = o.root;
    this.limits = { ...LIMITS, ...o.limits };
    this.proc = Bun.spawn(o.argv, { cwd: o.cwd, env: o.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.pid = this.proc.pid;
    void this.read();
    void this.drain();
    void this.proc.exited.then((code) => this.end(this.stopWhy ?? `it exited${typeof code === "number" ? ` with code ${code}` : ""}${this.stderrTail() ? `: ${this.stderrTail().split("\n").filter(Boolean).at(-1)}` : ""}`));
    this.ready = this.initialize();
    this.ready.catch(() => {});
    this.chain = this.ready.then(() => {}, () => {});
  }

  get process(): { pid: number; kill(signal?: number | NodeJS.Signals): void; exited: Promise<unknown> } { return this.proc; }
  // The last of what the server wrote to its error output.
  stderrTail(): string { return this.stderr.trim(); }
  // Whether the server says it is still loading or checking.
  get busy(): boolean { return this.progress.size > 0 || !this.quiescent; }
  get openDocs(): number { return this.docs.size; }
  // What this client holds of the server's words, for a test of its bounds.
  get held(): { docs: number; pushed: number; pulled: number; waiters: number; progress: number } {
    return { docs: this.docs.size, pushed: this.pushed.size, pulled: this.lastPull.size, waiters: this.waiters.size, progress: this.progress.size };
  }
  // Told to stop, and on its way out.
  get stopping(): boolean { return this.stopWhy !== null; }

  private idlers = new Set<() => void>();
  private calm() {
    if (this.busy && !this.ended) return;
    for (const f of this.idlers) f();
    this.idlers.clear();
  }
  // Resolves when the server reports no background work, or after `busyMs`.
  private idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => {
      const t = setTimeout(() => { this.idlers.delete(done); r(); }, this.limits.busyMs);
      const done = () => { clearTimeout(t); r(); };
      this.idlers.add(done);
    });
  }

  private async read() {
    try {
      for await (const chunk of chunks(this.proc.stdout)) {
        if (this.ended) return;
        const now = Date.now();
        if (now - this.window.start > this.limits.windowMs) this.window = { start: now, messages: 0, bytes: 0 };
        this.window.bytes += chunk.length;
        this.bytes += chunk.length;
        const msgs = this.framer.push(chunk);
        this.window.messages += msgs.length;
        this.messages += msgs.length;
        if (this.window.messages > this.limits.windowMessages || this.window.bytes > this.limits.windowBytes)
          return this.end(`it flooded: ${this.window.messages} messages, ${this.window.bytes} bytes in ${Math.round((now - this.window.start) / 1000) || 1} s`);
        for (const m of msgs) this.handle(m);
      }
    } catch (e) {
      this.end(`it sent ${(e as Error).message}`);
    }
  }

  private async drain() {
    try {
      await pumpText(this.proc.stderr, (t) => { this.stderr = (this.stderr + t).slice(-4000); }, "language server stderr");
    } catch {}
  }

  private send(m: RpcMessage) {
    if (this.ended) return;
    try {
      const bytes = encode(m);
      // Bun's sink answers a write with the bytes it took, or, once what it
      // holds is not going out (the server is not reading its input), with a
      // promise that settles when the held bytes went. Every write made in
      // that state adds to what waits; a server that leaves too much unread
      // is ended, or the daemon would hold every later document for it.
      const wrote = this.proc.stdin.write(bytes) as number | Promise<number>;
      if (typeof wrote === "number") void Promise.resolve(this.proc.stdin.flush()).catch(() => {});
      else {
        this.backlog += bytes.length;
        void wrote.then(() => { this.backlog = 0; }, () => {});
        if (this.backlog > this.limits.backlogBytes) this.end(`it stopped reading its input (${this.backlog} bytes not taken)`);
      }
    } catch (e) {
      this.end(`its input closed: ${(e as Error).message}`);
    }
  }

  private notify(method: string, params?: unknown) { this.send({ method, ...(params !== undefined ? { params } : {}) }); }

  // A request and its answer. An answer that does not come within the limit
  // is an error answer; too many in a row end the server.
  private request(method: string, params?: unknown, ms = this.limits.requestMs): Promise<RpcMessage> {
    return new Promise((done) => {
      if (this.ended) return done({ error: { code: -1, message: `the server ended: ${this.ended}` } });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.notify("$/cancelRequest", { id });
        done({ error: { code: -2, message: `no answer to ${method} within ${ms} ms` } });
        if (++this.hung >= this.limits.hangs) this.end(`it stopped answering (${this.hung} requests in a row, the last ${method})`);
      }, ms);
      this.waiting.set(id, { done: (m) => { clearTimeout(timer); this.hung = 0; done(m); }, timer });
      this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  private async initialize(): Promise<void> {
    const folder = { uri: uriOf(this.root), name: this.root.split("/").pop() || this.root };
    const r = await this.request("initialize", {
      processId: this.o.confined ? null : process.pid,
      clientInfo: { name: "keel" },
      rootUri: folder.uri,
      rootPath: this.root,
      workspaceFolders: [folder],
      initializationOptions: this.o.initialization ?? {},
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { versionSupport: true, relatedInformation: false },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
        },
        workspace: { workspaceFolders: true, configuration: true, didChangeWatchedFiles: { dynamicRegistration: true }, diagnostics: { refreshSupport: false } },
        window: { workDoneProgress: true },
        experimental: { serverStatusNotification: true },
      },
    }, this.limits.initializeMs);
    if (r.error) {
      const why = `initialize failed: ${r.error.message}`;
      this.end(why);
      throw new Error(why);
    }
    const res = (r.result ?? {}) as { capabilities?: any; serverInfo?: { name?: string; version?: string } };
    const caps = res.capabilities ?? {};
    this.serverInfo = res.serverInfo ?? {};
    if (caps.diagnosticProvider) { this.pull = true; this.pullIds.push(typeof caps.diagnosticProvider.identifier === "string" ? caps.diagnosticProvider.identifier : undefined); }
    const sync = caps.textDocumentSync;
    this.wantsSave = !!(sync && typeof sync === "object" && sync.save);
    this.initialized = true;
    this.notify("initialized", {});
    if (this.o.settings !== undefined) this.notify("workspace/didChangeConfiguration", { settings: this.o.settings });
    this.readyMs = Date.now() - this.started;
  }

  private section(name: unknown): unknown {
    let v: any = this.o.settings;
    if (typeof name !== "string" || !name) return v ?? null;
    for (const part of name.split(".")) v = v && typeof v === "object" ? v[part] : undefined;
    return v ?? null;
  }

  private handle(m: RpcMessage) {
    // An answer to a request of ours.
    if (m.method === undefined) {
      if (typeof m.id === "number") { const w = this.waiting.get(m.id); this.waiting.delete(m.id); w?.done(m); }
      return;
    }
    const p = m.params as any;
    // A request of the server's: answered at once, with what a client that shows nothing can say.
    if (m.id !== undefined && m.id !== null) {
      let result: unknown = null;
      switch (m.method) {
        case "workspace/configuration": result = Array.isArray(p?.items) ? p.items.map((i: any) => this.section(i?.section)) : []; break;
        case "workspace/workspaceFolders": result = [{ uri: uriOf(this.root), name: this.root.split("/").pop() || this.root }]; break;
        case "workspace/applyEdit": result = { applied: false, failureReason: "this client applies no edits" }; break;
        case "client/registerCapability":
          for (const reg of Array.isArray(p?.registrations) ? p.registrations : []) {
            if (reg?.method === "textDocument/diagnostic") { this.pull = true; this.pullIds.push(typeof reg.registerOptions?.identifier === "string" ? reg.registerOptions.identifier : undefined); }
            else if (reg?.method === "workspace/didChangeWatchedFiles") this.watches = true;
            else if (reg?.method === "textDocument/didSave") this.wantsSave = true;
          }
          break;
        case "client/unregisterCapability": case "window/workDoneProgress/create": case "workspace/diagnostic/refresh": case "window/showMessageRequest":
        case "workspace/codeLens/refresh": case "workspace/semanticTokens/refresh": case "workspace/inlayHint/refresh": case "workspace/inlineValue/refresh":
          break;
        default:
          return this.send({ id: m.id, error: { code: -32601, message: `${m.method} is not supported` } });
      }
      return this.send({ id: m.id, result });
    }
    switch (m.method) {
      case "textDocument/publishDiagnostics": {
        // Only for a document this client has open: a server that publishes
        // for every file of a project (or for names it made up) fills nothing here.
        if (typeof p?.uri !== "string" || !this.docs.has(p.uri)) return;
        const doc = this.docs.get(p.uri)!;
        const version = typeof p.version === "number" ? p.version : undefined;
        const rec: Pushed = { version, diags: fromLsp(p.diagnostics, version === undefined || version === doc.version ? doc.text : undefined), seq: ++this.seq, at: Date.now() };
        if (rec.version !== undefined) this.versioned = true;
        this.silentSince = null;
        this.hung = 0;
        this.pushed.set(p.uri, rec);
        for (const w of [...this.waiters]) if (w.uri === p.uri) this.offer(w, rec);
        try { this.o.onPush?.(pathOf(p.uri), rec.version, rec.diags); } catch {}
        return;
      }
      case "$/progress": {
        const token = String(p?.token ?? "");
        if (p?.value?.kind === "begin") { if (this.progress.size < PROGRESS_MAX) this.progress.add(token.slice(0, 200)); }
        else if (p?.value?.kind === "end") { this.progress.delete(token.slice(0, 200)); this.calm(); }
        return;
      }
      case "experimental/serverStatus":
        if (typeof p?.quiescent === "boolean") { this.quiescent = p.quiescent; this.calm(); }
        return;
    }
  }

  // A push for a waiter's document: taken when it is for the version asked
  // (or, from a server that names no version, came after the change), and
  // then once more pushes for it have had a moment to follow.
  private offer(w: Waiter, rec: Pushed) {
    if (rec.version !== undefined && rec.version > w.version) {
      // The server has moved on to a later text: what it said for this one is all there will be.
      return this.settle(w, w.last ?? null);
    }
    if (rec.version !== undefined ? rec.version !== w.version : rec.seq <= w.afterSeq) return;
    w.last = rec.diags;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      // A server still loading or checking has more to say about this version.
      void this.idle().then(() => this.settle(w, this.ended ? null : w.last ?? null));
    }, this.limits.settleMs);
  }

  private settle(w: Waiter, d: Diag[] | null) {
    if (!this.waiters.delete(w)) return;
    clearTimeout(w.timer);
    // Its timer stays: it is what notices a server that answers no question at all.
    w.done(d);
  }

  // The document as it is on disk now becomes the document the server
  // analyses. Returns its version: the diagnostics asked for with it are for
  // this text. Sent in order with everything else, after the server is ready.
  sync(path: string, text: string, languageId: string, mark = ""): number {
    const uri = uriOf(path);
    const doc = this.docs.get(uri);
    if (doc && doc.text === text) { doc.used = Date.now(); doc.mark = mark; return doc.version; }
    const version = (doc?.version ?? 0) + 1;
    this.docs.set(uri, { uri, version, text, used: Date.now(), mark });
    const first = !doc;
    // A server whose pushes name no version cannot say which text a push is
    // for: who waits on the text before this one gets what was pushed so far.
    // One that names versions answers for each in order, so the wait stays.
    if (!this.versioned) for (const w of [...this.waiters]) if (w.uri === uri && w.version !== version) this.settle(w, w.last ?? null);
    this.post(() => {
      if (this.watches) this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type: first ? 1 : 2 }] });
      if (first) this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
      else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
      if (this.wantsSave) this.notify("textDocument/didSave", { textDocument: { uri } });
    });
    if (this.docs.size > this.limits.openDocs) {
      const oldest = [...this.docs.values()].sort((a, b) => a.used - b.used)[0]!;
      this.close(pathOf(oldest.uri));
    }
    return version;
  }

  // Files changed on disk outside this client's documents (a deleted file, a
  // command's output), for a server that asked to be told.
  changed(files: { path: string; type: "created" | "changed" | "deleted" }[]) {
    if (!files.length) return;
    this.post(() => {
      if (this.watches) this.notify("workspace/didChangeWatchedFiles", { changes: files.map((f) => ({ uri: uriOf(f.path), type: f.type === "created" ? 1 : f.type === "changed" ? 2 : 3 })) });
    });
  }

  close(path: string) {
    const uri = uriOf(path);
    if (!this.docs.delete(uri)) return;
    this.lastPull.delete(uri);
    this.pushed.delete(uri);
    for (const w of [...this.waiters]) if (w.uri === uri) this.settle(w, null);
    this.post(() => this.notify("textDocument/didClose", { textDocument: { uri } }));
  }

  has(path: string): boolean { return this.docs.has(uriOf(path)); }
  // The documents this client holds, each with the mark it was given.
  open(): { path: string; mark: string }[] { return [...this.docs.values()].map((d) => ({ path: pathOf(d.uri), mark: d.mark })); }
  versionOf(path: string): number | undefined { return this.docs.get(uriOf(path))?.version; }

  private post(f: () => void) {
    this.chain = this.chain.then(() => { if (!this.ended && this.initialized) f(); }).catch(() => {});
  }

  // The diagnostics of a document at a version `sync` returned. Null: the
  // document moved on to another version first, or the server ended. The
  // caller bounds the wait; an answer that comes later is still the answer.
  diagnostics(path: string, version: number): Promise<Diag[] | null> {
    const uri = uriOf(path);
    // The text asked about, for the words of each diagnostic's line.
    const now = this.docs.get(uri);
    const text = now?.version === version ? now.text : undefined;
    return new Promise((done) => {
      const afterSeq = this.seq;
      this.post(() => {
        // Sent in order with the document's changes: the question follows the
        // text it is about on the wire, also when the document has moved on in
        // this client since (an edit is often faster than a server's start).
        if (this.pull) return void this.pullOnce(uri, version, 0, text).then(async (d) => {
          // An answer given while the server was still loading the project may miss what it has not read yet.
          if (d === null || !this.busy || this.docs.get(uri)?.version !== version) return done(d);
          await this.idle();
          done(this.ended ? null : this.docs.get(uri)?.version !== version ? d : await this.pullOnce(uri, version, 0, text));
        });
        const w: Waiter = { uri, version, afterSeq, done };
        // A push that never comes is a server that stopped answering: one that
        // has pushed nothing since the first question still open, for as long
        // as a request may take, is ended (however many later questions took that one's place).
        this.silentSince ??= Date.now();
        w.give = setTimeout(() => {
          if (this.waiters.has(w)) this.settle(w, w.last ?? null);
          if (this.silentSince !== null && Date.now() - this.silentSince >= this.limits.requestMs) this.end(`it stopped answering (no diagnostics pushed in ${Math.round(this.limits.requestMs / 1000)} s of asking)`);
        }, this.limits.requestMs);
        (w.give as { unref?: () => void }).unref?.();
        this.waiters.add(w);
        const have = this.pushed.get(uri);
        if (have) this.offer(w, have);
      });
      // Not ready, or ended before the question was sent.
      void this.chain.then(() => { if (this.ended || !this.initialized) done(null); });
    });
  }

  private async pullOnce(uri: string, version: number, tries: number, text?: string): Promise<Diag[] | null> {
    const all: Diag[] = [];
    let unchanged = false;
    for (const identifier of this.pullIds.length ? [...new Set(this.pullIds)] : [undefined]) {
      // The server reads its messages in order: the answer is for the text
      // the document had when the question was sent, also when the document
      // has moved on since (an edit is often faster than the answer).
      const r = await this.request("textDocument/diagnostic", { textDocument: { uri }, ...(identifier ? { identifier } : {}) });
      if (r.error) {
        // The server cannot say right now and asks to be asked again: only for the text asked about.
        const again = r.error.code === SERVER_CANCELLED && (r.error.data as any)?.retriggerRequest !== false;
        if (again && tries < 20 && !this.ended && this.docs.get(uri)?.version === version) { await Bun.sleep(100 + tries * 50); return this.pullOnce(uri, version, tries + 1, text); }
        return null;
      }
      const res = r.result as any;
      if (res?.kind === "unchanged") unchanged = true;
      else all.push(...fromLsp(res?.items, text));
    }
    if (unchanged && !all.length) return this.lastPull.get(uri) ?? [];
    this.lastPull.set(uri, all);
    return all;
  }

  private end(why: string) {
    if (this.ended) return;
    this.ended = why;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.done({ error: { code: -1, message: `the server ended: ${why}` } }); }
    this.waiting.clear();
    for (const w of this.waiters) { clearTimeout(w.timer); w.done(null); }
    this.waiters.clear();
    this.calm();
    // Nothing of an ended server is kept: its documents, what it pushed, what was half read.
    this.docs.clear();
    this.pushed.clear();
    this.lastPull.clear();
    this.progress.clear();
    this.framer = new Framer();
    this.stderr = this.stderr.slice(-1000);
    try { this.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} }, this.limits.stopMs).unref?.();
    this.o.onEnd?.(why, this.initialized);
  }

  // The protocol's way out, then the signal for a server that does not take it.
  async stop(why = "stopped"): Promise<void> {
    if (this.ended) return;
    this.stopWhy = why;
    if (this.initialized) {
      const bye = this.request("shutdown", undefined, this.limits.stopMs);
      await Promise.race([bye, Bun.sleep(this.limits.stopMs)]);
      this.notify("exit");
      await Promise.race([this.proc.exited, Bun.sleep(300)]);
    }
    this.end(why);
  }
}

// A file as the server should see it, or null when it is gone, not text or too large to send.
export const SYNC_MAX = 2 * 1024 * 1024;
export async function readDoc(path: string): Promise<string | null> {
  try {
    const f = Bun.file(path);
    if (f.size > SYNC_MAX) return null;
    const b = await f.bytes();
    if (b.length > SYNC_MAX || b.includes(0)) return null;
    return new TextDecoder().decode(b);
  } catch {
    return null;
  }
}
