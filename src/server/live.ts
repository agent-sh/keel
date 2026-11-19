// The live feed on /ws. Every frame of the bus goes to every socket, except
// stored events and the streamed deltas of a reply: those wait for the
// client's first `resume`, which replays each named session's events after its
// cursor and the reply a running turn has streamed so far, then subscribes the
// socket to them. JavaScript runs the replay and the subscribe in one go, so
// no event can slip between them: no gap and no duplicate, also across a
// reconnect or a daemon restart (the cursor is the stored seq).
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { ClientFrame, DraftBlocks, Frame, SocketFrame } from "../core/types.ts";

const LIVE = "live"; // events and deltas, after a resume
const ALL = "all"; // everything else, from the start

export class Live {
  // The reply each running turn has streamed since its last stored step.
  private drafts = new Map<string, DraftBlocks>();
  private started = Date.now();

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

  open(ws: Bun.ServerWebSocket<unknown>) {
    ws.subscribe(ALL);
    send(ws, { t: "hello", pid: process.pid, started_ms: this.started });
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
      let last = Number(seq) || 0;
      for (const e of this.store.events(id, last)) {
        ws.send(JSON.stringify(this.bus.filter({ t: "event", event: e })));
        last = e.seq;
      }
      cursors[id] = last;
      const d = this.drafts.get(id);
      if (d) send(ws, { t: "draft", session_id: id, blocks: d });
    }
    ws.subscribe(LIVE);
    send(ws, { t: "replayed", cursors });
  }
}

const send = (ws: Bun.ServerWebSocket<unknown>, f: SocketFrame) => void ws.send(JSON.stringify(f));
