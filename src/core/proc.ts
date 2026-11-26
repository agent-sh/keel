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

// As chunks(), and it ends when `stop` settles: the reader is cancelled there, so a pipe that a process further
// down still holds open is not waited for. The stop is not raced against each read: a race leaves a reaction on
// `stop` for every read, which holds the chunk that read returned until `stop` settles, so a long, chatty
// process held all of its output (every chunk, however long the caller kept only its end).
export async function* chunksUntil(s: ReadableStream<Uint8Array>, stop: Promise<unknown>): AsyncGenerator<Uint8Array, void> {
  const r = s.getReader();
  let over = false, ended = false;
  const cancel = () => { if (!ended) { ended = true; r.cancel().catch(() => {}); } };
  const onStop = () => { over = true; cancel(); };
  stop.then(onStop, onStop);
  try {
    for (;;) {
      if (over) return;
      const { done, value } = await r.read();
      if (over) return;
      if (done) { ended = true; return; }
      if (value) yield value;
    }
  } finally {
    cancel();
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

// Lines as they come (the last one without its newline at the end). With `limit`, a line longer than `limit.max`
// characters is never held or handed on: what comes of it is dropped up to its newline, and `limit.over` is told
// its length once (a program that writes one without a newline cannot make this process hold it), with the first
// `limit.head` characters of it (none by default), so a caller can tell what the line was. `limit.grew` hears the
// dropped part's length each time it grows, before the line ends (or never does).
export function pumpLines(pipe: Pipe, onLine: (l: string) => void, where?: string, limit?: { max: number; over: (chars: number, head: string) => void; head?: number; grew?: (skipped: number, head: string) => void }): Promise<void> {
  let buf = "";
  if (!limit) {
    return pumpText(pipe, (t) => {
      buf += t;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i));
    }, where).then(() => { if (buf) onLine(buf); });
  }
  const { max, over } = limit;
  const headMax = limit.head ?? 0;
  let skipped = 0; // characters of the line being dropped, 0 when none is
  let head = ""; // the first characters of the line being dropped
  return pumpText(pipe, (t) => {
    let from = 0;
    for (let i; (i = t.indexOf("\n", from)) >= 0; from = i + 1) {
      if (skipped) { over(skipped + i - from, head); skipped = 0; head = ""; continue; }
      const line = buf + t.slice(from, i);
      buf = "";
      if (line.length > max) over(line.length, line.slice(0, headMax)); else onLine(line);
    }
    const rest = from ? t.slice(from) : t;
    if (skipped) skipped += rest.length;
    else if (buf.length + rest.length > max) { head = (buf + rest.slice(0, headMax)).slice(0, headMax); skipped = buf.length + rest.length; buf = ""; }
    else { buf += rest; return; }
    limit.grew?.(skipped, head);
  }, where).then(() => { if (skipped) over(skipped, head); else if (buf) onLine(buf); });
}

// A child whose output is read whole: what a Bun.spawn result has of it.
export type Child = {
  stdout?: unknown;
  stderr?: unknown;
  exited: Promise<number>;
  signalCode?: string | number | null;
  kill(signal?: number | NodeJS.Signals): void;
};
export type Ended = {
  code: number;
  out: string;
  err: string;
  // The signal that ended the child, when one did.
  signal: string | null;
  // Ended by `timeoutMs` or by `signal`: the output is what it wrote before.
  timedOut: boolean;
  aborted: boolean;
  // `cap` dropped some of the output, or `graceMs` ended a read before its pipe did.
  cut: boolean;
};
export type EndedOpts = {
  where?: string;
  // The child is stopped by `kill` after this long, or when `signal` aborts.
  timeoutMs?: number;
  signal?: AbortSignal;
  // How it is stopped (default SIGKILL to the child; a caller that started a group stops the group).
  kill?: () => void;
  // Runs once the child has ended, before its pipes are read to their end: a caller stops what it left
  // running (a process of its group that holds a pipe open), so the read is not held by it.
  exited?: () => void | Promise<void>;
  // After the end (and `exited`), the pipes are read for this long at most: a process that left the group
  // and holds a pipe open is not waited for. Without it a pipe is read to its end.
  graceMs?: number;
  // The most characters kept of each pipe, its head (default) or its tail. A capped pipe is read while the
  // child runs, so a long output is never held whole: use it where the output has no bound of its own.
  cap?: number;
  keep?: "head" | "tail";
  // A pipe whose read fails gives what was read of it (and `cut`), with the real exit code, instead of failing the call.
  partial?: boolean;
};

// The whole output of a child and its exit code. The pipes are read once the child has ended: the runtime
// drains a child's pipes by itself (a long output never fills one), and a read that waits on an open pipe
// gets a buffer of its own, about 130 KB for one that ends empty, which is dropped at once. Read after the
// end, a pipe costs nothing but its text. A child stopped by the time limit or the signal gives what it
// wrote until then. Reads that must follow the output as it comes (a live display, a protocol, a watch)
// use pump, pumpLines or chunks instead.
export async function outputOf(p: Child, o: EndedOpts = {}): Promise<Ended> {
  let timedOut = false, aborted = false;
  const kill = o.kill ?? (() => { try { p.kill("SIGKILL"); } catch { /* gone already */ } });
  const timer = o.timeoutMs !== undefined && Number.isFinite(o.timeoutMs) ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : undefined;
  const onAbort = () => { aborted = true; kill(); };
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener("abort", onAbort, { once: true });
  let stop: (() => void) | undefined;
  const stopped = o.graceMs === undefined ? undefined : new Promise<void>((r) => (stop = r));
  const read = (pipe: unknown) => keptText(pipe as Pipe, o, stopped);
  const capped = o.cap !== undefined ? [read(p.stdout), read(p.stderr)] : undefined;
  // (A capped read that fails is told after the end, as an uncapped one is.)
  capped?.forEach((c) => c.catch(() => {}));
  // The time limit and the abort hold until the pipes are read too: a process the child left running (`cmd &`
  // with its output not sent elsewhere) keeps a pipe open after the child's end, and is stopped by them then.
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await p.exited;
    await o.exited?.();
    if (stop) grace = setTimeout(stop, o.graceMs);
    const [a, b] = await Promise.all(capped ?? [read(p.stdout), read(p.stderr)]);
    return { code, out: a!.text, err: b!.text, signal: p.signalCode == null ? null : String(p.signalCode), timedOut, aborted, cut: a!.cut || b!.cut };
  } finally {
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    if (grace) clearTimeout(grace);
    stop?.();
  }
}

// A pipe's text, keeping at most `o.cap` characters of it (its head, or its tail), until it ends or `stop` settles.
async function keptText(pipe: Pipe, o: EndedOpts, stop?: Promise<void>): Promise<{ text: string; cut: boolean }> {
  if (!pipe || typeof pipe === "number") return { text: "", cut: false };
  const cap = o.cap ?? Infinity, tail = o.keep === "tail";
  const dec = new TextDecoder();
  let text = "", cut = false, ended = false;
  const keep = (t: string) => {
    if (!t) return;
    if (!tail) {
      if (text.length >= cap) { cut = true; return; }
      if (text.length + t.length > cap) { cut = true; text += t.slice(0, cap - text.length); } else text += t;
      return;
    }
    text += t;
    // (Cut when it is twice the cap, so a chatty child is not sliced at every chunk.)
    if (text.length > 2 * cap) { cut = true; text = text.slice(-cap); }
  };
  try {
    if (stop) {
      const r = pipe.getReader();
      let over = false;
      const onStop = () => { over = true; if (!ended) r.cancel().catch(() => {}); };
      stop.then(onStop, onStop);
      for (;;) {
        if (over) break;
        const { done, value } = await r.read();
        if (done) { ended = !over; break; }
        if (value) keep(dec.decode(value, { stream: true }));
      }
      if (!ended) cut = true;
    } else {
      for await (const c of chunks(pipe)) keep(dec.decode(c, { stream: true }));
    }
    keep(dec.decode());
  } catch (e) {
    if (o.partial) { keep(dec.decode()); return { text: text.length > cap ? (tail ? text.slice(-cap) : text.slice(0, cap)) : text, cut: true }; }
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { where: o.where ?? "child pipe" });
  }
  if (text.length > cap) { cut = true; text = tail ? text.slice(-cap) : text.slice(0, cap); }
  return { text, cut };
}

// stdout, stderr and the exit code of a spawned process, read once it has ended.
export async function collect(p: Child, where?: string) {
  const { out, err, code } = await outputOf(p, { where });
  return { out, err, code };
}

// A finished child's processor time in ms, with what it waited for (the system's own count of it): null when not known.
export function cpuMsOf(p: { resourceUsage?: () => { cpuTime: { total: bigint | number } } | undefined }): number | null {
  try { const t = p.resourceUsage?.()?.cpuTime.total; return t === undefined ? null : Math.round(Number(t) / 1000); } catch { return null; }
}
