// Event streams that stay open (the fleet relay, the phone's feed), per
// process. A dev hot reload ends the ones the previous code opened: Bun keeps
// such a response pumping across the reload, and when its client goes away
// later, Bun releases the stream's reader while it is still open and the
// release rejects unhandled ("Invalid state: Reader released"). The client
// reconnects to the new code.
type Ctl = { close(): void };
const g = globalThis as { __keelStreams?: Set<Ctl> };
const open = (g.__keelStreams ??= new Set());

// A stream's controller while it is open; the returned function forgets it.
export function holdStream(c: Ctl): () => void {
  open.add(c);
  return () => void open.delete(c);
}

export function endStreams() {
  for (const c of open) try { c.close(); } catch {}
  open.clear();
}

// What may wait for one reader of a live feed, beyond what the socket holds.
// A reader that lets this much build up is stalled: holding every frame it
// misses would grow without end, so its feed ends and it reconnects for a
// fresh snapshot.
export const FEED_LIMIT = 4 * 1024 * 1024;

// A live feed for one reader with that bound. `send` is false once the feed
// has ended: closed by the reader, or cut because a frame did not fit behind
// what already waits (`onEnd(true)`, after `last` went out as the final bytes).
// `open` is what the feed starts with (a snapshot): it is queued before the
// reader has pulled anything and can be any size, so it is outside the bound.
export function boundedFeed(onEnd: (stalled: boolean) => void, opts: { limit?: number; last?: Uint8Array; open?: Uint8Array[] } = {}) {
  const open = opts.open ?? [];
  const bound = (opts.limit ?? FEED_LIMIT) + open.reduce((n, b) => n + b.byteLength, 0);
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let forget = () => {};
  const end = (stalled = false) => {
    if (ended) return;
    ended = true;
    forget();
    try {
      if (stalled && opts.last) ctl.enqueue(opts.last);
      ctl.close();
    } catch {}
    onEnd(stalled);
  };
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; for (const b of open) c.enqueue(b); }, cancel: () => end() }, { highWaterMark: bound, size: (c) => c?.byteLength ?? 0 });
  forget = holdStream({ close: () => end() });
  return {
    stream,
    bound,
    ended: () => ended,
    // Bytes that wait for the reader inside this process.
    pending: () => (ended ? 0 : Math.max(0, bound - (ctl.desiredSize ?? bound))),
    send(bytes: Uint8Array): boolean {
      if (ended) return false;
      const room = ctl.desiredSize;
      if (room === null) { end(); return false; }
      // One frame larger than the bound still goes to a reader that keeps up.
      if (bytes.byteLength > room && room < bound) { end(true); return false; }
      try { ctl.enqueue(bytes); } catch { end(); return false; }
      return true;
    },
    end: () => end(),
  };
}

// Half the server's idle timeout (10 s, app.ts): Bun closes a response that
// has sent nothing for that long, also while its handler still works.
export const KEEPALIVE_MS = 5_000;

// A response of JSON lines written while `work` runs, one per `line(v)`. While
// the work is quiet an empty line goes out every KEEPALIVE_MS, so a long step
// (an index built for the first time) does not end the response as idle. A
// reader skips empty lines.
export function jsonLines(work: (line: (v: unknown) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  let tick: Timer | undefined;
  return new Response(new ReadableStream<Uint8Array>({
    async start(c) {
      const put = (s: string) => { try { c.enqueue(enc.encode(s)); } catch {} };
      tick = setInterval(() => put("\n"), KEEPALIVE_MS);
      try { await work((v) => put(JSON.stringify(v) + "\n")); } finally { clearInterval(tick); }
      try { c.close(); } catch {}
    },
    cancel: () => clearInterval(tick),
  }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
