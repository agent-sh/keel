// The worker a backup is made in: the copy, its hashes and its checks take
// seconds on a large store, and none of it may run on the daemon's event loop.
// One job per worker: it answers once and the daemon ends it.
import { makeBackup, type BackupJob } from "./backup.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<BackupJob>) => {
  try {
    self.postMessage({ ok: true, done: makeBackup(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message });
  }
};
