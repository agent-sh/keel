// Event streams that stay open (the fleet relay, the phone's feed), per
// process. A dev hot reload ends the ones the previous code opened: Bun keeps
// such a response pumping across the reload, and when its client goes away
// later, Bun releases the stream's reader while it is still open and the
// release rejects unhandled ("Invalid state: Reader released"). The client
// reconnects to the new code.
type Ctl = ReadableStreamDefaultController<Uint8Array>;
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
