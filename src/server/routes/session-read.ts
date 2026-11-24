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
import { constants, createBrotliCompress, createGzip, createZstdCompress } from "node:zlib";
import { encode, MIN_BYTES, type Enc } from "../compress.ts";

// `head`: the answer's text up to its events; `tail`: its text after the
// session's newest seq. `coding`: what the request takes, null for none.
export type WholeAsk = { session: string; head: string; tail: string; coding: Enc | null };
// `coding`: what `body` is compressed with, null when it is not. `transfer`: what is handed to the loop without a copy.
export type Whole = { body: Uint8Array<ArrayBuffer>; coding: Enc | null; events: number; transfer?: ArrayBuffer[] };

// `head`, then `[every event of the session, all branches, in seq order],"seq":<its newest seq>`, then `tail`.
// The answer is written as bytes a part at a time as the rows come, and a part goes to the compressor at once
// (the coding the request takes), so the thread holds a part, not the session: never a list of strings and one
// joined string (three or more times the bytes, and twice that when any event holds a character past Latin-1,
// which makes the whole string two bytes a character), which on a session of a hundred megabytes took a few
// hundred megabytes of the thread's memory for the moment it was made.
export const PART = 2 * 1024 * 1024;

type Packer = { write(part: Uint8Array): Promise<void>; end(): Promise<Uint8Array<ArrayBuffer>> };
// A compressor that is given the answer a part at a time (the same settings as `encode`).
function packer(coding: Enc): Packer {
  const z = coding === "zstd" ? createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } })
    : coding === "br" ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : createGzip({ level: 4 });
  const out: Buffer[] = [];
  let failed: Error | undefined;
  z.on("data", (b: Buffer) => out.push(b));
  z.on("error", (e: Error) => { failed = e; });
  return {
    // (Waits until the compressor took the part: a part not waited for is held until it is.)
    write: (part) => new Promise<void>((ok, no) => z.write(part, (e) => (e || failed ? no(e ?? failed) : ok()))),
    end: () => new Promise((ok, no) => { z.on("end", () => ok(new Uint8Array(Buffer.concat(out)) as Uint8Array<ArrayBuffer>)); z.on("error", no); z.end(); }),
  };
}

export async function sessionWhole(db: Database, a: WholeAsk): Promise<Whole> {
  const sid = JSON.stringify(a.session);
  const sink = new Bun.ArrayBufferSink();
  sink.start({ asUint8Array: true, stream: true });
  // What has been taken out of the sink: parts kept (no coding), or sent to the compressor.
  const kept: Uint8Array[] = [];
  let pack: Packer | undefined;
  let held = 0, sent = 0;
  const put = (text: string) => { sink.write(text); held += text.length; };
  const part = async () => {
    const bytes = sink.flush() as Uint8Array;
    held = 0;
    sent += bytes.length;
    if (a.coding && !pack) pack = packer(a.coding);
    if (pack) await pack.write(bytes);
    else kept.push(bytes);
  };
  put(a.head);
  put("[");
  let seq = 0, n = 0;
  const rows = db.prepare<{ id: string; seq: number; parent: string | null; kind: string; data: string; ts: number }, [string]>("SELECT id, seq, parent, kind, data, ts FROM events WHERE session_id = ? ORDER BY seq");
  try {
    for (const r of rows.iterate(a.session)) {
      // (An event as the store hands it out: its fields in this order.)
      put(`${n++ ? "," : ""}{"id":${JSON.stringify(r.id)},"session_id":${sid},"seq":${r.seq},"parent":${r.parent === null ? "null" : JSON.stringify(r.parent)},"kind":${JSON.stringify(r.kind)},"data":`);
      put(r.data);
      put(`,"ts":${r.ts}}`);
      seq = r.seq;
      if (held >= PART) await part();
    }
  } finally {
    rows.finalize();
  }
  put(`],"seq":${seq}`);
  put(a.tail);
  // An answer that fits one part: coded as a whole, when it is worth it.
  if (!sent) {
    const raw = sink.end() as Uint8Array<ArrayBuffer>;
    const packed = a.coding && raw.length >= MIN_BYTES ? encode(raw, a.coding) : raw;
    // (Only an array that is the whole of its buffer is handed over as it is.)
    const body = packed.byteOffset === 0 && packed.byteLength === packed.buffer.byteLength ? packed : packed.slice();
    return { body, coding: packed === raw ? null : a.coding, events: n, transfer: [body.buffer] };
  }
  await part();
  sink.end();
  let body: Uint8Array<ArrayBuffer>;
  if (pack) body = await pack.end();
  else {
    body = new Uint8Array(sent);
    let at = 0;
    for (const k of kept) { body.set(k, at); at += k.length; }
  }
  return { body, coding: pack ? a.coding : null, events: n, transfer: [body.buffer] };
}
