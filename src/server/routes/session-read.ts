// A whole session as the answer of GET /api/sessions/:id, written on the read
// thread. On the loop the answer read every body of the session from the
// table, parsed it, wrote it out again as JSON and compressed it: seconds for
// a session of tens of thousands of events, with every other session held
// meanwhile. An event's body is stored as the JSON it is answered as, so here
// the rows are put into the answer as they are stored, with nothing parsed,
// and the bytes (compressed when the request takes a coding) go back to the
// loop as they are.
//
// It imports nothing of the daemon: the read thread loads it (read-tasks.ts).
import type { Database } from "bun:sqlite";
import { encode, MIN_BYTES, type Enc } from "../compress.ts";

// `head`: the answer's text up to its events; `tail`: its text after the
// session's newest seq. `coding`: what the request takes, null for none.
export type WholeAsk = { session: string; head: string; tail: string; coding: Enc | null };
// `coding`: what `body` is compressed with, null when it is not. `transfer`: what is handed to the loop without a copy.
export type Whole = { body: Uint8Array<ArrayBuffer>; coding: Enc | null; events: number; transfer?: ArrayBuffer[] };

// `head`, then `[every event of the session, all branches, in seq order],"seq":<its newest seq>`, then `tail`.
export function sessionWhole(db: Database, a: WholeAsk): Whole {
  const sid = JSON.stringify(a.session);
  const parts: string[] = [a.head, "["];
  let seq = 0, n = 0;
  const rows = db.prepare<{ id: string; seq: number; parent: string | null; kind: string; data: string; ts: number }, [string]>("SELECT id, seq, parent, kind, data, ts FROM events WHERE session_id = ? ORDER BY seq");
  try {
    for (const r of rows.iterate(a.session)) {
      // (An event as the store hands it out: its fields in this order.)
      parts.push(`${n++ ? "," : ""}{"id":${JSON.stringify(r.id)},"session_id":${sid},"seq":${r.seq},"parent":${r.parent === null ? "null" : JSON.stringify(r.parent)},"kind":${JSON.stringify(r.kind)},"data":${r.data},"ts":${r.ts}}`);
      seq = r.seq;
    }
  } finally {
    rows.finalize();
  }
  parts.push(`],"seq":${seq}`, a.tail);
  const raw = new TextEncoder().encode(parts.join("")) as Uint8Array<ArrayBuffer>;
  const packed = a.coding && raw.length >= MIN_BYTES ? encode(raw, a.coding) : raw;
  // (Only an array that is the whole of its buffer is handed over as it is.)
  const body = packed.byteOffset === 0 && packed.byteLength === packed.buffer.byteLength ? packed : packed.slice();
  return { body, coding: packed === raw ? null : a.coding, events: n, transfer: [body.buffer] };
}
