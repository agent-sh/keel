// The live feed on /ws. A socket hears from its start what a list of sessions
// needs; a session's stored events and the streamed deltas of its reply go to
// the sockets that named it (src/server/scope.ts says which frame goes where).
// A client's `resume` names sessions with the newest seq it holds of each: the
// daemon replays each one's events after that cursor and the reply a running
// turn has streamed so far, then subscribes the socket to it (and, unless the
// client said `only`, to every other session's stream, as before). JavaScript runs
// the replay and the subscribe in one go, so no event can slip between them:
// no gap and no duplicate, also across a reconnect or a daemon restart (the
// cursor is the stored seq). `replayed` names where each session's replay
// ended: the cursor it was given or the last event sent, or less when this
// daemon holds less than the page. A `sub` adds sessions the same way (a page
// that opens one), an `unsub` takes them away (a page that left one).
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { ClientFrame, DraftBlocks, Frame, SocketFrame } from "../core/types.ts";
import { allPendingQuestions } from "../tools/interact.ts";
import { ALL, EVERY, FEEDS, feedTopic, isScoped, named, route, RowGate, sessionTopic } from "./scope.ts";

export class Live {
  // The reply each running turn has streamed since its last stored step.
  private drafts = new Map<string, DraftBlocks>();
  private started = Date.now();
  // A session's queue and turn status now (the app sets it once the engine exists).
  state?: (id: string) => { queue: any[]; held: boolean; status: any };
  // The page version served now (a page that loaded another reloads).
  ui?: () => string;

  constructor(private store: Store, private bus: Bus, private publish: (topic: string, data: string) => void) {
    bus.on((f) => {
      this.track(f);
      const to = route(f);
      const data = JSON.stringify(f);
      for (const topic of to.topics) this.publish(topic, data);
      if (to.row) this.rows.offer(to.row.key, to.row.session, to.row.gone, data);
      if (to.row?.gone) this.queues.delete(to.row.key);
      // A queue is told when it is not the one told last (a turn's start tells an empty queue again).
      if (to.queue && this.queues.get(to.queue.key) !== to.queue.body) {
        this.queues.set(to.queue.key, to.queue.body);
        this.publish(ALL, data);
      }
    });
  }

  // What the lists were last told of each session's row and queue.
  private rows = new RowGate((data) => this.publish(ALL, data));
  private queues = new Map<string, string>();

  private track(f: Frame) {
    if (f.t === "delta") {
      const d = this.drafts.get(f.session_id) ?? {};
      const b = d[f.index] ?? { kind: f.kind, text: "", name: f.name };
      d[f.index] = { ...b, text: b.text + f.text, name: b.name ?? f.name };
      this.drafts.set(f.session_id, d);
    } else if (f.t === "event" && (f.event.kind === "assistant" || f.event.kind === "turn_end")) {
      this.drafts.delete(f.event.session_id);
    } else if (f.t === "status" && f.status.kind === "retry") {
      this.drafts.delete(f.session_id); // a retried attempt streams its reply again
    }
  }

  // What a running turn has streamed so far, for a session snapshot.
  draft(id: string): DraftBlocks {
    return this.drafts.get(id) ?? {};
  }

  open(ws: Bun.ServerWebSocket<unknown>) {
    ws.subscribe(ALL);
    send(ws, { t: "hello", pid: process.pid, started_ms: this.started, ui: this.ui?.(), sessions_level: this.bus.sessionsLevel() });
    ws.send(JSON.stringify({ t: "questions", pending: allPendingQuestions(), rev: this.bus.rev() } satisfies Frame));
  }

  message(ws: Bun.ServerWebSocket<unknown>, raw: string | Buffer) {
    let m: ClientFrame;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.op === "ping") return void send(ws, { t: "pong", nonce: m.nonce });
    if (m.op === "unsub") {
      for (const id of named(m.watch)) ws.unsubscribe(sessionTopic(id));
      for (const name of named(m.feeds)) ws.unsubscribe(feedTopic(name));
      return;
    }
    if (m.op !== "resume" && m.op !== "sub") return;
    // A resume says everything the socket hears from now on (a second one, after
    // the page lost track, replays again from its cursors); a sub adds to it.
    if (m.op === "resume") for (const topic of [...(ws.subscriptions ?? [])]) if (isScoped(topic)) ws.unsubscribe(topic);
    const cursors: Record<string, number> = {};
    for (const [id, seq] of Object.entries(m.cursors ?? {})) {
      if (!this.store.session(id)) continue;
      cursors[id] = this.replay(ws, id, Number(seq) || 0);
      ws.subscribe(sessionTopic(id));
    }
    for (const id of named(m.watch)) ws.subscribe(sessionTopic(id));
    for (const name of named(m.feeds)) if ((FEEDS as readonly string[]).includes(name)) ws.subscribe(feedTopic(name));
    // A client that does not say it wants only these hears every session's stream, as before.
    if (m.op === "resume" && !m.only) ws.subscribe(EVERY);
    if (m.op === "resume") send(ws, { t: "replayed", cursors });
  }

  // A session's events after `from`, then the session as it is now. Returns where the replay ended.
  private replay(ws: Bun.ServerWebSocket<unknown>, id: string, from: number): number {
    let last = from;
    for (const e of this.store.events(id, from)) {
      ws.send(JSON.stringify(this.bus.filter({ t: "event", event: e })));
      last = e.seq;
    }
    // Nothing after the cursor: the page is level, or ahead of what is
    // stored here (a restored backup). Then the replay ends at the last
    // stored seq, below the cursor, and the page reads the session whole.
    if (last === from && from > 0) last = Math.min(from, this.store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(id)?.n ?? 0);
    // The session as it is now, after its events: a replayed event carries
    // no rev and moves no head (it may be of another branch than the one
    // shown), so the row says where the head is.
    const row = this.store.session(id);
    if (row) ws.send(JSON.stringify({ ...this.bus.filter({ t: "session", session: row }), rev: this.bus.rev() }));
    const d = this.drafts.get(id);
    if (d) send(ws, { t: "draft", session_id: id, blocks: d, rev: this.bus.rev() });
    // Queue and status as they are now, so a page whose snapshot came just
    // before the socket needs no second snapshot.
    const st = this.state?.(id);
    if (st) {
      const rev = this.bus.rev();
      ws.send(JSON.stringify({ t: "queue", session_id: id, queue: st.queue, held: st.held, rev }));
      ws.send(JSON.stringify({ t: "status", session_id: id, status: st.status, rev }));
    }
    return last;
  }
}

const send = (ws: Bun.ServerWebSocket<unknown>, f: SocketFrame) => void ws.send(JSON.stringify(f));
