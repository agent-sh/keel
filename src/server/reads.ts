// Heavy reads off the loop. A report over the whole ledger, a search that
// ranks every match or a sum over every event is one long SQLite call: on the
// daemon's own connection it stops every session's stream for as long as it
// runs. Here such a read runs on a thread with a read-only connection of its
// own, and the loop only posts the question and takes the answer.
//
// The thread starts with the first read and ends a minute after the last, so
// an idle daemon holds neither it nor its page cache. Where the thread cannot
// run (it does not start, or dies before its first answer), reads run on the
// loop, as before.
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import { tasks, type TaskName, type Tasks } from "./read-tasks.ts";

declare const __KEEL_READS_JS__: string | undefined;

// How long the thread stays after its last read.
const IDLE_MS = 60_000;

// The thread's program: bundled into the binary as text (scripts/build.ts),
// the source file when running from source.
let program: string | undefined;
function programUrl(): string {
  if (program) return program;
  return (program = typeof __KEEL_READS_JS__ === "string"
    ? URL.createObjectURL(new Blob([__KEEL_READS_JS__], { type: "application/javascript" }))
    : new URL("./reads-worker.ts", import.meta.url).href);
}

type Waiting = { resolve: (v: any) => void; reject: (e: Error) => void; name: TaskName; args: unknown };
type Args<K extends TaskName> = Parameters<Tasks[K]>[1];
type Result<K extends TaskName> = ReturnType<Tasks[K]>;

export class Reads {
  private worker?: Worker;
  private waiting = new Map<number, Waiting>();
  private seq = 0;
  private idle?: ReturnType<typeof setTimeout>;
  // The thread has answered once: it works on this machine.
  private proved = false;
  // Reads answered, by where they ran (for tests and the resources report).
  readonly counts = { thread: 0, loop: 0 };

  // `thread` false: every read runs on the loop (unit tests of the routes).
  // `program`: another thread program than the daemon's own (a test's).
  constructor(private store: Pick<Store, "db" | "stateDir">, private thread = process.env.NODE_ENV !== "test", private program?: string) {}

  run<K extends TaskName>(name: K, args: Args<K>): Promise<Result<K>> {
    const w = this.thread ? this.start() : undefined;
    if (!w) return new Promise((resolve) => resolve(this.onLoop(name, args) as Result<K>));
    this.counts.thread++;
    clearTimeout(this.idle);
    return new Promise<Result<K>>((resolve, reject) => {
      const id = ++this.seq;
      this.waiting.set(id, { resolve, reject, name, args });
      w.postMessage({ id, name, args });
    });
  }

  private onLoop(name: TaskName, args: unknown): unknown {
    this.counts.loop++;
    return (tasks[name] as (db: Store["db"], a: unknown) => unknown)(this.store.db, args);
  }

  // The rows of one statement.
  sql<T>(sql: string, params: (string | number | null)[] = []): Promise<T[]> {
    return this.run("sql", { sql, params }) as Promise<T[]>;
  }

  private start(): Worker | undefined {
    if (this.worker) return this.worker;
    let w: Worker;
    try {
      w = new Worker(this.program ?? programUrl());
    } catch {
      this.thread = false;
      return undefined;
    }
    (w as Worker & { unref?: () => void }).unref?.(); // the thread never holds the process open
    w.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { id: number; value?: unknown; error?: { message: string; stack?: string } };
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.proved = true;
      this.waiting.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), m.error.stack ? { stack: m.error.stack } : {}));
      else p.resolve(m.value);
      if (!this.waiting.size) this.rest();
    };
    // The thread died. One that had answered before is started again by the
    // next read, and what waited on it fails. One that never answered does not
    // work here: what waited is read on the loop, and so is every read after.
    w.onerror = (ev: ErrorEvent) => {
      if (this.worker === w) this.worker = undefined;
      const waited = [...this.waiting.values()];
      this.waiting.clear();
      if (!this.proved) this.thread = false;
      for (const p of waited) {
        if (this.proved) { p.reject(new Error(`the read thread failed: ${ev.message}`)); continue; }
        try { p.resolve(this.onLoop(p.name, p.args)); } catch (e) { p.reject(e as Error); }
      }
    };
    w.postMessage({ open: join(this.store.stateDir, "keel.db") });
    return (this.worker = w);
  }

  private rest() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  close() {
    clearTimeout(this.idle);
    this.worker?.terminate();
    this.worker = undefined;
  }
}

const pools = new WeakMap<object, Reads>();
// The store's read thread (one a store).
export function readsOf(store: Pick<Store, "db" | "stateDir">): Reads {
  let r = pools.get(store);
  if (!r) pools.set(store, (r = new Reads(store)));
  return r;
}
