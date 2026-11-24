// What the daemon has in flight that holds memory and is not a session's turn: counted where it starts and ends,
// read by the resource sampler to say what was running when the daemon's memory stepped (src/admin/resources.ts),
// and by the stall monitor to say what ran while the loop was held (src/admin/stall.ts).
//
// Each piece of work is a span: a kind (a route, a socket frame, a read on the thread, a background task), a
// label with no value of the owner's in it, when it began and ended, and the process's resident memory at both
// ends. Spans still open and spans that ended in the last two minutes are kept (the ring), so a step or a stall
// found a moment after the work ended can still name it.
const live = new Map<string, number>();

// One span. Times are wall clock ms. `rss0`/`rss1`: the process's resident memory at its start and end.
export type Span = { kind: string; label: string | (() => string); t0: number; t1?: number; rss0: number; rss1?: number };

const open = new Set<Span>();
const ring: Span[] = [];
// A span that ended is kept when it ran at least this long: a request that took a millisecond holds no memory worth naming.
const KEEP_MS = 10;
const RING_MAX = 1024;
const RING_MS = 120_000;
// Growth is read off a span only when it began this recently: the memory of a stream open for hours says nothing of it.
const GROWTH_MS = RING_MS;

// A label made when it is first needed: a request's route costs a parse the many that end at once do not owe.
const said = (s: Span): string => (typeof s.label === "string" ? s.label : (s.label = s.label()));

const rss = () => process.memoryUsage.rss();

// One more of `kind` until the returned function is called (a second call does nothing).
// `label`: what exactly (a route, a read's name), where the kind alone does not say.
export function begin(kind: string, label?: string | (() => string)): () => void {
  live.set(kind, (live.get(kind) ?? 0) + 1);
  const span: Span = { kind, label: label ?? kind, t0: Date.now(), rss0: rss() };
  open.add(span);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (live.get(kind) ?? 1) - 1;
    if (n > 0) live.set(kind, n);
    else live.delete(kind);
    open.delete(span);
    span.t1 = Date.now();
    span.rss1 = rss();
    if (span.t1 - span.t0 < KEEP_MS) return;
    span.label = said(span);
    ring.push(span);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    const old = span.t1 - RING_MS;
    let i = 0;
    while (i < ring.length && ring[i]!.t1! < old) i++;
    if (i) ring.splice(0, i);
  };
}

export async function during<T>(kind: string, run: () => Promise<T>, label?: string | (() => string)): Promise<T> {
  const end = begin(kind, label);
  try { return await run(); } finally { end(); }
}

// The same for a pass that runs on the loop and does not yield.
export function duringSync<T>(kind: string, label: string | (() => string), run: () => T): T {
  const end = begin(kind, label);
  try { return run(); } finally { end(); }
}

// The kinds that have something in flight now, and how many.
export const ongoing = (): Record<string, number> => Object.fromEntries(live);

// What ran between `from` and `to` (wall clock ms): each kind and label once, with how many ran, how long
// they ran inside the window (together: they overlap), how many are still open, the longest one and the most
// the process's resident memory grew over one of them (memory the whole process took meanwhile, not only theirs).
// The ones whose time saw the most growth first.
export type Ran = { kind: string; label: string; n: number; open: number; ms: number; longest_ms: number; grew_bytes: number };
export function ran(from: number, to: number, max = 12): Ran[] {
  const by = new Map<string, Ran>();
  const now = Date.now();
  const add = (s: Span) => {
    const end = s.t1 ?? now;
    if (end < from || s.t0 > to) return;
    const label = said(s);
    const key = `${s.kind}\0${label}`;
    const r = by.get(key) ?? { kind: s.kind, label, n: 0, open: 0, ms: 0, longest_ms: 0, grew_bytes: 0 };
    r.n++;
    if (s.t1 === undefined) r.open++;
    r.ms += Math.min(end, to) - Math.max(s.t0, from);
    r.longest_ms = Math.max(r.longest_ms, end - s.t0);
    if (now - s.t0 < GROWTH_MS) r.grew_bytes = Math.max(r.grew_bytes, (s.rss1 ?? rss()) - s.rss0);
    by.set(key, r);
  };
  for (const s of ring) add(s);
  for (const s of open) add(s);
  return [...by.values()].sort((a, b) => b.grew_bytes - a.grew_bytes || b.ms - a.ms).slice(0, max).map((r) => ({ ...r, ms: Math.round(r.ms) }));
}

// For a log line: "GET /api/x x3 (1 open, 420 ms, +180 MB)".
export function ranWords(rs: Ran[], max = 6): string {
  const mb = (b: number) => `${b >= 0 ? "+" : "-"}${Math.round(Math.abs(b) / 1048576)} MB`;
  return rs.slice(0, max).map((r) => `${r.label}${r.n > 1 ? ` x${r.n}` : ""} (${r.open ? `${r.open} open, ` : ""}${r.longest_ms} ms, ${mb(r.grew_bytes)})`).join("; ");
}

// For a test: forget every span.
export function reset() { live.clear(); open.clear(); ring.length = 0; }
