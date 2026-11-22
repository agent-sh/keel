// File operations every family's tools share: reading pages of text, images,
// PDFs and notebooks; exact-string edits with the quote and line-ending
// tolerance models need; the read-before-overwrite guard; glob and ripgrep.
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { atCwd, canonical, contains, realOf } from "../core/paths.ts";
import { heldFile, heldWrite } from "../core/store-files.ts";
import type { ImageBlock, TextBlock } from "../core/types.ts";
import { notFound } from "./missing.ts";
import type { ToolContext } from "./types.ts";
import { removedNote } from "./spill.ts";
import { readText } from "../core/proc.ts";
import { decodeText, textEncoding } from "../core/text.ts";

// The file a tool's path names, as the kernel reaches it (links followed, `..` applied where the walk stands): the
// path the gate judged (realOf), and the one every file tool opens, so the two cannot differ.
export const abs = (p: string, ctx: ToolContext) => realOf(atCwd(ctx.cwd, p));
export const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };

// ---- the file a tool opens is the file that was judged ----------------------

// Between the gate's look at a path and a tool's open of it, a command that
// runs beside the call can change what the name is: a file becomes a link to
// a key, a folder above it becomes a link. So a file tool never opens a name
// and hopes: it holds the file.
//
// - The path must be canonical (no link, `.` or `..` in it: what realOf
//   answers for a path the kernel takes) and one the gate judged for this
//   call (`ctx.judged`: the files the call's class named, where they are).
// - Its folder is opened and what was opened is compared with the path (the
//   descriptor's own path, /proc/self/fd): a folder swapped for a link is
//   not the folder that was judged.
// - The file is opened inside that folder without following a link at its
//   name (O_NOFOLLOW), or created there and only there (O_EXCL).
// - What the tool then reads and writes is that descriptor (`io`, the
//   descriptor's path: every read and write of this module goes through
//   ioOf), so no name is looked up again.
//
// Where the descriptor's path cannot be read (no /proc: not Linux) the path
// is checked to be canonical and judged, and then opened by its name.
export type Held = { path: string; io: string; existed: boolean; beside(name: string): string; close(): void };
const PROC = existsSync("/proc/self/fd");
const held = new Map<string, string[]>();
// The path to do I/O on for a file a call holds: its descriptor's. A path nothing holds is itself.
export const ioOf = (p: string) => held.get(p)?.at(-1) ?? p;
const moved = (p: string, how: string) => ({ refused: `${p} is not the file this call was checked for: ${how}. Nothing was read or written. If the file changed while the call ran, call again.` });

// What the gate judged lately for each session: the paths of the calls it let run, for a moment. A caller that runs
// a tool for a session without the context the gate's hook made (no `judged`) is held to these: a tool run for a
// session opens nothing its gate did not just clear.
const LATELY_MS = 30_000;
const lately = new Map<string, Map<string, number>>();
export function noteJudged(sessionId: string, paths: string[]) {
  const now = Date.now();
  let m = lately.get(sessionId);
  if (!m) { if (lately.size > 512) lately.clear(); lately.set(sessionId, (m = new Map())); }
  if (m.size > 256) for (const [k, at] of m) if (at < now) m.delete(k);
  for (const p of paths) m.set(p, now + LATELY_MS);
}
function clearedFor(ctx: HoldContext, p: string): boolean {
  const within = (paths: Iterable<string>) => { for (const j of paths) if (j === p || contains(j, p)) return true; return false; };
  if (ctx.judged) return within(ctx.judged);
  // (No gate has judged a file for this session in this process: nothing to hold the call to.)
  const m = ctx.sessionId ? lately.get(ctx.sessionId) : undefined;
  if (!m) return true;
  const now = Date.now();
  return within([...m].filter(([, at]) => at >= now).map(([k]) => k));
}
export type HoldContext = { judged?: string[]; sessionId?: string };

export function hold(given: string, ctx: HoldContext, how: "read" | "write" | "folder"): Held | { refused: string } {
  // (A caller that names the file through a link: where it is. The tools pass what realOf answered already.)
  const p = canonical(given) ? given : realOf(given);
  // The daemon's own store and claim are never opened from inside the daemon, by any name: closing a descriptor of
  // such a file gives up the lock the daemon holds on it.
  { const kept = heldFile(p); if (kept) return { refused: kept }; }
  if (!canonical(p)) {
    // (A path the kernel refuses is answered by realOf as it was given: say what the kernel says of it.)
    let why = "its path holds a link or a `..`";
    try { statSync(p); } catch (e) { why = `the path cannot be opened (${(e as NodeJS.ErrnoException).code ?? "it failed"})`; }
    return moved(p, why);
  }
  const cleared = clearedFor(ctx, p);
  // (A read of a name that is not there says so in the tool's own words.)
  if (!cleared && (how !== "read" || existsSync(p))) return moved(p, "the path it names changed between the check and the open");
  const none = (): Held => ({ path: p, io: p, existed: false, beside: (name) => join(dirname(p), name), close() {} });
  if (!PROC) return { ...none(), existed: existsSync(p) };
  const dir = dirname(p), base = basename(p);
  const fds: number[] = [];
  const close = () => { for (const fd of fds.splice(0)) try { closeSync(fd); } catch {} };
  try {
    if (how !== "read") mkdirSync(dir, { recursive: true });
    let dfd: number;
    try { dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY); } catch (e) {
      if (how === "read" && (e as NodeJS.ErrnoException).code === "ENOENT") return none();
      throw e;
    }
    fds.push(dfd);
    if (readlinkSync(`/proc/self/fd/${dfd}`) !== dir) { close(); return moved(p, "its folder is somewhere else now (a link took the place of a folder)"); }
    const beside = (name: string) => `/proc/self/fd/${dfd}/${name}`;
    let io = beside(base), existed = true;
    if (how !== "folder") {
      let fd: number | undefined;
      // (O_NONBLOCK: a pipe with no writer does not hold the call; a regular file is not affected.)
      try { fd = openSync(beside(base), (how === "read" ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "EMLINK") { close(); return moved(p, "it is a link now"); }
        if (code !== "ENOENT") {
          // (A folder for a write, a file that may not be read or written: the tool says it in its own words, by the name inside the held folder.)
          existed = existsSync(beside(base));
        } else {
          existed = false;
          if (how === "write") fd = openSync(beside(base), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
        }
      }
      if (fd !== undefined) { fds.push(fd); io = `/proc/self/fd/${fd}`; }
    }
    const names = [...new Set([p, given])];
    for (const n of names) held.set(n, [...(held.get(n) ?? []), io]);
    return {
      path: p, io, existed, beside,
      close() {
        for (const n of names) {
          const l = held.get(n);
          if (l) { const i = l.lastIndexOf(io); if (i >= 0) l.splice(i, 1); if (!l.length) held.delete(n); }
        }
        close();
      },
    };
  } catch (e) {
    close();
    return { refused: `${p} could not be opened: ${(e as Error).message}` };
  }
}

export const READ_CHARS = 100_000;     // about 25k tokens: one read page
export const WHOLE_FILE_BYTES = 256 * 1024;
const LINE_CAP = 2000;
const BINARY = new Set([".zip", ".gz", ".tgz", ".xz", ".zst", ".7z", ".tar", ".xlsx", ".xls", ".docx", ".pptx", ".parquet",
  ".heic", ".so", ".o", ".a", ".dylib", ".exe", ".bin", ".class", ".jar", ".wasm", ".pyc", ".sqlite", ".db", ".mp3", ".mp4",
  ".mov", ".avi", ".mkv", ".flac", ".wav", ".ttf", ".otf", ".woff", ".woff2", ".ico", ".safetensors", ".gguf", ".pt", ".npy"]);
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export type ReadResult = { content: string | (TextBlock | ImageBlock)[]; error?: boolean; partial?: boolean };

// Lines `offset`.. of a text file, numbered from 1 (`N<tab>line`), cut to one
// page; the result says where to continue.
export function numbered(text: string, offset = 1, limit?: number, number = true, maxChars = READ_CHARS): { body: string; partial: boolean; total: number } {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = Math.max(1, offset);
  const end = Math.min(total, limit ? start - 1 + limit : total);
  const out: string[] = [];
  let size = 0;
  let last = start - 1;
  for (let i = start; i <= end; i++) {
    let l = lines[i - 1]!;
    if (l.length > LINE_CAP) l = l.slice(0, LINE_CAP) + ` [line cut at ${LINE_CAP} of ${l.length} chars]`;
    const row = number ? `${i}\t${l}` : l; // compact: the padding cost ~5% of a read
    if (size + row.length > maxChars && out.length) break;
    out.push(row);
    size += row.length + 1;
    last = i;
  }
  let body = out.join("\n");
  const partial = last < total && (!limit || last < end);
  if (partial) body += `\n\nPARTIAL view: lines ${start}-${last} of ${total}. Continue with offset ${last + 1}.`;
  return { body, partial, total };
}

const CHUNK = 64 * 1024;

// Lines `offset`.. of a text file of any size, as numbered() gives them, read
// in chunks of 64 KB. The lines before the range are counted and dropped, a
// long line keeps only the part shown, and the read ends with the page: the
// rest of the file is not read, and nothing held grows with the file. `total`
// is the file's line count when the scan reached its end (`past`: the offset
// lies beyond it); a page cut before that says where to continue without it.
// `signal` stops a scan on its way to a far offset. (A limit below 1 is
// refused by the tools before a file is read: readFile, read_file.)
export async function lineRange(p: string, o: { offset?: number; limit?: number; number?: boolean; maxChars?: number; signal?: AbortSignal } = {}): Promise<{ body: string; partial: boolean; total?: number; past?: boolean; stopped?: boolean; bytes: number }> {
  const start = Math.max(1, o.offset ?? 1);
  const end = o.limit ? start - 1 + o.limit : Infinity;
  const maxChars = o.maxChars ?? READ_CHARS;
  const out: string[] = [];
  let size = 0;
  let line = 1;   // the line being read
  let head = "";  // its first LINE_CAP characters, kept only inside the range
  let len = 0;    // its length so far
  let last = start - 1;
  let cut = false;
  // The line read is over: it joins the page unless the page is full. False ends the read.
  const close = () => {
    if (line >= start) {
      const l = len > LINE_CAP ? `${head} [line cut at ${LINE_CAP} of ${len} chars]` : head;
      const row = o.number === false ? l : `${line}\t${l}`;
      if (size + row.length > maxChars && out.length) return !(cut = true);
      out.push(row);
      size += row.length + 1;
      last = line;
    }
    line++;
    head = "";
    len = 0;
    return line <= end;
  };
  const fh = await open(ioOf(p), "r");
  let bytes = 0; // the file's size when the read began
  const buf = new Uint8Array(CHUNK);
  let pos = 0;
  let ended = false;
  let stopped = false;
  try {
    bytes = (await fh.stat()).size;
    let dec: TextDecoder | undefined;
    scan: for (;;) {
      if (o.signal?.aborted) { stopped = true; break; }
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      const chunk = buf.subarray(0, bytesRead);
      dec ??= new TextDecoder(textEncoding(chunk).encoding);
      const text = dec.decode(chunk, { stream: bytesRead > 0 });
      pos += bytesRead;
      for (let i = 0; i < text.length; ) {
        const nl = text.indexOf("\n", i);
        const to = nl < 0 ? text.length : nl;
        if (line >= start && head.length < LINE_CAP) head += text.slice(i, Math.min(to, i + LINE_CAP - head.length));
        len += to - i;
        if (nl < 0) break;
        if (!close()) break scan;
        i = nl + 1;
      }
      if (!bytesRead) {
        // The end of the file: a last line without a line end is a line too.
        if (len) close();
        ended = true;
        break;
      }
    }
  } finally {
    await fh.close();
  }
  const total = ended ? line - 1 : undefined;
  let body = out.join("\n");
  // Cut by its size before the range's end: where to go on, without the line count a whole read would take.
  // The file's scale is said by bytes instead: how far into it the page ends.
  const share = bytes > 0 ? `, ending ${Math.min(99, Math.max(1, Math.round((pos / bytes) * 100)))}% into the file's ${bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`}` : "";
  if (cut) body += `\n\nPARTIAL view: lines ${start}-${last}${share}. Continue with offset ${last + 1}.`;
  return { body, partial: cut, total, past: total !== undefined && start > total, stopped, bytes: pos };
}

// `large` (Claude Code's allow_large): a text read sized to the context left
// (ctx.room) instead of one page and the whole-file limit.
export async function readFile(p: string, ctx: ToolContext, o: { offset?: number; limit?: number; pages?: string; large?: boolean } = {}): Promise<ReadResult> {
  // The file is held for the whole read: what is read is the file that was judged (hold).
  const h = hold(p, ctx, "read");
  if ("refused" in h) return { content: h.refused, error: true };
  try { return await readHeld(p, ctx, o); } finally { h.close(); }
}
async function readHeld(p: string, ctx: ToolContext, o: { offset?: number; limit?: number; pages?: string; large?: boolean }): Promise<ReadResult> {
  let st;
  // A spilled output the storage retention removed is said to be that, not a file that never was.
  try { st = statSync(ioOf(p)); } catch { return { content: removedNote(p, ctx.spillDir) ?? notFound(p, ctx.cwd), error: true }; }
  if (st.isDirectory()) return { content: `${p} is a directory. List it with the shell (ls).`, error: true };
  // A count of lines: one below 1 reads nothing, and an empty result with no reason reads as an empty file.
  if (o.limit !== undefined && o.limit < 1) return { content: `limit is the number of lines to read, 1 or more (it was ${o.limit}). Leave it out to read on from the offset.`, error: true };
  { const held = heldFile(p); if (held) return { content: held, error: true }; }
  // (Its kind by its name; its bytes from the file held.)
  const f = Bun.file(ioOf(p), { type: Bun.file(p).type });
  const ext = extname(p).toLowerCase();
  if (IMAGE.test(f.type)) {
    if (st.size > 20 * 1024 * 1024) return { content: `${p} is ${(st.size / 1048576).toFixed(0)} MB; resize it (e.g. magick) and read the copy.`, error: true };
    ctx.seen.set(p, st.mtimeMs);
    // Scaled to what Keel stores before it enters the history (src/engine/image-fit.ts).
    return { content: [{ type: "image", media_type: f.type, data: Buffer.from(await f.arrayBuffer()).toString("base64"), path: p }] };
  }
  if (ext === ".pdf") return readPdf(p, ctx, o.pages);
  if (ext === ".ipynb") return readNotebook(p, ctx);
  if (BINARY.has(ext)) return { content: `${p} is a binary file (${ext}); read it with a script or tool for that format.`, error: true };
  // About four characters a token; a quarter of the room stays for the work after the read.
  const roomChars = o.large && ctx.room ? Math.floor(ctx.room * 0.75) * 4 : 0;
  if (o.large && st.size > roomChars) {
    return { content: `${p} is ${(st.size / 1024).toFixed(0)} KB, more than the context left can take (about ${ctx.room ?? 0} tokens). Read a range with offset and limit, or search it.`, error: true };
  }
  if (!o.large && !o.offset && !o.limit && st.size > WHOLE_FILE_BYTES) {
    return { content: `${p} is ${(st.size / 1024).toFixed(0)} KB, over the ${WHOLE_FILE_BYTES / 1024} KB whole-file limit. Read a part with offset and limit, or search it.`, error: true };
  }
  if (!o.large && st.size > WHOLE_FILE_BYTES) {
    // A range of a file too large to read whole: only the lines up to the page's end are read.
    const r = await lineRange(p, { offset: o.offset, limit: o.limit, signal: ctx.signal });
    if (r.stopped) return { content: `The read of ${p} was stopped before it reached line ${Math.max(1, o.offset ?? 1)}.`, error: true };
    ctx.seen.set(p, st.mtimeMs);
    if (r.past) return { content: `${p} has ${r.total} lines; offset ${o.offset} is past the end.`, error: true };
    return { content: r.body, partial: r.partial };
  }
  const { text } = decodeText(new Uint8Array(await f.arrayBuffer()));
  ctx.seen.set(p, st.mtimeMs);
  if (!text) return { content: `${p} exists but is empty.` };
  const r = numbered(text, o.offset, o.limit, true, o.large ? roomChars : READ_CHARS);
  if (o.offset && o.offset > r.total) return { content: `${p} has ${r.total} lines; offset ${o.offset} is past the end.`, error: true };
  return { content: r.body, partial: r.partial };
}

function pageRange(spec: string, count: number): [number, number] | string {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
  if (!m) return `pages must look like "3" or "1-5", not "${spec}".`;
  const a = Number(m[1]), b = Number(m[2] ?? m[1]);
  if (a < 1 || b < a) return `pages "${spec}" is not a range.`;
  if (a > count) return `The PDF has ${count} pages.`;
  if (b - a >= 20) return "Read at most 20 pages at a time.";
  return [a, Math.min(b, count)];
}

async function run(argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
  return { out, err, code };
}

// A PDF: short ones whole as text (far cheaper than page images); a page
// range as images of those pages, for layout, figures and scans.
async function readPdf(p: string, ctx: ToolContext, pages?: string): Promise<ReadResult> {
  if (!Bun.which("pdfinfo")) return { content: "Reading PDFs needs poppler-utils (pdfinfo, pdftotext, pdftoppm).", error: true };
  const info = await run(["pdfinfo", p]);
  const count = Number(/Pages:\s+(\d+)/.exec(info.out)?.[1] ?? 0);
  ctx.seen.set(p, mtime(p));
  if (!pages) {
    if (count > 10) return { content: `${p} has ${count} pages. Read it in ranges with pages, e.g. "1-5" (at most 20 at a time).`, error: true };
    const t = await run(["pdftotext", "-layout", "-enc", "UTF-8", p, "-"]);
    if (t.code !== 0) return { content: `pdftotext failed: ${t.err.trim()}`, error: true };
    if (t.out.trim()) return { content: `PDF, ${count} pages, as text:\n\n${numbered(t.out, 1, undefined, false).body}` };
    pages = `1-${Math.max(1, count)}`; // a scan: no text layer, so look at it
  }
  const r = pageRange(pages, count);
  if (typeof r === "string") return { content: r, error: true };
  if (!Bun.which("pdftoppm")) return { content: "pdftoppm is not installed (poppler-utils).", error: true };
  const dir = join(ctx.spillDir, "pdf", `${Bun.hash(p + mtime(p)).toString(36)}`);
  await mkdir(dir, { recursive: true });
  const t = await run(["pdftoppm", "-png", "-r", "100", "-f", String(r[0]), "-l", String(r[1]), p, join(dir, "p")]);
  if (t.code !== 0) return { content: `pdftoppm failed: ${t.err.trim()}`, error: true };
  const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
  const blocks: (TextBlock | ImageBlock)[] = [{ type: "text", text: `PDF ${p}, pages ${r[0]}-${r[1]} of ${count}:` }];
  for (const f of files) {
    const n = Number(/(\d+)\.png$/.exec(f)?.[1]);
    if (n < r[0] || n > r[1]) continue;
    blocks.push({ type: "image", media_type: "image/png", data: Buffer.from(await Bun.file(join(dir, f)).arrayBuffer()).toString("base64") });
  }
  return { content: blocks };
}

const srcText = (s: unknown) => (Array.isArray(s) ? s.join("") : String(s ?? ""));

async function readNotebook(p: string, ctx: ToolContext): Promise<ReadResult> {
  const st = statSync(ioOf(p));
  if (st.size > 100 * 1024 * 1024) return { content: `${p} is over 100 MB; read a slice of its cells with jq.`, error: true };
  let nb: any;
  try { nb = JSON.parse(await Bun.file(ioOf(p)).text()); } catch (e) { return { content: `${p} is not valid notebook JSON: ${(e as Error).message}`, error: true }; }
  ctx.seen.set(p, st.mtimeMs);
  const blocks: (TextBlock | ImageBlock)[] = [];
  let text = "";
  (nb.cells ?? []).forEach((c: any, i: number) => {
    const id = c.id ?? `cell-${i}`;
    text += `<cell id="${id}">${c.cell_type === "markdown" ? "<cell_type>markdown</cell_type>" : ""}${srcText(c.source)}</cell id="${id}">\n`;
    for (const o of c.outputs ?? []) {
      if (o.text) text += srcText(o.text) + "\n";
      else if (o.data?.["text/plain"]) text += srcText(o.data["text/plain"]) + "\n";
      else if (o.ename) text += `${o.ename}: ${o.evalue}\n`;
      if (o.data?.["image/png"]) {
        // (A cell's second image has no text before it: an empty text block is refused by the Anthropic wire.)
        if (text) blocks.push({ type: "text", text });
        text = "";
        blocks.push({ type: "image", media_type: "image/png", data: String(o.data["image/png"]).replace(/\s/g, "") });
      }
    }
  });
  if (text) blocks.push({ type: "text", text });
  const size = blocks.reduce((n, b) => n + (b.type === "text" ? b.text.length : 0), 0);
  if (size > WHOLE_FILE_BYTES) return { content: `The notebook's cells come to ${(size / 1024).toFixed(0)} KB; read a slice with jq '.cells[0:10]'.`, error: true };
  return { content: blocks.length === 1 && blocks[0]!.type === "text" ? (blocks[0] as TextBlock).text : blocks };
}

// Overwriting a whole file the model has not seen loses work it does not know
// about: the first try shows the file and marks it seen, so the next applies.
export function guardOverwrite(p: string, ctx: ToolContext): string | null {
  const m = mtime(p);
  if (m === -1) return heldWrite(p) ?? null;
  { const held = heldWrite(p); if (held) return held; }
  const seen = ctx.seen.get(p);
  if (seen === undefined) {
    ctx.seen.set(p, m);
    let head = "";
    const h = hold(p, ctx, "read");
    if ("refused" in h) return h.refused;
    try { head = readFileSync(h.io, "utf8").slice(0, 2000); } catch {} finally { h.close(); }
    return `${p} exists and was not read in this session. Its start is below; write again to replace it.\n\n${head}`;
  }
  if (seen !== m) return `${p} changed on disk since it was read. Read it again before replacing it.`;
  return null;
}

// Writes a file. It answers with words when the write was refused (the tool gives them to the model as its result).
export async function writeFile(p: string, content: string, ctx: ToolContext): Promise<string | undefined> {
  { const held = heldWrite(p); if (held) throw new Error(held); }
  // The file is held while it is written: made in its folder and nowhere else when it is new, the same file when
  // it is there (hold).
  const h = hold(p, ctx, "write");
  if ("refused" in h) return h.refused;
  try {
    let mode: number | undefined;
    if (h.existed) try { mode = statSync(h.io).mode; } catch {}
    await Bun.write(h.io, content);
    if (mode !== undefined) chmodSync(h.io, mode & 0o7777);
  } finally { h.close(); }
  ctx.seen.set(p, mtime(p));
  return undefined;
}

// ---- exact-string edits ----------------------------------------------------

const CURLY: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };
const straighten = (s: string) => s.replace(/[‘’“”]/g, (c) => CURLY[c]!);

function count(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (!needle) return at;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

// Straight quotes of the new text written the way the file writes them.
function curlLike(s: string, sample: string): string {
  const dq = /[“”]/.test(sample), sq = /[‘’]/.test(sample);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!, prev = s[i - 1] ?? " ";
    const opening = /[\s([{<\u2014-]/.test(prev);
    if (c === '"' && dq) out += opening ? "“" : "”";
    else if (c === "'" && sq) out += /\w/.test(prev) && /\w/.test(s[i + 1] ?? "") ? "’" : opening ? "‘" : "’";
    else out += c;
  }
  return out;
}

export type EditResult = { text: string; count: number; note?: string } | { error: string };

// Replace old with new in text. The exact text wins; then the same text
// with CRLF line ends; then a match that differs only in curly quotes, whose
// new text takes the file's quote style.
export function applyEdit(text: string, oldS: string, newS: string, all = false): EditResult {
  if (oldS === newS) return { error: "old_string and new_string are the same; nothing to change." };
  if (oldS === "") return { error: "old_string is empty. To create or replace a whole file use the write tool." };
  const crlf = text.includes("\r\n") && !oldS.includes("\r\n");
  const o = crlf ? oldS.replace(/\n/g, "\r\n") : oldS;
  // The new text takes the file's line ends whichever it came with.
  const n = crlf ? newS.replace(/\r?\n/g, "\r\n") : newS;
  let hits = count(text, o);
  let repl = (_at: number) => n;
  let note: string | undefined;
  if (!hits.length) {
    const flat = straighten(text);
    hits = count(flat, straighten(o));
    if (hits.length) {
      repl = (at) => curlLike(n, text.slice(at, at + o.length));
      note = "matched with the file's curly quotes";
    }
  }
  if (!hits.length) {
    // Codex's patch matcher tolerates trailing whitespace on each line; a
    // single such match is safe to take.
    const loose = looseMatch(text, o);
    if (loose) return splice(text, [loose.at], loose.len, () => n, "matched ignoring trailing whitespace");
    return { error: `old_string was not found in the file.${nearMiss(text, o)}` };
  }
  if (hits.length > 1 && !all) {
    const lines = hits.slice(0, 5).map((at) => text.slice(0, at).split("\n").length);
    return { error: `old_string matches ${hits.length} places (lines ${lines.join(", ")}${hits.length > 5 ? ", ..." : ""}). Add surrounding lines to pick one, or set replace_all.` };
  }
  return splice(text, hits, o.length, repl, note);
}

function splice(text: string, hits: number[], len: number, repl: (at: number) => string, note?: string): EditResult {
  let out = "";
  let last = 0;
  for (const at of hits) {
    out += text.slice(last, at) + repl(at);
    last = at + len;
  }
  return { text: out + text.slice(last), count: hits.length, note };
}

const lineStarts = (text: string) => {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
};

// The one place where old matches line by line once trailing whitespace is
// ignored, as a character range of the file; null when none or several.
function looseMatch(text: string, old: string): { at: number; len: number } | null {
  const want = old.split("\n").map((l) => l.trimEnd());
  if (want.length && want[want.length - 1] === "" && old.endsWith("\n")) want.pop();
  if (!want.some((l) => l.trim())) return null;
  const lines = text.split("\n").map((l) => l.trimEnd());
  const starts = lineStarts(text);
  let found = -1;
  for (let i = 0; i + want.length <= lines.length; i++) {
    let k = 0;
    while (k < want.length && lines[i + k] === want[k]) k++;
    if (k < want.length) continue;
    if (found !== -1) return null;
    found = i;
  }
  if (found === -1) return null;
  const end = found + want.length;
  const stop = end < starts.length ? starts[end]! - (old.endsWith("\n") ? 0 : 1) : text.length;
  return { at: starts[found]!, len: stop - starts[found]! };
}

// Where old_string almost matches: the window of the file that shares the
// most lines with it and the first line that differs, so the model can fix
// its text without reading the file again.
export function nearMiss(text: string, old: string): string {
  const want = old.split("\n");
  const lines = text.split("\n");
  const at = new Map<string, number[]>();
  lines.forEach((l, i) => { const k = l.trim(); if (k) (at.get(k) ?? at.set(k, []).get(k)!).push(i); });
  const votes = new Map<number, number>();
  want.forEach((l, k) => { for (const i of at.get(l.trim()) ?? []) votes.set(i - k, (votes.get(i - k) ?? 0) + 1); });
  let best = -1, score = 0;
  for (const [s, v] of votes) if (v > score || (v === score && s < best)) { best = s; score = v; }
  if (best < 0 || score < Math.max(1, Math.ceil(want.length / 2))) {
    return " No part of the file is close to it. Read the file again and copy the text exactly, including indentation.";
  }
  let differ = 0, first = -1;
  for (let k = 0; k < want.length; k++) if (lines[best + k] !== want[k]) { differ++; if (first < 0) first = k; }
  const show = (s: string | undefined) => JSON.stringify((s ?? "<end of file>").slice(0, 200));
  const why = first >= 0 && lines[best + first]?.trim() === want[first]!.trim() ? " (only whitespace differs)" : "";
  return ` The closest text is lines ${best + 1}-${best + want.length} of the file, where ${differ} of ${want.length} lines differ. ` +
    `First difference, file line ${best + first + 1}${why}:\n  file:       ${show(lines[best + first])}\n  old_string: ${show(want[first])}`;
}

// What an edit leaves for its card in the transcript (ToolOutput.shown): the
// line of the file the replaced text began at, so the diff there is numbered
// as the file is. Nothing when the text was matched another way than as written.
export function editShown(before: string, oldS: string): { line: number } | undefined {
  const at = oldS ? before.indexOf(oldS) : -1;
  return at < 0 ? undefined : { line: before.slice(0, at).split("\n").length };
}

export async function editFile(p: string, oldS: string, newS: string, all: boolean, ctx: ToolContext): Promise<{ ok: string; before: string; after: string } | { error: string }> {
  const m = mtime(p);
  if (m === -1) return { error: notFound(p, ctx.cwd) };
  { const held = heldWrite(p); if (held) return { error: held }; }
  const h = hold(p, ctx, "read");
  if ("refused" in h) return { error: h.refused };
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await Bun.file(h.io).arrayBuffer()); } finally { h.close(); }
  if (!isUtf8(bytes)) return { error: `${p} is not valid UTF-8; change it with a shell command that keeps its encoding.` };
  // A UTF-8 byte-order mark stays (the decoder drops it from the text).
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const before = new TextDecoder().decode(bytes);
  const r = applyEdit(before, oldS, newS, all);
  if ("error" in r) return r;
  const seen = ctx.seen.get(p);
  { const no = await writeFile(p, bom ? `\uFEFF${r.text}` : r.text, ctx); if (no) return { error: no }; }
  const notes = [r.note, seen === undefined ? undefined : seen !== m ? "the file had other changes since it was read; read it again before edits that depend on them" : undefined].filter(Boolean);
  return { ok: notes.length ? ` (${notes.join("; ")})` : "", before, after: r.text };
}

function isUtf8(b: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

// ---- search ----------------------------------------------------------------

// A folder to search that is not there (a guessed tests/ folder, a removed worktree) or is a
// file is answered with where to look instead. Bun's scan throws on both, and on a folder it
// cannot read part-way: the files found until then are returned with what stopped the search.
// The scan examines at most GLOB_SCAN_MAX matches. Reaching that is not the same as
// having more matches than are shown (`truncated`): matches were never looked at, so
// some may be missing and the newest of all may not be among them. `ceiling` says so.
export const GLOB_SCAN_MAX = 20_000;
export async function globFiles(pattern: string, root: string, cwd: string, cap = 100): Promise<{ files: string[]; truncated: boolean; stopped?: string; ceiling?: string } | { error: string }> {
  let st;
  try { st = statSync(root); } catch { return { error: notFound(root, cwd, "Directory") }; }
  if (!st.isDirectory()) return { error: `${root} is a file, not a directory. Search in ${dirname(root)}.` };
  const files: { p: string; m: number }[] = [];
  let stopped: string | undefined;
  let ceiling: string | undefined;
  try {
    for await (const f of new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true, dot: true })) {
      if (f.includes("/node_modules/") || f.includes("/.git/")) continue;
      // One match past the ceiling proves the scan was cut, not that it ended exactly there.
      if (files.length >= GLOB_SCAN_MAX) {
        ceiling = `The scan stopped after ${GLOB_SCAN_MAX} matches, before it had examined them all: files that match may be missing here, and newest first holds only among the ${GLOB_SCAN_MAX} examined. Use a narrower path or pattern.`;
        break;
      }
      files.push({ p: f, m: mtime(f) });
    }
  } catch (e) {
    stopped = `The search stopped before it covered every folder, so this list is incomplete: ${(e as Error).message}`;
  }
  files.sort((a, b) => b.m - a.m);
  return { files: files.slice(0, cap).map((f) => f.p), truncated: files.length > cap, stopped, ceiling };
}

export type RgOpts = {
  pattern: string; path?: string; glob?: string; type?: string; mode?: "content" | "files_with_matches" | "count";
  ignoreCase?: boolean; lineNumbers?: boolean; before?: number; after?: number; context?: number; multiline?: boolean;
  fixed?: boolean; headLimit?: number; offset?: number;
};

export async function ripgrep(o: RgOpts, ctx: ToolContext): Promise<{ text: string; error?: boolean }> {
  const args = ["rg", "--color=never", "--max-columns=500", "--max-columns-preview", "--hidden", "--glob=!.git"];
  const mode = o.mode ?? "files_with_matches";
  if (mode === "files_with_matches") args.push("-l");
  else if (mode === "count") args.push("-c");
  else {
    args.push(o.lineNumbers === false ? "-N" : "-n");
    if (o.context) args.push("-C", String(o.context));
    if (o.before) args.push("-B", String(o.before));
    if (o.after) args.push("-A", String(o.after));
  }
  if (o.ignoreCase) args.push("-i");
  if (o.multiline) args.push("-U", "--multiline-dotall");
  if (o.fixed) args.push("-F");
  if (o.glob) for (const g of o.glob.split(/[\s,]+(?![^{]*})/).filter(Boolean)) args.push("--glob", g);
  if (o.type) args.push("--type", o.type);
  args.push("--", o.pattern, o.path ? abs(o.path, ctx) : ctx.cwd);
  const proc = Bun.spawn(ctx.wrapSpawn ? ctx.wrapSpawn(args) : args, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", signal: ctx.signal });
  const [out, err, code] = await Promise.all([readText(proc.stdout), readText(proc.stderr), proc.exited]);
  if (code === 1 && !err.trim()) return { text: mode === "count" ? "No matches. Total: 0" : "No matches found." };
  if (code !== 0 && code !== 1) return { text: `ripgrep refused the search: ${err.trim() || `exit ${code}`}`, error: true };
  const rel = (l: string) => (l.startsWith(ctx.cwd + "/") ? l.slice(ctx.cwd.length + 1) : l);
  let lines = out.trimEnd().split("\n").filter(Boolean).map(rel);
  let total = "";
  if (mode === "count") total = `\nTotal: ${lines.reduce((n, l) => n + Number(l.slice(l.lastIndexOf(":") + 1) || 0), 0)} matches in ${lines.length} files`;
  const offset = o.offset ?? 0;
  if (offset && offset >= lines.length) return { text: "No entries at this offset." };
  const limit = o.headLimit ?? 250;
  const more = lines.length - offset - limit;
  lines = lines.slice(offset, offset + limit);
  return { text: lines.join("\n") + (more > 0 ? `\n[${more} more; continue with offset ${offset + limit}]` : "") + total };
}

