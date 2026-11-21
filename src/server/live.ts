// The live feed on /ws. Every frame of the bus goes to every socket, except
// stored events and the streamed deltas of a reply: those wait for the
// client's first `resume`, which replays each named session's events after its
// cursor and the reply a running turn has streamed so far, then subscribes the
// socket to them. JavaScript runs the replay and the subscribe in one go, so
// no event can slip between them: no gap and no duplicate, also across a
// reconnect or a daemon restart (the cursor is the stored seq). `replayed`
// names where each session's replay ended: the cursor it was given or the
// last event sent, or less when this daemon holds less than the page.
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { ClientFrame, DraftBlocks, Frame, SocketFrame } from "../core/types.ts";
import { allPendingQuestions } from "../tools/interact.ts";

const LIVE = "live"; // events and deltas, after a resume
const ALL = "all"; // everything else, from the start

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
      this.publish(f.t === "event" || f.t === "delta" ? LIVE : ALL, JSON.stringify(f));
    });
  }

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
    if (m.op !== "resume") return;
    // A second resume (after the page lost track) replays again from its cursors.
    ws.unsubscribe(LIVE);
    const cursors: Record<string, number> = {};
    for (const [id, seq] of Object.entries(m.cursors ?? {})) {
      if (!this.store.session(id)) continue;
      const from = Number(seq) || 0;
      let last = from;
      for (const e of this.store.events(id, from)) {
        ws.send(JSON.stringify(this.bus.filter({ t: "event", event: e })));
        last = e.seq;
      }
      // Nothing after the cursor: the page is level, or ahead of what is
      // stored here (a restored backup). Then the replay ends at the last
      // stored seq, below the cursor, and the page reads the session whole.
      if (last === from && from > 0) last = Math.min(from, this.store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(id)?.n ?? 0);
      cursors[id] = last;
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
    }
    ws.subscribe(LIVE);
    send(ws, { t: "replayed", cursors });
  }
}

const send = (ws: Bun.ServerWebSocket<unknown>, f: SocketFrame) => void ws.send(JSON.stringify(f));
