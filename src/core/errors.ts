import type { Bus } from "./bus.ts";
import type { Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";

// Every failure lands in one table and one live frame, whoever caught it.
export class ErrorTracker {
  constructor(private store: Store, private bus: Bus) {}

  capture(source: ErrorRecord["source"], err: unknown, context?: unknown): ErrorRecord {
    const e = err instanceof Error ? err : new Error(String(err));
    const rec = this.store.recordError({ source, message: e.message, stack: e.stack, context });
    this.bus.emit({ t: "error", error: rec });
    console.error(`[${source}] ${e.message}`);
    return rec;
  }

  installGlobal() {
    process.on("uncaughtException", (e) => this.capture("server", e, { kind: "uncaughtException" }));
    // The reason's type and code say where a stack-less rejection came from.
    process.on("unhandledRejection", (e: any) => this.capture("server", e, { kind: "unhandledRejection", type: e?.constructor?.name, code: e?.code, where: e?.where }));
  }
}
