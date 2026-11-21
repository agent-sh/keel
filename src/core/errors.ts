import { AsyncLocalStorage } from "node:async_hooks";
import type { Bus } from "./bus.ts";
import { sessionOf, type Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";

// The turn the running code belongs to. The engine opens one scope per turn it
// starts, names the turn_start event once it is stored and takes the name away
// when the turn is over: work the turn left behind then fails in no turn.
export type ErrorScope = { session: string; turn?: string };
export const errorScope = new AsyncLocalStorage<ErrorScope>();
// Work a turn happens to start that is not the turn's own (a shared connection,
// an exporter's timer, maintenance): its timers and callbacks run in no scope.
export const detached = <T>(f: () => T): T => errorScope.exit(f);
// Where a failure happened, when its catcher knows better than its surroundings say.
export type ErrorPlace = Pick<ErrorRecord, "session_id" | "turn_event" | "span_id">;
export type ErrorCapture = Pick<ErrorRecord, "id" | "source"> & { context: unknown; turnSession?: string };

// Every failure lands in one table and one live frame, whoever caught it.
export class ErrorTracker {
  private captures = new Set<(e: ErrorCapture) => void>();

  constructor(private store: Store, private bus: Bus) {}

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
      rec = this.store.recordError({ source, message: e.message, stack: e.stack, context, session_id, turn_event, span_id });
    } catch (failed) {
      console.error(`[${source}] ${e.message} (not recorded: ${(failed as Error)?.message ?? failed})`);
      const now = Date.now();
      return { id: "", source, message: e.message, stack: e.stack, context, count: 1, first_ts: now, ts: now, session_id, turn_event, span_id } as ErrorRecord;
    }
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
