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
