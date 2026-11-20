// Reading other harnesses' files: only reads, in pieces where a listing needs
// only the head and the tail of a large file.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function parseLines(text: string): any[] {
  return readLines(text).records;
}

// A whole file's records, with what could not be read: a damaged record (its
// line number, never its text) and a last record still being written (no
// newline after it and not whole JSON yet), which a later read may find whole.
export function readLines(text: string): { records: any[]; bad: number[]; unfinished: boolean } {
  const records: any[] = [];
  const bad: number[] = [];
  let unfinished = false;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const l = line.trim();
    if (!l) return;
    try { records.push(JSON.parse(l)); } catch {
      if (i === lines.length - 1) unfinished = true;
      else bad.push(i + 1);
    }
  });
  return { records, bad, unfinished };
}

// What a preview says about records a full read could not use.
export function damageNotes(r: { records: any[]; bad: number[]; unfinished: boolean }): string[] {
  const out: string[] = [];
  if (r.bad.length) {
    const at = r.bad.slice(0, 5).join(", ") + (r.bad.length > 5 ? ", ..." : "");
    out.push(`${r.records.length} records read; ${r.bad.length} damaged record${r.bad.length === 1 ? "" : "s"} could not be read (line ${at}) and ${r.bad.length === 1 ? "is" : "are"} left out.`);
  }
  if (r.unfinished) out.push("The last record is still being written: read again after the writer finishes.");
  return out;
}

// The first record of a file that `match` accepts, reading it in pieces (a
// file whose sampled head and tail hold no prompt may hold one in between).
export function scanFor<T>(path: string, match: (r: any) => T | undefined): T | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return undefined; }
  try {
    const buf = Buffer.alloc(1 << 20);
    let at = 0;
    let rest = "";
    const dec = new TextDecoder();
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, at);
      if (!got) break;
      at += got;
      const lines = (rest + dec.decode(buf.subarray(0, got), { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        let r;
        try { r = JSON.parse(l); } catch { continue; }
        const hit = match(r);
        if (hit !== undefined) return hit;
      }
    }
    if (rest.trim()) { try { return match(JSON.parse(rest)); } catch {} }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Every line of a file from its end to its start, a chunk at a time, until
// `each` returns true (a long transcript's latest records are near its end).
export function linesBack(path: string, each: (line: Buffer) => boolean): void {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(1 << 20);
    let at = fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (at > 0) {
      const len = Math.min(buf.length, at);
      at -= len;
      readSync(fd, buf, 0, len, at);
      const chunk = Buffer.concat([buf.subarray(0, len), rest]);
      // Whole lines only: the part before the first newline joins the next chunk back.
      let end = chunk.length;
      for (;;) {
        const i = end > 0 ? chunk.lastIndexOf(10, end - 1) : -1;
        if (i < 0) break;
        if (end - i > 1 && each(chunk.subarray(i + 1, end))) return;
        end = i;
      }
      rest = Buffer.from(chunk.subarray(0, end));
    }
    if (rest.length) each(rest);
  } finally {
    closeSync(fd);
  }
}

// The last record that matches, read from the end (a long transcript's latest
// reply is near its end).
export function scanBack<T>(path: string, match: (r: any) => T | undefined): T | undefined {
  let hit: T | undefined;
  linesBack(path, (l) => {
    try { hit = match(JSON.parse(l.toString("utf8"))); } catch {}
    return hit !== undefined;
  });
  return hit;
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
