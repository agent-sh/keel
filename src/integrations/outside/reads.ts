// Where the outside watcher (src/integrations/outside/service.ts) reads a transcript on from after a restart.
// A reader keeps only what the next record can change (src/integrations/outside/facts.ts), so its state and
// the place after the last whole line it read are enough to go on: a start reads what a transcript gained
// since, not the whole file again. A Codex rollout or a Claude Code transcript of a long session is tens of
// megabytes, and every start read each live one whole, parsing every record at once. Pure: the service reads
// the file's head and size and stores the rows.
import { READER_V, type OutsideHarness, type ReaderState } from "./facts.ts";

// The bytes of a transcript's start its saved place is tied to: a file written again from its start (a new
// session at the same path, a rewrite) differs there.
export const HEAD_BYTES = 4096;
// A saved place is written at most this often while its transcript grows, and when the watch stops.
export const SAVE_MS = 30_000;

export type SavedRead = { harness: OutsideHarness; offset: number; head_len: number; head: string; reader: ReaderState };

// The hash of a transcript's first bytes (at most HEAD_BYTES, and never past the place saved).
export const headHash = (bytes: Uint8Array): string => Bun.hash(bytes).toString(36);

// The length of the head a place at `offset` is tied to.
export const headLen = (offset: number) => Math.min(HEAD_BYTES, offset);

// Where a transcript is read from: the saved place when the file is still the one it was saved of (its harness,
// a reader state of this build's shape, the same first bytes, and at least as long), else its start (0).
export function resumeAt(saved: SavedRead | undefined, file: { harness: OutsideHarness; size: number; head: string }): number {
  if (!saved || saved.harness !== file.harness || saved.offset <= 0) return 0;
  if (saved.reader?.v !== READER_V || saved.reader.h !== file.harness) return 0;
  if (file.size < saved.offset || file.head !== saved.head) return 0;
  return saved.offset;
}

// The place after the last whole line of what was read: `start` is where `bytes` began in the file. A newline
// byte is never part of a longer UTF-8 character, so the place is exact whatever the text. Undefined: no
// whole line ended in these bytes.
export function lineEnd(start: number, bytes: Uint8Array): number | undefined {
  const nl = bytes.lastIndexOf(10);
  return nl < 0 ? undefined : start + nl + 1;
}
