// Which sockets hear which frames. A socket hears, from its start, what a list
// of sessions needs (topic ALL): a session's row and state when they change,
// what waits on the owner, alerts, errors, the modules' own frames. A session's
// whole stream (its stored events, the reply as it streams, what its turn is
// doing, its checkpoints) goes to the sockets that named the session: a page
// names the sessions it shows, a command line client the one it follows. A
// few frames only one view reads are feeds a page names while that view is up.
// Bun's publish writes to a topic's subscribers natively, and a topic nobody
// subscribed to costs a lookup (https://bun.com/docs/runtime/http/websockets).
import type { Frame, Session } from "../core/types.ts";

export const ALL = "all"; // every socket, from its start
export const EVERY = "live"; // every scoped frame, for a client that asked for all of them
export const sessionTopic = (id: string) => `s:${id}`;
// Frames one view reads, across sessions: the Activity list, a project's files, the daemon panel.
export const FEEDS = ["activity", "artifacts", "awake"] as const;
export const feedTopic = (name: string) => `f:${name}`;
export const isScoped = (topic: string) => topic === EVERY || topic.startsWith("s:") || topic.startsWith("f:");
// A session of another daemon, as this daemon's pages name it (ui/src/lib/fleet-ids.ts).
export const farId = (machine: string, id: string) => `${machine}--${id}`;
const NAME = /^[\w-]{1,200}$/;
export const named = (list: unknown, max = 512): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && NAME.test(x)).slice(0, max) : []);

// Where a frame goes. `row`: a session's row, which the gate below decides for
// ALL; `queue`: a queue, sent to ALL when it is not the one sent last.
export type Route = { topics: string[]; row?: { key: string; session: Session; gone: boolean }; queue?: { key: string; body: string } };
export function route(f: Frame): Route {
  const one = (id: string): Route => ({ topics: [sessionTopic(id), EVERY] });
  const row = (key: string, session: Session, deleted?: boolean): Route => ({ topics: [sessionTopic(key), EVERY], row: { key, session, gone: !!deleted || !!session.archived } });
  const queue = (key: string, q: Extract<Frame, { t: "queue" }>): Route => ({ topics: [], queue: { key, body: JSON.stringify([q.queue, q.held]) } });
  switch (f.t) {
    case "event": return one(f.event.session_id);
    case "delta": case "status": return one(f.session_id);
    case "session": return row(f.session.id, f.session, f.deleted);
    case "queue": return queue(f.session_id, f);
    case "feature": {
      if (f.name === "fleet_frame") {
        // Another daemon's frame, relayed: scoped as that daemon's own would be, under the id its sessions have here.
        const { machine, frame: g } = (f.data ?? {}) as { machine?: string; frame?: Frame };
        if (!machine || !g) return { topics: [ALL] };
        if (g.t === "event") return one(farId(machine, g.event.session_id));
        if (g.t === "delta" || g.t === "status") return one(farId(machine, g.session_id));
        if (g.t === "session" && g.session) return row(farId(machine, g.session.id), g.session, g.deleted);
        if (g.t === "queue") return queue(farId(machine, g.session_id), g);
        return { topics: [ALL] };
      }
      if (f.name === "automation" && f.data?.kind === "activity") {
        const sid = f.data.data?.session_id;
        return { topics: [feedTopic("activity"), EVERY, ...(typeof sid === "string" ? [sessionTopic(sid)] : [])] };
      }
      if (f.name === "checkpoints" && f.session_id) return one(f.session_id);
      if (f.name === "artifacts") return { topics: [feedTopic("artifacts"), EVERY, ...(f.session_id ? [sessionTopic(f.session_id)] : [])] };
      if (f.name === "awake") return { topics: [feedTopic("awake"), EVERY] };
      return { topics: [ALL] };
    }
    default: return { topics: [ALL] };
  }
}

// A session's row as a list reads it. A change of what a list shows of a
// session (its title, its marks, its folder, its model) is told at once. A
// change of only when it was last active, or of its phase, is told at once
// when the session's last telling is older than LAZY_MS and with the newest
// row at the end of that time otherwise: a session whose state the list shows
// is told by its state frame, which is never held. What only an open view
// reads (the tokens it used, the event it stands on) is not told to a list.
export const LAZY_MS = 4_000;
export type RowPrint = { shown: string; phase: string; updated: number };
export const rowPrint = (s: Session): RowPrint => ({ shown: String(Bun.hash(JSON.stringify({ ...s, usage: 0, head: 0, rev: 0, updated: 0, phase: 0 }))), phase: s.phase, updated: s.updated });
export function rowChange(was: RowPrint | undefined, now: RowPrint): "shown" | "lazy" | "none" {
  if (!was || was.shown !== now.shown) return "shown";
  return was.phase !== now.phase || was.updated !== now.updated ? "lazy" : "none";
}

// Decides when a row goes to ALL. `send` publishes a frame's text there.
type Kept = { told: RowPrint; at: number; late?: { print: RowPrint; data: string }; timer?: ReturnType<typeof setTimeout> };
export class RowGate {
  private kept = new Map<string, Kept>();
  constructor(private send: (data: string) => void, private now: () => number = Date.now) {}

  offer(key: string, session: Session, gone: boolean, data: string) {
    const k = this.kept.get(key);
    if (gone) {
      clearTimeout(k?.timer);
      this.kept.delete(key);
      return this.send(data);
    }
    const print = rowPrint(session);
    const change = rowChange(k?.late?.print ?? k?.told, print);
    if (change === "none") return;
    const at = this.now();
    if (!k || change === "shown" || at - k.at >= LAZY_MS) {
      clearTimeout(k?.timer);
      this.kept.set(key, { told: print, at });
      return this.send(data);
    }
    // Inside the time: the newest row waits for its end.
    k.late = { print, data };
    k.timer ??= setTimeout(() => this.flush(key), k.at + LAZY_MS - at);
    k.timer.unref?.();
  }

  // The row that waited is told (a test calls this instead of waiting).
  flush(key: string) {
    const k = this.kept.get(key);
    if (!k?.late) return;
    clearTimeout(k.timer);
    const { print, data } = k.late;
    this.kept.set(key, { told: print, at: this.now() });
    this.send(data);
  }
}
