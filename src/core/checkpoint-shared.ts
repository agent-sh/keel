// What the daemon's loop and its checkpoint thread share (checkpoint.ts,
// checkpoint-worker.ts): the numbers the thread writes and the loop reads,
// and the values of a backup's gate.

import { readSync } from "node:fs";
import { endianness } from "node:os";

// One shared 32-bit number each. The thread writes them; nothing waits on one.
export const CELL = {
  beat: 0,       // counts the thread's ticks: one that stops is a thread that hangs
  armed: 1,      // 1 while the thread holds its mark in the log (no writer starts the log again)
  passes: 2,     // checkpoint passes made
  syncs: 3,      // syncs of the log file alone
  starts: 4,     // times the thread started the log again
  forced: 5,     // of those, with the write lock held while the rest was copied
  blocked: 6,    // tries that could not: another connection's reader used the log
  held_ms: 7,    // the write lock was held this long, in all
  held_most: 8,  // and this long at most at a time
  frames: 9,     // frames in the log at the last look
  waiting: 10,   // of them, not yet copied into the database
  most: 11,      // the most frames the log held
  tick_most: 12, // the thread's longest look at the log, with the pass and the syncs it made (ms): how slow the disk made it
  beat_at: 13,   // when the thread last ticked: the clock's milliseconds, their low 31 bits
  lock_at: 14,   // since when the thread holds the write lock (the same clock; 0: it does not)
  sync_ms: 15,   // how long the thread's last sync of its own took: how slow the disk is now
  held_syncs: 16, // syncs made in the present hold of the write lock (the log, the database, the new log's header)
  lock_soon: 17, // 1 while the thread is about to take the write lock for longer than a moment, or holds it so (a forced start of the log, a backup's snapshot)
} as const;
export const CELLS = 18;
// The clock the cells of a moment hold: milliseconds, their low 31 bits, never 0.
export const stamp = (ms = Date.now()) => (ms % 0x7fffffff) + 1;
export const since = (cell: number, ms = Date.now()) => (stamp(ms) - cell + 0x7fffffff) % 0x7fffffff;

export type Opts = {
  tickMs: number;   // the thread looks at the log this often
  syncMs: number;   // and syncs it this often at most
  at: number;       // frames waiting from which a pass is made
  soft: number;     // frames in the log from which it should start again
  hard: number;     // frames in the log from which it must
  slowHard: number; // the same while the disk is slow (a sync of the thread's own takes over slowMs)
  slowMs: number;
  lockMs: number;   // the thread's own wait for the write lock
  holdMs: number;   // how long the write lock is held for a backup's thread to begin its read
  page: number;     // the database's page size
};

// A backup's gate (src/admin/backup-worker.ts): one shared number.
export const ASKED = 0;        // the backup's thread asks for the log to be emptied
export const NOT_EMPTIED = 1;  // emptied by the daemon's own connection, or not at all: the thread looks at the log's file
export const TRIED = 2;        // the backup's thread has begun its read, or tried
export const HELD = 3;         // everything is copied and no one can write: a read begun now reads the database file alone
export const EXPIRED = 4;      // the hold is over and the backup's thread had not said its read began: a read begun from here is not that snapshot
// HELD ends by one swap, whoever makes it first. The backup's thread begins
// its read and then swaps HELD to TRIED: if the swap is its own, the read
// began while the write lock was held. The checkpoint thread, when its wait
// is over, swaps HELD to EXPIRED and gives the lock up only after that: a
// backup's thread that was held up finds EXPIRED, ends its read and asks again.

// The log's index (walformat.html, "WAL-Index Header"), read from a
// descriptor of the -shm file: the newest frame at byte 16 and the log's
// salt at byte 32 of the header, which is kept twice (again from byte 48),
// then the frames copied into the database at byte 96. A header read while a
// writer changes it shows in the two copies differing: it is read again.
export type LogIndex = { frames: number; copied: number; salt: number };
const LE = endianness() === "LE";
export function logIndex(fd: number, buf = Buffer.alloc(136)): LogIndex | undefined {
  const u32 = (at: number) => (LE ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  for (let n = 0; n < 4; n++) {
    if (readSync(fd, buf, 0, 136, 0) < 136) return undefined;
    if (u32(16) === u32(64) && u32(32) === u32(80)) break;
  }
  const frames = u32(16), copied = u32(96);
  return { frames, copied: Math.min(copied, frames), salt: u32(32) };
}
