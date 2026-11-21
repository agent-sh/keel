// The worker a backup is made in: the copy, its hashes and its checks take
// seconds on a large store, and none of it may run on the daemon's event loop.
// One job per worker. It asks the daemon to empty its write-ahead log
// ("checkpoint") and takes its read snapshot (see Snapshot in backup.ts)
// while the daemon holds still for it: the two meet on `gate`, a shared
// number (0: asked, 1: the log was emptied, 2: the snapshot was tried). A
// snapshot that is not the database file alone is asked for once more, then
// the backup is made from a copy instead. It answers once and the daemon
// ends it.
import { makeBackup, Snapshot, type BackupJob } from "./backup.ts";

declare const self: Worker;

const TRIES = 2;
const DAEMON_MS = 10_000; // for the daemon to answer: it may be in a long step of its own

self.onmessage = (e: MessageEvent<{ job: BackupJob; gate: Int32Array }>) => {
  const { job, gate } = e.data;
  let snap: Snapshot | undefined;
  try {
    snap = new Snapshot(job.stateDir);
    let held = false;
    for (let i = 0; i < TRIES && !held; i++) {
      snap.flush();
      Atomics.store(gate, 0, 0);
      self.postMessage({ t: "checkpoint" });
      if (Atomics.wait(gate, 0, 0, DAEMON_MS) === "timed-out") break;
      held = snap.begin();
      Atomics.store(gate, 0, 2);
      Atomics.notify(gate, 0);
    }
    if (!held) {
      snap.close();
      snap = undefined;
    }
    self.postMessage({ t: "done", done: makeBackup(job, snap) });
  } catch (err) {
    snap?.close();
    self.postMessage({ t: "failed", error: (err as Error).message });
  }
};
