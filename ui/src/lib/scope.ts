// What this page asks its socket for. The daemon sends every socket what a
// list of sessions needs; a session's whole stream (its events, the reply as
// it streams, what its turn is doing) comes only for the sessions the page
// names (src/server/scope.ts). The page names a session while a view shows it
// (a pane, a look over one, an agent's session), and for a short time after
// the last view of it left, so going back to it costs nothing. After that
// time the daemon is told to stop, and what the page held of the session
// goes: opening it again reads it anew. A few frames that one view reads
// across sessions (the Activity list, a project's files, the daemon panel)
// are feeds, named while that view is up.
//
// The page's store binds this to its socket: `resume` builds what each new
// socket is told (store.ts sends it first on every open, so the page hears
// again what it showed before its catch-up is done), `loaded` names a session
// once its snapshot is in the page, with the newest seq the page holds of it:
// the daemon sends what came after and then goes on, so nothing falls between
// the snapshot and the stream.

// How long a session nobody shows is still heard.
export const LINGER_MS = 20_000;

export type ScopeMessage =
  | { op: "resume"; cursors: Record<string, number>; only: true; watch?: string[]; feeds?: string[] }
  | { op: "sub"; cursors?: Record<string, number>; watch?: string[]; feeds?: string[] }
  | { op: "unsub"; watch?: string[]; feeds?: string[] };
// Sends on the page's socket; false when it is not open.
type Send = (m: ScopeMessage) => boolean;
export type ScopeHooks = {
  // The newest seq the page holds of a session (undefined: it holds none of it).
  cursor: (id: string) => number | undefined;
  // What the page holds of a session goes.
  drop: (id: string) => void;
  // A session of another daemon: this daemon has no events of it to catch up from.
  far: (id: string) => boolean;
};
type Timers = { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void };

export class Scope {
  private shown = new Map<string, number>(); // views of each session
  private lingering = new Map<string, unknown>(); // sessions nobody shows, until their time is over
  private heard = new Set<string>(); // sessions the open socket was told to send
  private feeds = new Map<string, number>(); // views of each feed
  private send: Send = () => false;

  constructor(private hooks: ScopeHooks, private timers: Timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }) {}

  private wanted(id: string) { return this.shown.has(id) || this.lingering.has(id); }

  // A view shows the session. Returns what the view calls when it stops.
  show(id: string): () => void {
    this.timers.clear(this.lingering.get(id));
    this.lingering.delete(id);
    this.shown.set(id, (this.shown.get(id) ?? 0) + 1);
    // Another daemon's session is heard from now on, before its snapshot is asked for:
    // what happens there after the snapshot was read then comes by the stream.
    if (this.hooks.far(id) && !this.heard.has(id) && this.send({ op: "sub", watch: [id] })) this.heard.add(id);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.shown.get(id) ?? 1) - 1;
      if (n > 0) return void this.shown.set(id, n);
      this.shown.delete(id);
      this.linger(id);
    };
  }

  private linger(id: string) {
    this.timers.clear(this.lingering.get(id));
    this.lingering.set(id, this.timers.set(() => this.leave(id), LINGER_MS));
  }

  // The time after the last view is over: the daemon stops sending it and the page lets go of it.
  private leave(id: string) {
    this.lingering.delete(id);
    if (this.shown.has(id)) return;
    if (this.heard.delete(id)) this.send({ op: "unsub", watch: [id] });
    this.hooks.drop(id);
  }

  // The session's snapshot is in the page: its stream is asked for from where the snapshot ended.
  loaded(id: string) {
    // The view that asked for it left, and its time is over: nothing keeps it.
    if (!this.wanted(id)) return this.hooks.drop(id);
    if (this.heard.has(id) || this.hooks.far(id)) return;
    const cursor = this.hooks.cursor(id);
    if (cursor !== undefined && this.send({ op: "sub", cursors: { [id]: cursor } })) this.heard.add(id);
  }

  // A view reads a feed. Returns what it calls when it stops.
  feed(name: string): () => void {
    const n = this.feeds.get(name) ?? 0;
    this.feeds.set(name, n + 1);
    if (!n) this.send({ op: "sub", feeds: [name] });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.feeds.get(name) ?? 1) - 1;
      if (left > 0) return void this.feeds.set(name, left);
      this.feeds.delete(name);
      this.send({ op: "unsub", feeds: [name] });
    };
  }

  // What a new socket is told first: the sessions the page holds, each with its
  // cursor, the far ones it shows, and its feeds. `send` is that socket.
  resume(cursors: Record<string, number>, send: Send): ScopeMessage {
    this.send = send;
    this.heard = new Set(Object.keys(cursors));
    const watch = [...this.shown.keys(), ...this.lingering.keys()].filter((id) => this.hooks.far(id));
    for (const id of watch) this.heard.add(id);
    const feeds = [...this.feeds.keys()];
    // `only`: these sessions' streams and no other's (a daemon that does not know the word sends every session's).
    return { op: "resume", cursors, only: true, ...(watch.length ? { watch } : {}), ...(feeds.length ? { feeds } : {}) };
  }

  // Whether the open socket sends this session's stream now.
  hearing(id: string): boolean { return this.heard.has(id); }

  // What the open socket was told to send (for tests and the page's own checks).
  hears(): string[] { return [...this.heard].sort(); }
}
