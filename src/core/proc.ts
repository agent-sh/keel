// Reading a byte stream: a child process's pipes and HTTP response bodies
// (provider streams, MCP and fleet event streams). Every module reads through
// these helpers, which take the stream's reader and never hand it back.
// Releasing a reader while its stream is open rejects in Bun ("Invalid state:
// Reader released"), unhandled, and `for await` over a stream releases it
// whenever the loop is left early (a consumer that stops, a turn aborted on a
// hot reload). A read that stops early cancels the stream instead, which
// closes it (a child then sees EPIPE rather than blocking on a full pipe).

type Pipe = ReadableStream<Uint8Array> | number | null | undefined;

// Each chunk as it comes, until the stream ends; leaving the loop early
// cancels the stream.
export async function* chunks(s: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void> {
  const r = s.getReader();
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) { ended = true; return; }
      if (value) yield value;
    }
  } finally {
    if (!ended) r.cancel().catch(() => {});
  }
}

// Each chunk of a child pipe; resolves when the pipe ends. A read failure, or
// an `onChunk` that throws, rejects, tagged with `where`.
export async function pump(pipe: Pipe, onChunk: (c: Uint8Array) => void, where = "child pipe"): Promise<void> {
  if (!pipe || typeof pipe === "number") return;
  try {
    for await (const c of chunks(pipe)) onChunk(c);
  } catch (e) {
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { where });
  }
}

// Text as it comes, decoded across chunk edges.
export function pumpText(pipe: Pipe, onText: (t: string) => void, where?: string): Promise<void> {
  const dec = new TextDecoder();
  return pump(pipe, (c) => onText(dec.decode(c, { stream: true })), where).then(() => {
    const tail = dec.decode();
    if (tail) onText(tail);
  });
}

// The whole pipe as text.
export async function readText(pipe: Pipe, where?: string): Promise<string> {
  let out = "";
  await pumpText(pipe, (t) => (out += t), where);
  return out;
}

// Lines as they come (the last one without its newline at the end).
export function pumpLines(pipe: Pipe, onLine: (l: string) => void, where?: string): Promise<void> {
  let buf = "";
  return pumpText(pipe, (t) => {
    buf += t;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i));
  }, where).then(() => { if (buf) onLine(buf); });
}

// stdout, stderr and the exit code of a spawned process, read together.
export async function collect(p: { stdout: Pipe; stderr?: Pipe; exited: Promise<number> }, where?: string) {
  const [out, err, code] = await Promise.all([readText(p.stdout, where), readText(p.stderr, where), p.exited]);
  return { out, err, code };
}
