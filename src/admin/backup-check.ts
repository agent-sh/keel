// The check that follows a backup, as a process of its own (`keel
// backup-check`, started by the daemon: Storage.checkBackups). The job
// comes on stdin as JSON; each backup's result goes out as a line as it is
// done, then the whole.
//
// A process and not a thread, because a restart must be able to end it at
// any moment: the check holds a read transaction on the store for as long as
// SQLite's integrity check runs, and a thread that is ended in the middle of
// a statement keeps its connection, with the read lock, until the daemon
// exits. No backup after it could empty the write-ahead log, so every one
// would be a whole copy. A killed process's locks are gone with it.
import { writeSync } from "node:fs";
import { checkBackups, type CheckJob } from "./backup.ts";

export async function main(): Promise<number> {
  const say = (m: unknown) => void writeSync(1, JSON.stringify(m) + "\n");
  try {
    const job = JSON.parse(await Bun.stdin.text()) as CheckJob;
    say({ t: "done", done: checkBackups(job, (part) => say({ t: "part", part })) });
    return 0;
  } catch (e) {
    say({ t: "failed", error: (e as Error).message });
    return 1;
  }
}
