// The one true state of a message between sessions, kept in the store as it
// changes: queued (it waits in the receiver's queue), delivered (the receiver
// read it: it is in its history), handled (the turn that read it ended and
// the receiver is idle again), dropped (it left the queue unread, or the
// owner dropped it), and the two that are not the receiver's doing: held (it
// waits for the owner) and outbound (it waits for another daemon to fetch
// it). The delivery itself is the engine's and the queue's (turn.ts,
// messages.ts); this file only follows it: a prompt stored with a message's
// id is the message read, the end of that turn is the message handled, and a
// row that left a queue without becoming a prompt is the message dropped.
// Also the list a session shows: what it sent and what it received, each
// with that state.
import type { Database } from "bun:sqlite";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { QueueItem } from "../core/types.ts";

export type PeerState = "queued" | "delivered" | "handled" | "dropped" | "held" | "outbound";
// The words for a state, in one place (the page and the text use these).
export const PEER_STATE_WORDS: Record<PeerState, string> = {
  queued: "queued", delivered: "delivered", handled: "handled", dropped: "dropped", held: "held for the owner", outbound: "waiting for its daemon",
};
// One message as a session lists it: `direction` from that session's side, `other` the session at the other end.
export type PeerMessageRow = {
  id: string; direction: "sent" | "received"; other: { session_id: string; title?: string; machine?: string; daemon_id?: string };
  text: string; cut: boolean; created_ms: number; state: PeerState; state_ms: number | null; reason?: string;
};

const TEXT = 280;
const END_WORDS: Record<string, string> = { error: "the turn that read it failed", interrupted: "the turn that read it was stopped", max_tokens: "the turn that read it was cut off at the output limit", refusal: "the model declined the turn that read it" };
const DROP_WORDS: Record<string, string> = { deleted: "its session was deleted before it was read", archived: "its session was archived before it was read", removed: "the owner removed it from that session's queue" };
// How long after a row leaves a queue it is looked for in the history before it is called dropped.
const DROP_CHECK_MS = 1500;

export function migrateMessageState(store: Store) {
  if (!store.columnExists("fleet_messages", "state_ms")) store.migrate("ALTER TABLE fleet_messages ADD COLUMN state_ms INTEGER");
  // What a session sent is found by the sender's session.
  store.migrate("CREATE INDEX IF NOT EXISTS fleet_messages_from ON fleet_messages(json_extract(sender, '$.session_id'), created_ms DESC)");
}

const columns = new WeakMap<Database, Set<string>>();
const columnOf = (db: Database, name: string) => {
  let have = columns.get(db);
  if (!have?.has(name)) columns.set(db, (have = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('fleet_messages')").all().map((c) => c.name))));
  return have.has(name);
};

// What a session sent and received, newest first.
export function peerMessages(db: Database, sessionId: string, limit = 50): PeerMessageRow[] {
  type Row = { id: string; created_ms: number; state: PeerState; state_ms: number | null; to_session: string; to_daemon: string | null; to_title: string | null; text: string; sender: string; reason: string | null; title: string | null; sent_to: string | null };
  // (A store from before a session's copy of a message to another machine was kept has no such column.)
  const sentTo = columnOf(db, "sent_to") ? "m.sent_to" : "NULL";
  const rows = db.query<Row, [string, string, number]>(
    `SELECT m.id, m.created_ms, m.state, m.state_ms, m.to_session, m.to_daemon, m.to_title, substr(m.text, 1, ${TEXT + 1}) AS text, m.sender, m.reason, s.title, ${sentTo} AS sent_to
     FROM fleet_messages m LEFT JOIN sessions s ON s.id = m.to_session
     WHERE m.to_session = ?1 OR json_extract(m.sender, '$.session_id') = ?2 ORDER BY m.created_ms DESC, m.id DESC LIMIT ?3`).all(sessionId, sessionId, Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => {
    const from = JSON.parse(r.sender) as { session_id: string; title?: string; machine?: string; daemon_id?: string };
    // A message to a session of another daemon is this session's own send, whatever that session's id is here.
    const sent = from.session_id === sessionId && !(r.to_session === sessionId && !r.to_daemon);
    return {
      id: r.id, direction: sent ? "sent" as const : "received" as const,
      other: sent ? { session_id: r.to_session, title: (r.sent_to ? r.to_title : r.title ?? r.to_title) ?? undefined, ...(r.sent_to ? { machine: r.sent_to } : {}), ...(r.to_daemon ? { daemon_id: r.to_daemon } : {}) } : { session_id: from.session_id, title: from.title, machine: from.machine, daemon_id: from.daemon_id },
      text: r.text.slice(0, TEXT), cut: r.text.length > TEXT, created_ms: r.created_ms, state: r.state, state_ms: r.state_ms, ...(r.reason ? { reason: r.reason } : {}),
    };
  });
}

// The rows as text, a line each: for a terminal or a model's timeline.
export function peerMessageLines(rows: PeerMessageRow[], fmt: (ts: number) => string): string[] {
  return rows.map((r) => {
    const who = `${r.other.title ? `"${r.other.title.replace(/\s+/g, " ").slice(0, 48)}"` : r.other.session_id.slice(-12)}${r.direction === "sent" && r.other.machine ? ` on ${r.other.machine}` : ""}`;
    const state = `${PEER_STATE_WORDS[r.state] ?? r.state}${r.state_ms && r.state !== "queued" ? ` at ${fmt(r.state_ms)}` : ""}${r.reason ? ` (${r.reason})` : ""}`;
    return `${fmt(r.created_ms)}  ${r.direction === "sent" ? "sent to" : "received from"} ${who}: ${state}. ${r.text.replace(/\s+/g, " ").slice(0, 120)}${r.cut || r.text.length > 120 ? "…" : ""}`;
  });
}

type Deps = {
  store: Store; bus: Bus;
  isRunning: (sessionId: string) => boolean;
  // A read off the loop (the read thread), for the checks that look through a session's history.
  read: <T>(sql: string, args: (string | number)[]) => Promise<T[]>;
  capture: (e: unknown, ctx: unknown) => void;
  dropCheckMs?: number;
};

export class MessageStates {
  // The messages read in a session's turn that has not ended yet, by session.
  private read = new Map<string, Set<string>>();
  private off: () => void;

  constructor(private d: Deps) {
    migrateMessageState(d.store);
    this.off = d.bus.on((f) => {
      try {
        if (f.t === "event") {
          const e = f.event;
          if (e.kind === "user" && typeof e.data?.message_id === "string") this.seen(e.session_id, e.data.message_id);
          else if (e.kind === "turn_end" && e.data?.reason !== "restart") this.ended(e.session_id, String(e.data?.reason ?? ""));
        } else if (f.t === "queue") this.queueChanged(f.session_id, f.queue);
      } catch (e) {
        d.capture(e, { at: "message state" });
      }
    });
    // What a restart left open: settled from the store, off the loop.
    void this.reconcile().catch((e) => d.capture(e, { at: "message state at start" }));
  }

  // The checks still owed (a row left a queue a moment ago): a stop takes them with it.
  private owed = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  stop() {
    this.stopped = true;
    this.off();
    for (const t of this.owed) clearTimeout(t);
    this.owed.clear();
  }

  private set(id: string, state: PeerState, from: PeerState[], reason?: string): boolean {
    const r = this.d.store.db
      .query(`UPDATE fleet_messages SET state = ?1, state_ms = ?2, reason = COALESCE(?3, reason) WHERE id = ?4 AND state IN (${from.map(() => "?").join(",")})`)
      .run(state, Date.now(), reason ?? null, id, ...from);
    if (!r.changes) return false;
    const to = this.d.store.db.query<{ to_session: string }, [string]>("SELECT to_session FROM fleet_messages WHERE id = ?").get(id)?.to_session;
    this.d.bus.emit({ t: "feature", name: "fleet_message", session_id: to, data: { id, state } });
    return true;
  }

  // The receiver read it: the prompt that carries the message is in its history.
  private seen(sessionId: string, id: string) {
    (this.read.get(sessionId) ?? this.read.set(sessionId, new Set()).get(sessionId)!).add(id);
    // (A message that started the turn at once has no row yet: it is written as delivered, and settled when the turn ends.)
    this.set(id, "delivered", ["queued"]);
  }

  // The turn that read them ended: the receiver is idle again.
  private ended(sessionId: string, reason: string) {
    const ids = this.read.get(sessionId);
    if (!ids) return;
    this.read.delete(sessionId);
    for (const id of ids) this.set(id, "handled", ["queued", "delivered"], END_WORDS[reason]);
  }

  // A queued message whose row is no longer in its session's queue was read
  // (its prompt is stored in the same write) or left unread. Looked at a
  // moment later, so the prompt's own event is seen first.
  private queueChanged(sessionId: string, queue: QueueItem[]) {
    const waiting = this.d.store.db.query<{ id: string }, [string]>("SELECT id FROM fleet_messages WHERE to_session = ? AND state = 'queued' AND to_daemon IS NULL").all(sessionId);
    if (!waiting.length) return;
    const inQueue = new Set(queue.map((q) => q.meta?.message_id).filter((x): x is string => typeof x === "string"));
    const gone = waiting.map((w) => w.id).filter((id) => !inQueue.has(id));
    if (!gone.length) return;
    const t = setTimeout(() => {
      this.owed.delete(t);
      void this.settle(sessionId, gone, "it left that session's queue before it was read").catch((e) => this.d.capture(e, { at: "message state" }));
    }, this.d.dropCheckMs ?? DROP_CHECK_MS);
    this.owed.add(t);
    (t as { unref?: () => void }).unref?.();
  }

  // Queued rows that named a sender left a queue unread (the engine says why).
  dropped(rows: QueueItem[], why: string) {
    for (const q of rows) {
      const id = q.meta?.kind === "peer" ? q.meta.message_id : undefined;
      if (typeof id === "string") this.set(id, "dropped", ["queued"], DROP_WORDS[why] ?? why);
    }
  }

  // Messages still queued by the store's word: read (in the history), still waiting (in the queue), or gone.
  private async settle(sessionId: string, ids: string[], goneWhy: string) {
    const session = this.d.store.session(sessionId);
    const inQueue = new Set((session ? this.d.store.queue(sessionId) : []).map((q) => q.meta?.message_id));
    for (const id of ids) {
      if (this.stopped) return;
      if (inQueue.has(id) || this.read.get(sessionId)?.has(id)) continue;
      const was = session ? (await this.d.read<{ n: number }>("SELECT 1 AS n FROM events WHERE session_id = ? AND kind = 'user' AND json_extract(data, '$.message_id') = ? LIMIT 1", [sessionId, id])).length > 0 : false;
      if (this.stopped) return;
      if (!was) { this.set(id, "dropped", ["queued", "delivered"], session ? goneWhy : DROP_WORDS.deleted); continue; }
      // Read. Its turn still runs: settled at its end. Else the receiver is idle again.
      if (this.d.isRunning(sessionId)) this.seen(sessionId, id);
      else this.set(id, "handled", ["queued", "delivered"]);
    }
  }

  // At a start: the messages a daemon before this one left queued or delivered (a bounded few, the newest).
  private async reconcile() {
    const open = this.d.store.db
      .query<{ id: string; to_session: string }, []>("SELECT id, to_session FROM fleet_messages WHERE state IN ('queued', 'delivered') AND to_daemon IS NULL ORDER BY created_ms DESC LIMIT 200").all();
    const by = new Map<string, string[]>();
    for (const m of open) (by.get(m.to_session) ?? by.set(m.to_session, []).get(m.to_session)!).push(m.id);
    for (const [sessionId, ids] of by) if (!this.stopped) await this.settle(sessionId, ids, "it left that session's queue before it was read");
  }
}
