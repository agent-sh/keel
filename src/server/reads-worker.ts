// The read thread: a connection of its own to the daemon's database, opened
// read-only, that runs the named reads of read-tasks.ts and posts back what
// they return. SQLite's write-ahead log lets it read while the daemon writes.
import { Database } from "bun:sqlite";
import { tasks, type TaskName } from "./read-tasks.ts";

declare var self: Worker;

let db: Database | undefined;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { open: string } | { id: number; name: TaskName; args: unknown };
  if ("open" in m) {
    db = new Database(m.open, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return;
  }
  try {
    if (!db) throw new Error("the read thread has no database");
    const run = tasks[m.name] as ((db: Database, args: unknown) => unknown) | undefined;
    if (!run) throw new Error(`no read named ${m.name}`);
    postMessage({ id: m.id, value: run(db, m.args) });
  } catch (e) {
    postMessage({ id: m.id, error: e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) } });
  }
};
