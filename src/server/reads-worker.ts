// The read thread: a connection of its own to the daemon's database, opened
// read-only, that runs the named reads of read-tasks.ts and posts back what
// they return. SQLite's write-ahead log lets it read while the daemon writes.
import { Database } from "bun:sqlite";
import { tasks, type TaskName } from "./read-tasks.ts";
import { cacheStatements } from "../core/statement-cache.ts";

declare var self: Worker;

let db: Database | undefined;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { open: string } | { id: number; name: TaskName; args: unknown };
  if ("open" in m) {
    db = new Database(m.open, { readonly: true });
    cacheStatements(db);
    db.exec("PRAGMA busy_timeout = 5000");
    return;
  }
  try {
    if (!db) throw new Error("the read thread has no database");
    const run = tasks[m.name] as ((db: Database, args: unknown) => unknown) | undefined;
    if (!run) throw new Error(`no read named ${m.name}`);
    const value = run(db, m.args);
    // A read that answers with bytes names their buffers: handed to the loop, not copied.
    const transfer = (value as { transfer?: ArrayBuffer[] } | null)?.transfer;
    if (transfer) postMessage({ id: m.id, value: { ...(value as object), transfer: undefined } }, transfer);
    else postMessage({ id: m.id, value });
  } catch (e) {
    postMessage({ id: m.id, error: e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) } });
  }
};
