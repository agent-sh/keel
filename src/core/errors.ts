import { AsyncLocalStorage } from "node:async_hooks";
import type { Bus } from "./bus.ts";
import { sessionOf, type Store } from "./store.ts";
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
export type ErrorPlace = Pick<ErrorRecord, "session_id" | "turn_event" | "span_id"> & { group?: string };
export type ErrorCapture = Pick<ErrorRecord, "id" | "source"> & { context: unknown; turnSession?: string };

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
    try {
      rec = this.store.recordError({ source, message: e.message, stack: e.stack, context, session_id, turn_event, span_id }, at.group);
    } catch (failed) {
      console.error(`[${source}] ${e.message} (not recorded: ${(failed as Error)?.message ?? failed})`);
      const now = Date.now();
      return { id: "", source, message: e.message, stack: e.stack, context, count: 1, first_ts: now, ts: now, session_id, turn_event, span_id } as ErrorRecord;
    }
    // Where it happened is kept beside the kind; a store that will not take it leaves the kind as it is.
    try {
      // A failure that is about to be tried again is not the owner's yet: when nothing of its
      // kind has failed for good it stays read, so the count of unread failures does not rise for the length of
      // each wait and fall when the retry passes. It is unread when the retries run out (that
      // failure is captured without a retry to come), or when the kind was already open.
      const pending = typeof (context as any)?.retry === "number" && typeof (context as any)?.wait_ms === "number";
      const quiet = pending && this.sites.failed(rec.id) === 0;
      this.sites.note(rec, pending);
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

  installGlobal() {
    process.on("uncaughtException", (e) => this.capture("server", e, { kind: "uncaughtException" }));
    // The reason's type and code say where a stack-less rejection came from.
    process.on("unhandledRejection", (e: any) => this.capture("server", e, { kind: "unhandledRejection", type: e?.constructor?.name, code: e?.code, where: e?.where }));
  }
}
