// One connection for every session that was given the same server. A session's own server (a project's
// .mcp.json, an editor's list, an agent file's) is the session's alone as far as what it may see and call goes;
// what runs is one process, or one HTTP session, for every session whose spec is the same: command, arguments,
// environment, folder and sandbox (the argv that confines it), or address and headers. Each holder gets a view
// of the connection: it hears the connection's events as its own and ends only its own share; the connection
// ends with its last view.
import { canon } from "./config.ts";
import type { McpClient, Transport } from "./client.ts";

// The handlers a holder sets on its client: each view keeps its own, and the connection calls every holder's.
const HANDLERS = ["onListChanged", "onPrompts", "onLog", "onResources", "onChannel", "onClose", "onAnswerRefused"] as const;
type Handler = (typeof HANDLERS)[number];
const isHandler = (p: string | symbol): p is Handler => (HANDLERS as readonly (string | symbol)[]).includes(p);

// What a connection is. Nothing in it is a callback of the transport or a session's name for the server.
export function linkKey(t: Transport): string {
  return t.kind === "stdio"
    ? canon({ kind: "stdio", command: t.command, args: t.args, env: t.env ?? {}, cwd: t.cwd ?? null })
    : canon({ kind: "http", url: t.url, headers: t.headers, sse: !!t.sse });
}

type View = { hooks: Partial<Record<Handler, any>>; gone: () => void };
type Shared = {
  key: string;
  client?: McpClient;
  connecting?: Promise<McpClient>;
  ac: AbortController;
  // The callers waiting for the connect: when none is left it ends.
  waiting: number;
  views: Set<View>;
  closedWhy?: string;
};

export class Links {
  private by = new Map<string, Shared>();

  // The connections up (one process each, for a command) and how many holders each has.
  stats(): { connections: number; holders: number[] } {
    const live = [...this.by.values()].filter((s) => s.client && !s.client.isClosed);
    return { connections: live.length, holders: live.map((s) => s.views.size) };
  }

  // A view of the connection `t` names: the one that is up, the one being made, or one `make` makes now.
  // `signal` ends this caller's wait; the connect itself ends when no caller wants it.
  async open(t: Transport, make: (signal: AbortSignal) => Promise<McpClient>, signal?: AbortSignal): Promise<McpClient> {
    if (signal?.aborted) throw new Error("the server was dropped before it connected");
    const key = linkKey(t);
    let s = this.by.get(key);
    if (s?.client && (s.client.isClosed || s.client.expired)) { this.by.delete(key); s = undefined; }
    if (!s) {
      const mine: Shared = { key, ac: new AbortController(), waiting: 0, views: new Set() };
      s = mine;
      this.by.set(key, mine);
      mine.connecting = make(mine.ac.signal).then((c) => {
        mine.client = c;
        c.onListChanged = () => each(mine, "onListChanged");
        c.onPrompts = () => each(mine, "onPrompts");
        c.onLog = (p) => each(mine, "onLog", p);
        c.onResources = (x) => each(mine, "onResources", x);
        c.onChannel = (p) => each(mine, "onChannel", p);
        c.onAnswerRefused = (r) => [...mine.views][0]?.hooks.onAnswerRefused?.(r); // told once, not once a holder
        c.onClose = (why) => {
          mine.closedWhy = why;
          if (this.by.get(key) === mine) this.by.delete(key);
          const views = [...mine.views];
          mine.views.clear();
          for (const v of views) { const f = v.hooks.onClose; v.gone(); try { f?.(why); } catch { /* a holder's failure is its own */ } }
        };
        return c;
      }, (err) => {
        if (this.by.get(key) === mine) this.by.delete(key);
        throw err;
      });
      mine.connecting.catch(() => {});
    }
    const sh = s;
    sh.waiting++;
    let counted = true;
    const leave = () => { if (counted) { counted = false; sh.waiting--; } };
    const c = await new Promise<McpClient>((resolve, reject) => {
      const off = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        off();
        leave();
        // Nobody wants it any more: its process is not left to the handshake's own limit.
        if (sh.waiting === 0 && !sh.client) { sh.ac.abort(); if (this.by.get(key) === sh) this.by.delete(key); }
        reject(new Error("the server was dropped before it connected"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      sh.connecting!.then((x) => { off(); leave(); resolve(x); }, (e) => { off(); leave(); reject(e); });
    });
    if (c.isClosed) throw new Error(sh.closedWhy ?? "the connection is closed");
    return this.view(sh, c);
  }

  private view(s: Shared, c: McpClient): McpClient {
    let released = false;
    const v: View = { hooks: {}, gone: () => { released = true; } };
    s.views.add(v);
    const release = (end: "close" | "retire") => {
      if (released) return;
      released = true;
      s.views.delete(v);
      if (s.views.size > 0) return;
      // The last holder: the connection ends with it (a call still running is let finish).
      if (this.by.get(s.key) === s) this.by.delete(s.key);
      if (end === "close") c.close(); else c.retire();
    };
    return new Proxy(c, {
      get(target, p) {
        if (isHandler(p)) return v.hooks[p];
        if (p === "close") return () => release("close");
        if (p === "retire") return () => release("retire");
        if (p === "isClosed") return released || target.isClosed;
        const x = Reflect.get(target, p, target);
        return typeof x === "function" ? x.bind(target) : x;
      },
      set(target, p, value) {
        if (!isHandler(p)) return Reflect.set(target, p, value, target);
        v.hooks[p] = value;
        // Set late, it still hears a close that already happened.
        if (p === "onClose" && value && s.closedWhy !== undefined) value(s.closedWhy);
        return true;
      },
    });
  }
}

function each(s: Shared, h: Handler, arg?: unknown) {
  for (const v of [...s.views]) { try { v.hooks[h]?.(arg); } catch { /* a holder's failure is its own */ } }
}
