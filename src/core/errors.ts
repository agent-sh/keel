import { AsyncLocalStorage } from "node:async_hooks";
import type { Bus } from "./bus.ts";
import { fingerprint, sessionOf, type Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";
import { ErrorSites } from "./error-sites.ts";

// The turn the running code belongs to. The engine opens one scope per turn it
// starts, names the turn_start event once it is stored and takes the name away
// when the turn is over: work the turn left behind then fails in no turn.
export type ErrorScope = { session: string; turn?: string };
export const errorScope = new AsyncLocalStorage<ErrorScope>();
// Work a turn happens to start that is not the turn's own (a shared connection,
// an exporter's timer, maintenance): its timers and callbacks run in no scope.
export const detached = <T>(f: () => T): T => errorScope.exit(f);
// Where a failure happened, when its catcher knows better than its surroundings say.
// `group`: what repeats of this failure share, when its words do not say (a
// message that carries what varies: a duration's cause, a child's name). The
// row is one per group instead of one per message shape.
export type ErrorPlace = Pick<ErrorRecord, "session_id" | "turn_event" | "span_id"> & { group?: string; recovered?: true };
export type ErrorCapture = Pick<ErrorRecord, "id" | "source"> & { context: unknown; turnSession?: string };

const KEPT_MAX = 100;
const FLUSH_MS = 30_000;
// What the kept failures may hold: each record, and all of them together.
const KEPT_RECORD_BYTES = 32 * 1024;
const KEPT_BYTES = 2 * 1024 * 1024;
const DROPPED = "\u0000dropped";
const sizeOf = (r: { message: string; stack?: string; context?: unknown }) => {
  let n = r.message.length + (r.stack?.length ?? 0);
  try { n += r.context === undefined ? 0 : JSON.stringify(r.context).length; } catch { n += KEPT_RECORD_BYTES; }
  return n;
};
// A record within KEPT_RECORD_BYTES: the message and the stack are cut, and a context too large to keep is left out and said.
function bounded<T extends { message: string; stack?: string; context?: unknown }>(r: T): T {
  const message = r.message.length > 4_000 ? `${r.message.slice(0, 4_000)}... (${r.message.length - 4_000} more characters)` : r.message;
  const stack = r.stack && r.stack.length > 8_000 ? `${r.stack.slice(0, 8_000)}\n... (cut)` : r.stack;
  let context = r.context;
  let size = 0;
  try { size = context === undefined ? 0 : JSON.stringify(context).length; } catch { size = Infinity; }
  if (size > KEPT_RECORD_BYTES - 12_000) context = { left_out: `the context of this failure was ${Number.isFinite(size) ? `${size} characters` : "not something that can be kept"}: too large to keep in memory` };
  return { ...r, message, stack, context };
}

// Every failure lands in one table and one live frame, whoever caught it.
export class ErrorTracker {
  private captures = new Set<(e: ErrorCapture) => void>();

  // Where each kind happened, per session (error-sites.ts).
  readonly sites: ErrorSites;

  constructor(private store: Store, private bus: Bus) {
    this.sites = new ErrorSites(store.db);
  }

  // One kind, and the list, each with where it happened and whether a retry healed it.
  get(id: string): ErrorRecord | undefined {
    const e = this.store.error(id);
    return e && this.sites.with([e])[0];
  }

  // A kind named loosely: its id, or the start or the end of it (eight
  // characters or more) when that names one kind, as a text row prints it.
  find(ref: string): ErrorRecord | undefined {
    const exact = this.get(ref);
    if (exact || !/^[0-9a-f-]{8,}$/i.test(ref)) return exact;
    const rows = this.store.db.query<{ id: string }, [string, string]>("SELECT id FROM errors WHERE id LIKE ?1 OR id LIKE ?2 LIMIT 2").all(`${ref}%`, `%${ref}`);
    return rows.length === 1 ? this.get(rows[0]!.id) : undefined;
  }

  // `session`: the kinds that happened in that session or in an agent of it,
  // whether or not they last happened there.
  list(limit = 200, opts: { resolved?: boolean; read?: boolean; session?: string } = {}): ErrorRecord[] {
    if (!opts.session) return this.sites.with(this.store.errors(limit, opts));
    // By the session's own rows, each kind read by its id: complete however many kinds the
    // store holds (a model is told of its session's failures from this), and no pass over the rest.
    const ids = this.sites.kindsOf(opts.session, opts, limit);
    return this.sites.with(ids.map((id) => this.store.error(id)).filter((e): e is ErrorRecord => !!e));
  }

  // The owner resolved a kind, or took that back. Resolved, what was open of it is dealt with:
  // a later occurrence that a retry heals leaves it recovered, not open over the old ones.
  resolve(id: string, resolved: boolean): ErrorRecord | undefined {
    this.store.resolveError(id, resolved);
    if (resolved) this.sites.settle(id);
    return this.get(id);
  }

  // A retry of the request these failures came from passed: each is healed in
  // its session. A kind left with nothing unhealed is recovered: it leaves the
  // unread count (as a kind the owner read does) and says so on its row.
  recovered(recs: ErrorRecord[], sessionId: string) {
    const by = new Map<string, number>();
    for (const r of recs) if (r.id) by.set(r.id, (by.get(r.id) ?? 0) + 1);
    for (const [id, n] of by) {
      try {
        if (!this.sites.heal(id, sessionId, n)) continue;
        let rec = this.get(id);
        if (!rec) continue;
        if (rec.recovered_ts && !rec.read_ts) { this.store.readError(id, true); rec = this.get(id)!; }
        this.bus.emit({ t: "error", error: rec });
      } catch (failed) {
        console.error(`[errors] a healed failure was not marked: ${(failed as Error)?.message ?? failed}`);
      }
    }
  }

  // The UI's error frames also carry read/resolved changes. Observe actual
  // captures separately, with this occurrence's context, not the folded row's session.
  onCapture(listener: (e: ErrorCapture) => void) {
    this.captures.add(listener);
    return () => { this.captures.delete(listener); };
  }

  // The session and turn a trace span belongs to (the tracer answers: src/server/routes/observe.ts).
  spanOf?: (spanId: string) => { session_id: string; attrs: { turn_event?: string } } | undefined;

  // The row says where this occurrence happened and nothing it did not see: the
  // session its catcher named (else the failed span's), the turn the code ran
  // in when that turn is this session's (else the span's own turn), and the
  // span. A catcher that names no session gets none: a daemon-wide failure that
  // surfaces while a turn runs is not that turn's. Nothing is read off the
  // session's history, where the newest turn may be another one.
  capture(source: ErrorRecord["source"], err: unknown, context?: unknown, at: ErrorPlace = {}): ErrorRecord {
    const e = err instanceof Error ? err : new Error(String(err));
    // A failed model request or tool call names its trace span on the error it threw (src/admin/trace.ts).
    const span_id = at.span_id ?? (typeof (err as any)?.span_id === "string" ? (err as any).span_id : undefined);
    const span = span_id ? this.spanOf?.(span_id) : undefined;
    const scope = errorScope.getStore();
    const session_id = at.session_id ?? sessionOf(context) ?? span?.session_id;
    const turn_event = at.turn_event ?? (scope?.session === session_id ? scope?.turn : undefined) ?? (span?.session_id === session_id ? span?.attrs.turn_event : undefined);
    // The store may not take it (closed, full, locked). The failure is still
    // said, on the console, and nothing is thrown from here: a capture that
    // throws inside a catch or the process's rejection handler turns one
    // failure into another.
    let rec: ErrorRecord;
    const raw = { source, message: e.message, stack: e.stack, context, session_id, turn_event, span_id };
    try {
      rec = this.store.recordError(raw, at.group);
    } catch (failed) {
      // Kept in memory and shown all the same: a full disk, or a store that
      // takes no writes, is when the owner most needs to see what fails.
      console.error(`[${source}] ${e.message} (not recorded: ${(failed as Error)?.message ?? failed})`);
      const kept = this.keep(raw, at.group, String((failed as Error)?.message ?? failed));
      try { this.bus.emit({ t: "error", error: kept }); } catch {}
      return kept;
    }
    // The store takes rows again: the ones it could not take are written now.
    if (this.kept.length) this.flush();
    // Where it happened is kept beside the kind; a store that will not take it leaves the kind as it is.
    try {
      // A failure that is about to be tried again is not the owner's yet: when nothing of its
      // kind has failed for good it stays read, so the count of unread failures does not rise for the length of
      // each wait and fall when the retry passes. It is unread when the retries run out (that
      // failure is captured without a retry to come), or when the kind was already open.
      const pending = typeof (context as any)?.retry === "number" && typeof (context as any)?.wait_ms === "number";
      const quiet = (pending || at.recovered) && this.sites.failed(rec.id) === 0;
      this.sites.note(rec, pending, at.recovered);
      if (quiet) rec = this.store.readError(rec.id, true) ?? rec;
      rec = this.sites.with([rec])[0]!;
    } catch (failed) { console.error(`[${source}] where it happened was not recorded: ${(failed as Error)?.message ?? failed}`); }
    this.bus.emit({ t: "error", error: rec });
    for (const listener of this.captures) {
      try { listener({ id: rec.id, source, context, turnSession: scope?.session }); } catch {}
    }
    console.error(`[${source}] ${rec.message}`);
    return rec;
  }

  // Failures the store could not take, the newest last: at most KEPT_MAX
  // kinds, a repeat counted on its kind. They are in the list the Errors
  // panel reads (`unwritten`), and are written, with their counts and times,
  // as soon as the store takes a row again (`flush`: at the next capture
  // that is recorded, and every FLUSH_MS while any wait).
  private kept: { rec: ErrorRecord; raw: Omit<ErrorRecord, "id" | "ts">; group?: string; key: string; bytes: number }[] = [];
  private keptSeq = 0;
  private keptBytes = 0;
  private flushing?: ReturnType<typeof setInterval>;
  // What is kept is what the store would have kept: the same redaction
  // first (a secret in a failure's text is its placeholder in memory, on
  // the bus and in the list, as it is in the table), and one record a kind,
  // by the store's own fingerprint (a message that differs by a number or an
  // id is the same kind). A record is held to KEPT_RECORD_BYTES (a long
  // stack is cut, a large context is left out and said), and all of them to
  // KEPT_BYTES: the oldest go first, and how many went is itself a record.
  private keep(given: Omit<ErrorRecord, "id" | "ts">, group: string | undefined, why: string): ErrorRecord {
    const now = Date.now();
    let raw = given;
    try {
      raw = { ...given, message: this.store.redact(null, "error", given.message), stack: given.stack && this.store.redact(null, "error", given.stack), context: given.context && this.store.redact(null, "error", given.context) };
    } catch {
      // The redaction itself failed: nothing of the failure's own text is kept.
      raw = { ...given, message: "a failure whose text could not be checked for secrets", stack: undefined, context: undefined };
    }
    raw = bounded(raw);
    const key = `${raw.source}\u0000${fingerprint(group ?? raw.message)}`;
    const bytes = sizeOf(raw);
    const had = this.kept.find((k) => k.key === key);
    if (had) {
      this.keptBytes += bytes - had.bytes;
      had.raw = raw;
      had.bytes = bytes;
      had.rec = { ...had.rec, ...raw, ts: now, count: (had.rec.count ?? 1) + 1 };
      this.trim(had.key);
      return had.rec;
    }
    const rec = { ...raw, id: `unwritten-${++this.keptSeq}`, ts: now, first_ts: now, count: 1, unwritten: why } as ErrorRecord;
    this.kept.push({ rec, raw, group, key, bytes });
    this.keptBytes += bytes;
    this.trim(key);
    if (!this.flushing) {
      this.flushing = setInterval(() => this.flush(), FLUSH_MS);
      this.flushing.unref?.();
    }
    return rec;
  }
  // Held to the count and the bytes: the oldest kinds go (never `spare`, the one just kept), and that they went is said.
  private trim(spare: string) {
    let dropped = 0;
    while (this.kept.length > KEPT_MAX || this.keptBytes > KEPT_BYTES) {
      const i = this.kept.findIndex((k) => k.key !== spare && k.key !== DROPPED);
      if (i < 0) break;
      const [gone] = this.kept.splice(i, 1);
      this.keptBytes -= gone!.bytes;
      dropped += gone!.rec.count ?? 1;
      try { this.bus.emit({ t: "error", error: { ...gone!.rec, resolved_ts: Date.now() } as ErrorRecord }); } catch {}
    }
    if (!dropped) return;
    const now = Date.now();
    const said = this.kept.find((k) => k.key === DROPPED);
    const total = (said?.rec.count ?? 0) + dropped;
    const raw = { source: "server" as const, message: `${total} earlier failure${total === 1 ? " was" : "s were"} dropped from memory: the store took no rows and no more could be kept. The console has each of them.` };
    if (said) { said.raw = raw; said.rec = { ...said.rec, ...raw, ts: now, count: total }; }
    else {
      const bytes = sizeOf(raw);
      this.kept.push({ rec: { ...raw, id: `unwritten-${++this.keptSeq}`, ts: now, first_ts: now, count: total, unwritten: "kept in memory" } as ErrorRecord, raw, group: DROPPED, key: DROPPED, bytes });
      this.keptBytes += bytes;
    }
    try { this.bus.emit({ t: "error", error: this.kept.find((k) => k.key === DROPPED)!.rec }); } catch {}
  }
  // The failures the store has not taken yet, the newest first (of one session's scope when asked).
  unwritten(session?: string): ErrorRecord[] {
    return this.kept.map((k) => k.rec).filter((r) => !session || r.session_id === session).reverse();
  }
  // The owner has seen one of them and wants it gone: it is let go, and the page is told.
  dismiss(id: string): ErrorRecord | undefined {
    const i = this.kept.findIndex((k) => k.rec.id === id);
    if (i < 0) return undefined;
    const [k] = this.kept.splice(i, 1);
    this.keptBytes -= k!.bytes;
    const gone = { ...k!.rec, resolved_ts: Date.now() };
    try { this.bus.emit({ t: "error", error: gone }); } catch {}
    return gone;
  }
  // Writes what was kept, the oldest first, and stops at the first the store still refuses.
  flush() {
    while (this.kept.length) {
      const k = this.kept[0]!;
      let rec: ErrorRecord;
      try {
        rec = this.store.recordError(k.raw, k.group);
        // The row says when it first happened and how often, not when it could be written.
        const more = (k.rec.count ?? 1) - 1;
        this.store.db.query("UPDATE errors SET count = count + ?, first_ts = MIN(first_ts, ?), ts = ? WHERE id = ?").run(more, k.rec.first_ts ?? k.rec.ts, k.rec.ts, rec.id);
        rec = this.store.error(rec.id) ?? rec;
      } catch {
        return;
      }
      this.kept.shift();
      this.keptBytes -= k.bytes;
      // The page drops the row it showed from memory and takes the stored one.
      try {
        this.bus.emit({ t: "error", error: { ...k.rec, resolved_ts: Date.now() } as ErrorRecord });
        this.bus.emit({ t: "error", error: rec });
      } catch {}
    }
    clearInterval(this.flushing);
    this.flushing = undefined;
  }

  installGlobal() {
    process.on("uncaughtException", (e) => this.capture("server", e, { kind: "uncaughtException" }));
    // The reason's type and code say where a stack-less rejection came from.
    process.on("unhandledRejection", (e: any) => this.capture("server", e, { kind: "unhandledRejection", type: e?.constructor?.name, code: e?.code, where: e?.where }));
  }
}
