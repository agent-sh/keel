// Reading a child process's pipes. Every module reads child output through
// these helpers, which take the pipe's reader and never hand it back: nothing
// reads a pipe after them, and in Bun releasing a reader while its stream is
// still open can reject unhandled ("Invalid state: Reader released"; see
// server/streams.ts for where Bun does it itself). A read that stops early
// cancels the pipe instead, which closes it and lets the child see EPIPE
// rather than block on a full pipe.

type Pipe = ReadableStream<Uint8Array> | number | null | undefined;

// Each chunk as it comes; resolves when the pipe ends. A read failure, or an
// `onChunk` that throws, rejects, tagged with `where`.
export async function pump(pipe: Pipe, onChunk: (c: Uint8Array) => void, where = "child pipe"): Promise<void> {
  if (!pipe || typeof pipe === "number") return;
  const r = pipe.getReader();
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) return;
      if (value) onChunk(value);
    }
  } catch (e) {
    r.cancel(e).catch(() => {});
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
