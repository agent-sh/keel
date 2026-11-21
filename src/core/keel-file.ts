// How large a Keel file can be, shared by the daemon (export and import) and
// the page (what the Export dialog offers).

// The largest Keel file an import takes: the daemon's limit on a request's
// body (src/server/app.ts sets it, at the value Bun uses when none is set).
export const KEEL_FILE_MAX = 128 * 1024 * 1024;

// The bytes of a Keel file that carries files: its header and events, and each
// file once as a line of its own (its id, its size, its bytes in base64).
// Counted high rather than low, so a file that passes is one an import takes.
export function keelFileBytes(eventsBytes: number, fileSizes: number[]): number {
  let n = eventsBytes + 4096;
  for (const size of fileSizes) n += 4 * Math.ceil(size / 3) + 400;
  return n;
}

// A size as the page shows a file's: whole KB under one MB, then MB.
export const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);
