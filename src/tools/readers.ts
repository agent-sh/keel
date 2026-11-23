// The readers tool, for every family: the working model names what to read
// (files, folders, globs, a long output saved to a file, pages) and asks one
// question; cheaper reader models read it in parts side by side and the
// answer comes back compiled, with exact quotes and path:line references and
// what was not covered (src/engine/readers.ts). Claude gets a Claude Code
// style name, the other families a snake_case one.
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atCwd, canonical, realOf } from "../core/paths.ts";
import { hold, type HoldContext } from "./files.ts";
import { READ_WHOLE_CHARS, readersAtOnce, wholeText, type Material } from "../engine/reader.ts";
import { coverageNote } from "../engine/readers.ts";
import { isClaimFile } from "../core/claim.ts";
import { isStoreFile } from "../core/store-files.ts";
import { conceal } from "../core/conceal.ts";
import { git } from "../core/git.ts";
import { spill } from "./spill.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { MARKUP_MAX, webFetch, type Fetched, type FetchOpts } from "./web.ts";

// What one job gathers into memory at most (characters), whatever the model
// listing allows: a bound on the daemon's memory. The job's own budget is what
// its readers read at most (ctx.readBudget, from the listing), and it is
// applied here before a file or a page is read, never after.
const GATHER_MAX_CHARS = 64_000_000;

const GLOB = /[*?[{]/;
const skipDir = (f: string) => f.includes("/node_modules/") || f.includes("/.git/");

// Every file git does not ignore under `dir`, else every file under it.
// The folder is held while it is listed (files.ts hold): what is listed is the folder the gate judged. git lists
// by the folder's name, so its list is taken only when the name is still that folder afterwards; the plain scan
// goes through the folder's handle.
async function filesIn(dir: string, signal: AbortSignal, ctx: HoldContext): Promise<string[] | { skip: string }> {
  const h = hold(dir, ctx, "read");
  if ("refused" in h) return { skip: "it changed while it was read" };
  try {
    if (!h.existed) return [];
    const same = () => { try { const a = statSync(h.io), b = lstatSync(dir); return b.isDirectory() && a.dev === b.dev && a.ino === b.ino; } catch { return false; } };
    try {
      const r = await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { read: true, signal });
      if (r.code === 0) return same() ? r.out.split("\0").filter(Boolean).map((f) => join(dir, f)).sort() : { skip: "it changed while it was listed" };
    } catch {}
    // A stop killed the listing: no scan in its place.
    if (signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
    const out: string[] = [];
    for await (const f of new Bun.Glob("**/*").scan({ cwd: h.io, absolute: true, onlyFiles: true })) { const at = dir + f.slice(h.io.length); if (!skipDir(at)) out.push(at); }
    return out.sort();
  } finally { h.close(); }
}

async function globbed(pattern: string, cwd: string, ctx: HoldContext): Promise<string[]> {
  // The fixed folders before the first wildcard are where the scan starts: that folder, where it is, held while
  // it is scanned (files.ts hold).
  const segs = pattern.split("/");
  const at = segs.findIndex((s) => GLOB.test(s));
  const base = realOf(atCwd(cwd, segs.slice(0, at).join("/") || "."));
  const rest = segs.slice(at).join("/");
  const h = hold(base, ctx, "read");
  if ("refused" in h || !h.existed) { if (!("refused" in h)) h.close(); return []; }
  try {
    const out: string[] = [];
    for await (const f of new Bun.Glob(rest).scan({ cwd: h.io, absolute: true, onlyFiles: true })) { const name = base + f.slice(h.io.length); if (!skipDir(name)) out.push(name); }
    return out.sort();
  } finally { h.close(); }
}

const show = (f: string, cwd: string) => { const r = relative(cwd, f); return r && !r.startsWith("..") && !isAbsolute(r) ? r : f; };

// A file's text, or why it is not read: binary (a NUL byte, or not UTF-8). At
// most `max` bytes of it are read (a character is never more than its bytes);
// `cut` says the file is longer.
async function textOf(f: string, max: number, ctx: HoldContext): Promise<{ text: string; cut: boolean } | { skip: string }> {
  if (isClaimFile(f)) return { skip: "the daemon's claim on its state folder" };
  if (isStoreFile(f)) return { skip: "the daemon's own store, which is not opened from inside the daemon" };
  // The file itself, held: a link found inside a folder (to a file somewhere else) is not read through.
  const h = hold(f, ctx, "read");
  if ("refused" in h) return { skip: !canonical(f) ? "a link, or a path with one in it: read what it points at by its own path" : /, not a file:/.test(h.refused) ? "a named pipe, a socket or a device, not a file" : "it changed while it was read" };
  if (!h.existed) { h.close(); return { skip: "not found" }; }
  try {
    const file = Bun.file(h.io);
    const cut = file.size > max;
    const b = await (cut ? file.slice(0, max) : file).bytes();
    if (b.subarray(0, 8192).includes(0)) return { skip: "binary" };
    // A character the cut split is left out, not an error.
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: cut }), cut }; } catch { return { skip: "not UTF-8 text" }; }
  } finally { h.close(); }
}

// Text the budget cut: its whole lines, and where the rest starts.
function wholeLines(text: string): { text: string; after: string } {
  const at = text.lastIndexOf("\n");
  if (at < 0) return { text, after: `its first ${text.length} characters` };
  const kept = text.slice(0, at + 1);
  return { text: kept, after: `line ${kept.split("\n").length - 1}` };
}

// `budget`: characters the job keeps at most (default: what the session's
// readers read in one job); `atOnce`: pages fetched side by side; `fetch`: the
// page fetch.
export type GatherOpts = { budget?: number; atOnce?: number; fetch?: (url: string, o: FetchOpts, signal?: AbortSignal) => Promise<Fetched> };

// The material of one job, files first, then pages, each in the order named.
// It keeps at most the budget: a file is read up to what is left of it, and
// what did not fit is named (the rest of a source from a line on, or the
// whole source), never read first and dropped. Pages are fetched a few at a
// time and none is started once the pages that came back spend the budget;
// they are then charged in the order named, so which page is cut does not
// depend on which came back first (a body that streams as it is, under a
// budget shorter than the bodies in flight, is the one case that can).
// A list the input gives as an array or as one string.
const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).map((s) => s.trim()).filter(Boolean);

export async function gather(input: { paths?: unknown; urls?: unknown }, ctx: ToolContext, o: GatherOpts = {}): Promise<{ items: Material[]; skipped: string[]; saved?: string }> {
  const stop = () => { if (ctx.signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" }); };
  const items: Material[] = [];
  const skipped: string[] = [];
  const files: string[] = [];
  for (const p of list(input.paths)) {
    stop();
    if (GLOB.test(p)) {
      const got = await globbed(p, ctx.cwd, ctx);
      if (!got.length) skipped.push(`${p} (no file matches)`);
      files.push(...got);
      continue;
    }
    const full = realOf(atCwd(ctx.cwd, p));
    let st;
    try { st = statSync(full); } catch { skipped.push(`${p} (not found)`); continue; }
    if (st.isDirectory()) { const got = await filesIn(full, ctx.signal, ctx); if ("skip" in got) skipped.push(`${p} (${got.skip})`); else files.push(...got); }
    else if (st.isFile()) files.push(full);
    else skipped.push(`${p} (not a regular file)`);
  }
  const budget = Math.max(0, Math.min(GATHER_MAX_CHARS, o.budget ?? (await ctx.readBudget?.()) ?? GATHER_MAX_CHARS));
  const past = `past what one job reads, ${budget} characters`;
  // What is left of the budget, shared by the files and the pages.
  const pool = { left: budget };
  for (const f of [...new Set(files)]) {
    stop();
    const name = show(f, ctx.cwd);
    if (pool.left <= 0) { skipped.push(`${name} (${past})`); continue; }
    let t: Awaited<ReturnType<typeof textOf>>;
    try { t = await textOf(f, pool.left, ctx); } catch (e) { skipped.push(`${name} (${(e as Error).message})`); continue; }
    if ("skip" in t) { skipped.push(`${name} (${t.skip})`); continue; }
    let text = t.text;
    if (t.cut) {
      // The rest of the budget went to this file: nothing after it is read.
      const w = wholeLines(text);
      text = w.text;
      skipped.push(`${name} after ${w.after} (${past})`);
      pool.left = 0;
    } else pool.left -= text.length;
    if (text.length) items.push({ source: name, text });
  }
  let saved: string | undefined;
  const urls = list(input.urls);
  if (urls.length) {
    saved = join(ctx.spillDir, "readers");
    mkdirSync(saved, { recursive: true });
    const fetchPage = o.fetch ?? webFetch;
    const got: (Fetched | undefined)[] = [];
    const notes: (string | undefined)[] = [];
    const base = pool.left;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(o.atOnce ?? readersAtOnce(), urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++, url = urls[i]!;
        stop();
        if (pool.left <= 0) continue;
        let r: Fetched;
        try { r = await fetchPage(url, { spillDir: ctx.spillDir, whole: true, budget: pool }, ctx.signal); } catch (e) {
          if (ctx.signal.aborted) throw e;
          notes[i] = `${url} (${String((e as Error).message ?? e).slice(0, 200)})`;
          continue;
        }
        stop();
        // A page that failed is not kept: what its body took goes back, and no more.
        if (r.error) { pool.left += r.took ?? 0; notes[i] = `${url} (${r.text.slice(0, 200)})`; continue; }
        // The budget was spent before its first byte: there is no page to read, only its status line.
        if (r.cut && r.took === 0) { notes[i] = `${url} (${past})`; continue; }
        // For now the page takes what it did not take while it streamed, so no
        // page is started once the budget is spent.
        pool.left -= r.text.length - (r.took ?? 0);
        got[i] = r;
      }
    }));
    // The pages charged in the order named.
    let left = base;
    for (const [i, url] of urls.entries()) {
      if (notes[i]) { skipped.push(notes[i]!); continue; }
      const r = got[i];
      const keep = r ? Math.min(r.text.length, Math.max(0, left)) : 0;
      if (!r || !keep) { skipped.push(`${url} (${past})`); continue; }
      left -= keep;
      let text = r.text;
      if (r.cut || keep < text.length) {
        const w = wholeLines(text.slice(0, keep));
        text = w.text;
        // A page of markup is cut by the bound on one page's markup, whatever the budget has left (it has no
        // count of its own, `took`): named as that, so the reason is the one that applied.
        const markup = r.cut && r.took === undefined && keep === r.text.length;
        skipped.push(`${url} after ${w.after} (${markup ? `past the ${MARKUP_MAX / 1024 / 1024} MB of markup read for one page` : past})`);
      }
      const path = join(saved, `${Date.now()}-${i}-${Bun.hash(url).toString(36)}.md`);
      await Bun.write(path, text);
      items.push({ source: path, label: url, text });
    }
  }
  return { items, skipped, saved };
}

// Sources named one by one for a reason they share; more than this are one
// line that counts them by folder, with the full list in a file.
const NAMED = 10;
const FOLDERS = 5;
const folderOf = (name: string) => { try { if (/^https?:/.test(name)) return new URL(name).origin; } catch {} return name.includes("/") ? name.slice(0, name.lastIndexOf("/") + 1) : "./"; };

// What was not read, as the note names it. Each line is "source (reason)".
// The rest of a source from a line on is always named, and so are a few
// sources; a reason many whole sources share (a folder past the budget, a
// folder of images) is one line, so the result stays short however much the
// call named.
async function unreadLines(list: string[], spillDir: string, callId?: string): Promise<string[]> {
  const byReason = new Map<string, string[]>();
  const order: (string | { why: string })[] = [];
  for (const line of list) {
    const m = /^(.*) \(([^()]*)\)$/.exec(line);
    if (!m || / after (line \d+|its first \d+ characters)$/.test(m[1]!)) { order.push(line); continue; }
    if (!byReason.has(m[2]!)) { byReason.set(m[2]!, []); order.push({ why: m[2]! }); }
    byReason.get(m[2]!)!.push(m[1]!);
  }
  const lines: string[] = [];
  for (const x of order) {
    if (typeof x === "string") { lines.push(x); continue; }
    const names = byReason.get(x.why)!;
    if (names.length <= NAMED) { lines.push(...names.map((n) => `${n} (${x.why})`)); continue; }
    const count = new Map<string, number>();
    for (const n of names) count.set(folderOf(n), (count.get(folderOf(n)) ?? 0) + 1);
    const folders = [...count].sort((a, b) => b[1] - a[1]);
    const top = folders.slice(0, FOLDERS).map(([f, n]) => `${n} in ${f}`);
    const rest = folders.slice(FOLDERS);
    if (rest.length) top.push(`${rest.reduce((n, f) => n + f[1], 0)} in ${rest.length} other folder${rest.length === 1 ? "" : "s"}`);
    // Named by its call, so two calls in one millisecond write two files; a secret in a name stays out of it.
    const path = join(spillDir, "readers", `${Date.now()}-${(callId ?? Bun.randomUUIDv7()).replace(/[^\w.-]/g, "_").slice(-40)}-not-read-${lines.length}.txt`);
    mkdirSync(join(spillDir, "readers"), { recursive: true });
    await Bun.write(path, conceal(names.join("\n") + "\n"));
    lines.push(`${names.length} sources (${x.why}): ${top.join(", ")}. All of them are listed in ${path}`);
  }
  return lines;
}

// The sources a job's own not-read line names: a part every reader failed on holds one, two or "N sources".
const sourcesIn = (line: string) => {
  const part = /^(.*) \(every reader failed/.exec(line)?.[1];
  return !part ? 1 : Number(/, (\d+) sources$/.exec(part)?.[1] ?? part.split(", ").length);
};

async function run(input: any, ctx: ToolContext): Promise<ToolOutput> {
  const question = String(input?.question ?? "").trim();
  if (!question) return fail("Give the question: what to find or answer in the material. The readers see only it and the material.");
  if (!ctx.readMaterial) return fail("Readers are not available for this call: read the material with your own tools.");
  const { items, skipped, saved } = await gather(input ?? {}, ctx);
  if (!items.length) return fail(`Nothing to read${skipped.length ? `: ${(await unreadLines(skipped, ctx.spillDir, ctx.callId)).join("; ")}` : ": name paths or urls"}.`);
  const chars = items.reduce((n, m) => n + m.text.length, 0);
  // Short is what comes back, with its line numbers and file headers: many
  // short lines or small files can be several times their own size.
  const whole = chars <= READ_WHOLE_CHARS ? wholeText(items) : "";
  if (whole && whole.length <= READ_WHOLE_CHARS) {
    const not = await unreadLines(skipped, ctx.spillDir, ctx.callId);
    const skippedNote = not.length ? `\n[Not read, so not covered:\n- ${not.join("\n- ")}]` : "";
    return { content: `${whole}\n\n[Short enough to read whole (${chars} chars): no reader was used.]${skippedNote}`, shown: { readers: { question, whole: true, sources: items.length, chars, skipped: not, unread_sources: skipped.length } } };
  }
  const o = await ctx.readMaterial(items, question, ctx.callId);
  // What the card counts: the sources not read (or not read whole), not the lines that name them.
  const unreadSources = o.unread.reduce((n, l) => n + sourcesIn(l), 0) + skipped.length;
  o.unread = await unreadLines([...o.unread, ...skipped], ctx.spillDir, ctx.callId);
  const shown = { readers: { question, sources: items.length, chars: o.chars, parts: o.parts, models: o.models, usage: o.usage, cost: o.cost, plan: o.plan, working: o.working, unread: o.unread, unread_sources: unreadSources, compiled: o.compiled, checked: o.checked } };
  if (!o.text) {
    // No reader read anything: the material as a long output, saved whole.
    const spilled = await spill(wholeText(items), ctx.spillDir, "readers");
    return { content: `[No reader could read the material for this request; it follows as it is.]\n${coverageNote(o, items.length, saved)}\n\n${spilled}`, shown };
  }
  // Findings no reader could compile: the preview goes to the model, all of them to a file.
  let findings: string | undefined;
  if (o.uncompiled) {
    findings = join(ctx.spillDir, "readers", `${Date.now()}-findings.md`);
    mkdirSync(join(ctx.spillDir, "readers"), { recursive: true });
    await Bun.write(findings, conceal(o.uncompiled.findings));
  }
  return { content: `${o.text}\n\n${coverageNote(o, items.length, saved, findings)}`, shown };
}

const DESCRIPTION =
  "Answer one question about a lot of text through cheaper reader models: they read the files, folders (every file git does not ignore), glob matches or web pages you name in parts side by side and return one compiled answer with exact quotes and path:line references. " +
  "Reach for it when the material is long (many files, big logs, transcripts, a long saved output, several pages) and the answer depends on what the text says rather than on a word a search finds: which files, people or cases fit a description, what was decided or taken back, a summary across files. " +
  "A search is still the way to locate a known name or string. " +
  "Pass the folder or files whole: the readers cost a fraction of your rate and none of the text enters your context. " +
  "The readers see nothing of this conversation: the question says what counts and what does not. " +
  "Keel checks every quote against the files and says what was not read, so the answer can be used as it is; " +
  "Read a cited line when you need its context. " +
  "Short material comes back whole.";

const schema = {
  type: "object",
  properties: {
    question: { type: "string", description: "What to find or answer in the material. The readers see only this and the material." },
    paths: { type: "array", items: { type: "string" }, description: "Files, folders or glob patterns (\"src/**/*.ts\"), relative to the working directory or absolute" },
    urls: { type: "array", items: { type: "string" }, description: "http(s) pages to fetch and read" },
  },
  required: ["question"],
  additionalProperties: false,
};

// Its pages are fetched; what comes back is the readers' answer, not a page.
// Public only when it read no file: its pages are, and an answer that quotes a local file is the session's text.
const web = { fetches: (input: any) => list(input?.urls), links: false, public: (input: any, own: (a: string) => boolean) => list(input?.paths).length === 0 && !list(input?.urls).some(own) };
export const AskReaders: Tool = { name: "AskReaders", families: ["claude"], readOnly: true, web, description: DESCRIPTION, input_schema: schema, run };
export const ask_readers: Tool = { name: "ask_readers", families: ["gpt", "gemini", "other"], readOnly: true, web, description: DESCRIPTION, input_schema: schema, run };
export const READER_TOOLS = new Set([AskReaders.name, ask_readers.name]);
