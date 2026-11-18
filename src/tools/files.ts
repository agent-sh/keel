// File operations every family's tools share: reading pages of text, images,
// PDFs and notebooks; exact-string edits with the quote and line-ending
// tolerance models need; the read-before-overwrite guard; glob and ripgrep.
import { chmodSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { ImageBlock, TextBlock } from "../core/types.ts";
import type { ToolContext } from "./types.ts";

export const abs = (p: string, ctx: ToolContext) => (isAbsolute(p) ? p : resolve(ctx.cwd, p));
export const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };

export const READ_CHARS = 100_000;     // about 25k tokens: one read page
export const WHOLE_FILE_BYTES = 256 * 1024;
const LINE_CAP = 2000;
const BINARY = new Set([".zip", ".gz", ".tgz", ".xz", ".zst", ".7z", ".tar", ".xlsx", ".xls", ".docx", ".pptx", ".parquet",
  ".heic", ".so", ".o", ".a", ".dylib", ".exe", ".bin", ".class", ".jar", ".wasm", ".pyc", ".sqlite", ".db", ".mp3", ".mp4",
  ".mov", ".avi", ".mkv", ".flac", ".wav", ".ttf", ".otf", ".woff", ".woff2", ".ico", ".safetensors", ".gguf", ".pt", ".npy"]);
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

export type ReadResult = { content: string | (TextBlock | ImageBlock)[]; error?: boolean; partial?: boolean };

// Lines `offset`.. of a text file, numbered from 1 (cat -n style), cut to one
// page; the result says where to continue.
export function numbered(text: string, offset = 1, limit?: number, number = true): { body: string; partial: boolean; total: number } {
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
    const row = number ? `${String(i).padStart(6)}\t${l}` : l;
    if (size + row.length > READ_CHARS && out.length) break;
    out.push(row);
    size += row.length + 1;
    last = i;
  }
  let body = out.join("\n");
  const partial = last < total && (!limit || last < end);
  if (partial) body += `\n\nPARTIAL view: lines ${start}-${last} of ${total}. Continue with offset ${last + 1}.`;
  return { body, partial, total };
}

export async function readFile(p: string, ctx: ToolContext, o: { offset?: number; limit?: number; pages?: string } = {}): Promise<ReadResult> {
  let st;
  try { st = statSync(p); } catch { return { content: `File does not exist: ${p}`, error: true }; }
  if (st.isDirectory()) return { content: `${p} is a directory. List it with the shell (ls).`, error: true };
  const f = Bun.file(p);
  const ext = extname(p).toLowerCase();
  if (IMAGE.test(f.type)) {
    if (st.size > 20 * 1024 * 1024) return { content: `${p} is ${(st.size / 1048576).toFixed(0)} MB; resize it (e.g. magick) and read the copy.`, error: true };
    ctx.seen.set(p, st.mtimeMs);
    return { content: [{ type: "image", media_type: f.type, data: Buffer.from(await f.arrayBuffer()).toString("base64") }] };
  }
  if (ext === ".pdf") return readPdf(p, ctx, o.pages);
  if (ext === ".ipynb") return readNotebook(p, ctx);
  if (BINARY.has(ext)) return { content: `${p} is a binary file (${ext}); read it with a script or tool for that format.`, error: true };
  if (!o.offset && !o.limit && st.size > WHOLE_FILE_BYTES) {
    return { content: `${p} is ${(st.size / 1024).toFixed(0)} KB, over the ${WHOLE_FILE_BYTES / 1024} KB whole-file limit. Read a part with offset and limit, or search it.`, error: true };
  }
  const text = await f.text();
  ctx.seen.set(p, st.mtimeMs);
  if (!text) return { content: `${p} exists but is empty.` };
  const r = numbered(text, o.offset, o.limit);
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
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
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
  const st = statSync(p);
  if (st.size > 100 * 1024 * 1024) return { content: `${p} is over 100 MB; read a slice of its cells with jq.`, error: true };
  let nb: any;
  try { nb = JSON.parse(await Bun.file(p).text()); } catch (e) { return { content: `${p} is not valid notebook JSON: ${(e as Error).message}`, error: true }; }
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
        blocks.push({ type: "text", text });
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
  if (m === -1) return null;
  const seen = ctx.seen.get(p);
  if (seen === undefined) {
    ctx.seen.set(p, m);
    let head = "";
    try { head = readFileSync(p, "utf8").slice(0, 2000); } catch {}
    return `${p} exists and was not read in this session. Its start is below; write again to replace it.\n\n${head}`;
  }
  if (seen !== m) return `${p} changed on disk since it was read. Read it again before replacing it.`;
  return null;
}

export async function writeFile(p: string, content: string, ctx: ToolContext) {
  await mkdir(dirname(p), { recursive: true });
  let mode: number | undefined;
  try { mode = statSync(p).mode; } catch {}
  await Bun.write(p, content);
  if (mode !== undefined) chmodSync(p, mode & 0o7777);
  ctx.seen.set(p, mtime(p));
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
  const n = crlf ? newS.replace(/\n/g, "\r\n") : newS;
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
  if (!hits.length) return { error: "old_string was not found in the file. Read the file again and copy the text exactly, including indentation." };
  if (hits.length > 1 && !all) {
    const lines = hits.slice(0, 5).map((at) => text.slice(0, at).split("\n").length);
    return { error: `old_string matches ${hits.length} places (lines ${lines.join(", ")}${hits.length > 5 ? ", ..." : ""}). Add surrounding lines to pick one, or set replace_all.` };
  }
  let out = "";
  let last = 0;
  for (const at of hits) {
    out += text.slice(last, at) + repl(at);
    last = at + o.length;
  }
  return { text: out + text.slice(last), count: hits.length, note };
}

export async function editFile(p: string, oldS: string, newS: string, all: boolean, ctx: ToolContext): Promise<{ ok: string; before: string; after: string } | { error: string }> {
  const m = mtime(p);
  if (m === -1) return { error: `File does not exist: ${p}` };
  const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
  if (!isUtf8(bytes)) return { error: `${p} is not valid UTF-8; change it with a shell command that keeps its encoding.` };
  const before = new TextDecoder().decode(bytes);
  const r = applyEdit(before, oldS, newS, all);
  if ("error" in r) return r;
  const seen = ctx.seen.get(p);
  await writeFile(p, r.text, ctx);
  const notes = [r.note, seen === undefined ? undefined : seen !== m ? "the file had other changes since it was read; read it again before edits that depend on them" : undefined].filter(Boolean);
  return { ok: notes.length ? ` (${notes.join("; ")})` : "", before, after: r.text };
}

function isUtf8(b: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

// ---- search ----------------------------------------------------------------

export async function globFiles(pattern: string, root: string, cap = 100): Promise<{ files: string[]; truncated: boolean }> {
  const files: { p: string; m: number }[] = [];
  for await (const f of new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true, dot: true })) {
    if (f.includes("/node_modules/") || f.includes("/.git/")) continue;
    files.push({ p: f, m: mtime(f) });
    if (files.length >= 20_000) break;
  }
  files.sort((a, b) => b.m - a.m);
  return { files: files.slice(0, cap).map((f) => f.p), truncated: files.length > cap };
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
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
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

