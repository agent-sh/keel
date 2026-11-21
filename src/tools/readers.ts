// The readers tool, for every family: the working model names what to read
// (files, folders, globs, a long output saved to a file, pages) and asks one
// question; cheaper reader models read it in parts side by side and the
// answer comes back compiled, with exact quotes and path:line references and
// what was not covered (src/engine/readers.ts). Claude gets a Claude Code
// style name, the other families a snake_case one.
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { READ_WHOLE_CHARS, READERS_AT_ONCE, wholeText, type Material } from "../engine/reader.ts";
import { coverageNote } from "../engine/readers.ts";
import { conceal } from "../core/conceal.ts";
import { readText } from "../core/proc.ts";
import { spill } from "./spill.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { webFetch, type Fetched, type FetchOpts } from "./web.ts";

// What one job gathers into memory at most (characters), whatever the model
// listing allows: a bound on the daemon's memory. The job's own budget is what
// its readers read at most (ctx.readBudget, from the listing), and it is
// applied here before a file or a page is read, never after.
const GATHER_MAX_CHARS = 64_000_000;

const GLOB = /[*?[{]/;
const skipDir = (f: string) => f.includes("/node_modules/") || f.includes("/.git/");

// Every file git does not ignore under `dir`, else every file under it.
async function filesIn(dir: string, signal: AbortSignal): Promise<string[]> {
  try {
    const p = Bun.spawn(["git", "-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe", stderr: "ignore", signal });
    const [out, code] = await Promise.all([readText(p.stdout), p.exited]);
    if (code === 0) return out.split("\0").filter(Boolean).map((f) => join(dir, f)).sort();
  } catch {}
  const out: string[] = [];
  for await (const f of new Bun.Glob("**/*").scan({ cwd: dir, absolute: true, onlyFiles: true })) if (!skipDir(f)) out.push(f);
  return out.sort();
}

async function globbed(pattern: string, cwd: string): Promise<string[]> {
  // The fixed folders before the first wildcard are where the scan starts.
  const segs = pattern.split("/");
  const at = segs.findIndex((s) => GLOB.test(s));
  const base = resolve(cwd, segs.slice(0, at).join("/") || ".");
  const rest = segs.slice(at).join("/");
  const out: string[] = [];
  for await (const f of new Bun.Glob(rest).scan({ cwd: base, absolute: true, onlyFiles: true })) if (!skipDir(f)) out.push(f);
  return out.sort();
}

const show = (f: string, cwd: string) => { const r = relative(cwd, f); return r && !r.startsWith("..") && !isAbsolute(r) ? r : f; };

// A file's text, or why it is not read: binary (a NUL byte, or not UTF-8). At
// most `max` bytes of it are read (a character is never more than its bytes);
// `cut` says the file is longer.
async function textOf(f: string, max: number): Promise<{ text: string; cut: boolean } | { skip: string }> {
  const file = Bun.file(f);
  const cut = file.size > max;
  const b = await (cut ? file.slice(0, max) : file).bytes();
  if (b.subarray(0, 8192).includes(0)) return { skip: "binary" };
  // A character the cut split is left out, not an error.
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: cut }), cut }; } catch { return { skip: "not UTF-8 text" }; }
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
// It keeps at most the budget: a file is read up to what is left of it, a page
// body only while it lasts, and what did not fit is named (the rest of a
// source from a line on, or the whole source), never read first and dropped.
export async function gather(input: { paths?: unknown; urls?: unknown }, ctx: ToolContext, o: GatherOpts = {}): Promise<{ items: Material[]; skipped: string[]; saved?: string }> {
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).map((s) => s.trim()).filter(Boolean);
  const stop = () => { if (ctx.signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" }); };
  const items: Material[] = [];
  const skipped: string[] = [];
  const files: string[] = [];
  for (const p of list(input.paths)) {
    stop();
    if (GLOB.test(p)) {
      const got = await globbed(p, ctx.cwd);
      if (!got.length) skipped.push(`${p} (no file matches)`);
      files.push(...got);
      continue;
    }
    const full = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    let st;
    try { st = statSync(full); } catch { skipped.push(`${p} (not found)`); continue; }
    if (st.isDirectory()) files.push(...await filesIn(full, ctx.signal));
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
    try { t = await textOf(f, pool.left); } catch (e) { skipped.push(`${name} (${(e as Error).message})`); continue; }
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
    const pages: (Material | undefined)[] = [];
    const notes: (string | undefined)[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(o.atOnce ?? READERS_AT_ONCE, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++, url = urls[i]!;
        stop();
        if (pool.left <= 0) { notes[i] = `${url} (${past})`; continue; }
        let r: Fetched;
        try { r = await fetchPage(url, { spillDir: ctx.spillDir, whole: true, budget: pool }, ctx.signal); } catch (e) {
          if (ctx.signal.aborted) throw e;
          notes[i] = `${url} (${String((e as Error).message ?? e).slice(0, 200)})`;
          continue;
        }
        stop();
        // A page that failed is not kept: what it took goes back.
        if (r.error) { pool.left += r.text.length; notes[i] = `${url} (${r.text.slice(0, 200)})`; continue; }
        let text = r.text;
        if (r.cut) {
          const w = wholeLines(text);
          text = w.text;
          notes[i] = text ? `${url} after ${w.after} (${past})` : `${url} (${past})`;
        }
        if (!text) continue;
        const path = join(saved!, `${Date.now()}-${i}-${Bun.hash(url).toString(36)}.md`);
        await Bun.write(path, text);
        pages[i] = { source: path, label: url, text };
      }
    }));
    urls.forEach((_, i) => {
      if (pages[i]) items.push(pages[i]!);
      if (notes[i]) skipped.push(notes[i]!);
    });
  }
  return { items, skipped, saved };
}

async function run(input: any, ctx: ToolContext): Promise<ToolOutput> {
  const question = String(input?.question ?? "").trim();
  if (!question) return fail("Give the question: what to find or answer in the material. The readers see only it and the material.");
  if (!ctx.readMaterial) return fail("Readers are not available for this call: read the material with your own tools.");
  const { items, skipped, saved } = await gather(input ?? {}, ctx);
  if (!items.length) return fail(`Nothing to read${skipped.length ? `: ${skipped.join("; ")}` : ": name paths or urls"}.`);
  const chars = items.reduce((n, m) => n + m.text.length, 0);
  const skippedNote = skipped.length ? `\n[Not read, so not covered:\n- ${skipped.join("\n- ")}]` : "";
  // Short is what comes back, with its line numbers and file headers: many
  // short lines or small files can be several times their own size.
  const whole = chars <= READ_WHOLE_CHARS ? wholeText(items) : "";
  if (whole && whole.length <= READ_WHOLE_CHARS) {
    return { content: `${whole}\n\n[Short enough to read whole (${chars} chars): no reader was used.]${skippedNote}`, shown: { readers: { question, whole: true, sources: items.length, chars, skipped } } };
  }
  const o = await ctx.readMaterial(items, question, ctx.callId);
  o.unread.push(...skipped);
  const shown = { readers: { question, sources: items.length, chars: o.chars, parts: o.parts, models: o.models, usage: o.usage, cost: o.cost, plan: o.plan, working: o.working, unread: o.unread, compiled: o.compiled, checked: o.checked } };
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

export const AskReaders: Tool = { name: "AskReaders", families: ["claude"], readOnly: true, description: DESCRIPTION, input_schema: schema, run };
export const ask_readers: Tool = { name: "ask_readers", families: ["gpt", "gemini", "other"], readOnly: true, description: DESCRIPTION, input_schema: schema, run };
export const READER_TOOLS = new Set([AskReaders.name, ask_readers.name]);
