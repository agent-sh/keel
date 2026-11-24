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

// What a connection is. Nothing in it is a callback of the transport or a session's name for the server, except for
// a server its owner marked `share: false`: its state is the session's own, so the session is part of what it is.
export function linkKey(t: Transport, own?: string): string {
  return t.kind === "stdio"
    ? canon({ kind: "stdio", command: t.command, args: t.args, env: t.env ?? {}, cwd: t.cwd ?? null, own: own ?? null })
    : canon({ kind: "http", url: t.url, headers: t.headers, sse: !!t.sse, own: own ?? null });
}

// The tool lists kept for the servers sessions own, oldest first, at most `cap` of them. Putting one in moves it to the
// end, and so does using it: the lists that go are the ones no session has started a server from for the longest.
export function placeKept<T>(kept: Record<string, T>, at: string, value: T, cap: number): void {
  delete kept[at];
  const old = Object.keys(kept).filter((n) => n.startsWith("~"));
  for (const n of old.slice(0, Math.max(0, old.length + 1 - cap))) delete kept[n];
  kept[at] = value;
}
// A list used: it moves to the end. Says whether the order changed (a list already last is not a change).
export function touchKept<T>(kept: Record<string, T>, at: string): boolean {
  if (!(at in kept)) return false;
  const last = Object.keys(kept).filter((n) => n.startsWith("~")).pop();
  if (last === at) return false;
  const v = kept[at]!;
  delete kept[at];
  kept[at] = v;
  return true;
}

type View = { hooks: Partial<Record<Handler, any>>; gone: () => void };
// Which session's calls are in flight on a connection, and the calls of another session waiting for them to end.
type Turns = { active: Map<string, number>; queue: { session: string; go: () => void }[] };
type Shared = {
  key: string;
  client?: McpClient;
  connecting?: Promise<McpClient>;
  ac: AbortController;
  // The callers waiting for the connect: when none is left it ends.
  waiting: number;
  views: Set<View>;
  closedWhy?: string;
  turns: Turns;
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
  // `own`: the session this connection is for alone (a server given `share: false`).
  async open(t: Transport, make: (signal: AbortSignal) => Promise<McpClient>, signal?: AbortSignal, own?: string): Promise<McpClient> {
    if (signal?.aborted) throw new Error("the server was dropped before it connected");
    const key = linkKey(t, own);
    let s = this.by.get(key);
    if (s?.client && (s.client.isClosed || s.client.expired)) { this.by.delete(key); s = undefined; }
    if (!s) {
      const mine: Shared = { key, ac: new AbortController(), waiting: 0, views: new Set(), turns: { active: new Map(), queue: [] } };
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
    // Ends the calls this holder made when its share is closed: they would go on in a process it no longer has a right to.
    const mine = new AbortController();
    const v: View = { hooks: {}, gone: () => { released = true; } };
    s.views.add(v);
    const release = (end: "close" | "retire") => {
      if (released) return;
      released = true;
      s.views.delete(v);
      if (end === "close") mine.abort(new Error("the server was dropped from this session"));
      if (s.views.size > 0) return;
      // The last holder: the connection ends with it (a call still running is let finish).
      if (this.by.get(s.key) === s) this.by.delete(s.key);
      if (end === "close") c.close(); else c.retire();
    };
    const gate = (session: string, signal: AbortSignal) => turn(s, c, session, AbortSignal.any([signal, mine.signal]));
    return new Proxy(c, {
      get(target, p) {
        if (isHandler(p)) return v.hooks[p];
        if (p === "close") return () => release("close");
        if (p === "retire") return () => release("retire");
        if (p === "isClosed") return released || target.isClosed;
        if (p === "gate") return gate;
        const x = Reflect.get(target, p, target);
        return typeof x === "function" ? (...a: unknown[]) => x.apply(target, a.map((y) => y instanceof AbortSignal ? AbortSignal.any([y, mine.signal]) : y)) : x;
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

// A call's place on a connection whose server has asked a question of its own. Such a request (stdio, or HTTP over
// one stream) names no call, so it is answered only when the calls in flight are one session's (src/mcp/client.ts
// serverRequest); the calls of another session wait for them. A server that never asked is not made to wait: its calls
// run together, as on any connection. Gives the call back when it ends.
function turn(s: Shared, c: McpClient, session: string, signal: AbortSignal): Promise<() => void> {
  const t = s.turns;
  const busy = (but: string) => [...t.active].some(([id, n]) => id !== but && n > 0);
  // The next in line goes, with the ones behind it for the same session.
  const pump = () => { while (t.queue.length && !busy(t.queue[0]!.session)) t.queue.shift()!.go(); };
  const take = () => {
    t.active.set(session, (t.active.get(session) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (t.active.get(session) ?? 1) - 1;
      if (n > 0) t.active.set(session, n); else t.active.delete(session);
      pump();
    };
  };
  if (signal.aborted) return Promise.reject(signal.reason);
  if (!c.hasAsked || (!busy(session) && !t.queue.length)) return Promise.resolve(take());
  return new Promise((resolve, reject) => {
    const w = { session, go: () => { signal.removeEventListener("abort", off); resolve(take()); } };
    const off = () => { t.queue.splice(t.queue.indexOf(w), 1); reject(signal.reason); pump(); };
    signal.addEventListener("abort", off, { once: true });
    t.queue.push(w);
  });
}

function each(s: Shared, h: Handler, arg?: unknown) {
  for (const v of [...s.views]) { try { v.hooks[h]?.(arg); } catch { /* a holder's failure is its own */ } }
}
