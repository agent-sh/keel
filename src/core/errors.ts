import { AsyncLocalStorage } from "node:async_hooks";
import type { Bus } from "./bus.ts";
import type { Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";

export const errorSession = new AsyncLocalStorage<string>();
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

  capture(source: ErrorRecord["source"], err: unknown, context?: unknown): ErrorRecord {
    const e = err instanceof Error ? err : new Error(String(err));
    // A failed model request names its trace span on the error it threw (src/admin/trace.ts).
    const span_id = typeof (err as any)?.span_id === "string" ? (err as any).span_id : undefined;
    const rec = this.store.recordError({ source, message: e.message, stack: e.stack, context, span_id });
    this.bus.emit({ t: "error", error: rec });
    for (const listener of this.captures) {
      try { listener({ id: rec.id, source, context, turnSession: errorSession.getStore() }); } catch {}
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
