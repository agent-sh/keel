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

// The bytes before a saved place it is tied to as well: a file cut or edited while no daemon watched it, and
// grown past the place since, keeps its first bytes but not these.
export const TAIL_BYTES = 4096;

export type SavedRead = { harness: OutsideHarness; offset: number; head_len: number; head: string; tail: string; reader: ReaderState };

// The hash of a transcript's first bytes (at most HEAD_BYTES, and never past the place saved).
export const headHash = (bytes: Uint8Array): string => Bun.hash(bytes).toString(36);

// The length of the head a place at `offset` is tied to.
export const headLen = (offset: number) => Math.min(HEAD_BYTES, offset);

// The bytes a tail hash of a place at `offset` covers: [offset - tailLen(offset), offset).
export const tailLen = (offset: number) => Math.min(TAIL_BYTES, offset);

// The hash of the bytes that end at a place, only when they end a line (a place is always after a newline);
// undefined otherwise, and for no bytes.
export function tailHash(bytes: Uint8Array): string | undefined {
  return bytes.length && bytes[bytes.length - 1] === 10 ? Bun.hash(bytes).toString(36) : undefined;
}

// Where a transcript is read from: the saved place when the file is still the one it was saved of (its harness,
// a reader state of this build's shape, the same first bytes, the same bytes up to the place ending a line, and
// at least as long), else its start (0). `tail` is tailHash of the file's bytes before the saved place.
export function resumeAt(saved: SavedRead | undefined, file: { harness: OutsideHarness; size: number; head: string; tail: string | undefined }): number {
  if (!saved || saved.harness !== file.harness || saved.offset <= 0) return 0;
  if (saved.reader?.v !== READER_V || saved.reader.h !== file.harness) return 0;
  if (file.size < saved.offset || file.head !== saved.head) return 0;
  if (!saved.tail || file.tail !== saved.tail) return 0;
  return saved.offset;
}

// The place after the last whole line of what was read: `start` is where `bytes` began in the file. A newline
// byte is never part of a longer UTF-8 character, so the place is exact whatever the text. Undefined: no
// whole line ended in these bytes.
export function lineEnd(start: number, bytes: Uint8Array): number | undefined {
  const nl = bytes.lastIndexOf(10);
  return nl < 0 ? undefined : start + nl + 1;
}
