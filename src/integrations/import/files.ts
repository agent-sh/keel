// Reading other harnesses' files: only reads, in pieces where a listing needs
// only the head and the tail of a large file.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

// The whole records in the first and last `n` bytes of a file (a cut line at
// either edge is dropped).
export function headTail(path: string, n: number): { head: any[]; tail: any[] } {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { head: [], tail: [] }; }
  try {
    const size = fstatSync(fd).size;
    const read = (at: number, len: number) => {
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, at);
      return buf.subarray(0, got).toString("utf8");
    };
    if (size <= 2 * n) {
      const all = parseLines(read(0, size));
      return { head: all, tail: all };
    }
    const h = read(0, n);
    const t = read(size - n, n);
    return { head: parseLines(h.slice(0, h.lastIndexOf("\n"))), tail: parseLines(t.slice(t.indexOf("\n") + 1)) };
  } finally {
    closeSync(fd);
  }
}
