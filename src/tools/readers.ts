// The readers tool, for every family: the working model names what to read
// (files, folders, globs, a long output saved to a file, pages) and asks one
// question; cheaper reader models read it in parts side by side and the
// answer comes back compiled, with exact quotes and path:line references and
// what was not covered (src/engine/readers.ts). Claude gets a Claude Code
// style name, the other families a snake_case one.
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { READ_WHOLE_CHARS, wholeText, type Material } from "../engine/reader.ts";
import { coverageNote } from "../engine/readers.ts";
import { readText } from "../core/proc.ts";
import { spill } from "./spill.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { webFetch } from "./web.ts";

// What one job gathers into memory at most (characters): a bound on the
// daemon's memory, far above what one job reads (src/engine/reader.ts materialCap).
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

// A file's text, or why it is not read: binary (a NUL byte, or not UTF-8).
async function textOf(f: string): Promise<string | { skip: string }> {
  const b = await Bun.file(f).bytes();
  if (b.subarray(0, 8192).includes(0)) return { skip: "binary" };
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return { skip: "not UTF-8 text" }; }
}

export async function gather(input: { paths?: unknown; urls?: unknown }, ctx: ToolContext): Promise<{ items: Material[]; skipped: string[]; saved?: string }> {
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).map((s) => s.trim()).filter(Boolean);
  const items: Material[] = [];
  const skipped: string[] = [];
  const files: string[] = [];
  for (const p of list(input.paths)) {
    if (GLOB.test(p)) {
      const got = await globbed(p, ctx.cwd);
      if (!got.length) skipped.push(`${p} (no file matches)`);
      files.push(...got);
      continue;
    }
    const full = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    let st;
    try { st = statSync(full); } catch { skipped.push(`${p} (not found)`); continue; }
    files.push(...(st.isDirectory() ? await filesIn(full, ctx.signal) : [full]));
  }
  let total = 0;
  for (const f of [...new Set(files)]) {
    const name = show(f, ctx.cwd);
    if (total >= GATHER_MAX_CHARS) { skipped.push(`${name} (past ${GATHER_MAX_CHARS} characters gathered)`); continue; }
    let t: string | { skip: string };
    try { t = await textOf(f); } catch (e) { skipped.push(`${name} (${(e as Error).message})`); continue; }
    if (typeof t !== "string") { skipped.push(`${name} (${t.skip})`); continue; }
    if (!t.length) continue;
    items.push({ source: name, text: t });
    total += t.length;
  }
  let saved: string | undefined;
  const urls = list(input.urls);
  if (urls.length) {
    saved = join(ctx.spillDir, "readers");
    mkdirSync(saved, { recursive: true });
    await Promise.all(urls.map(async (url, i) => {
      const r = await webFetch(url, { spillDir: ctx.spillDir, whole: true }, ctx.signal);
      if (r.error) { skipped.push(`${url} (${r.text.slice(0, 200)})`); return; }
      const path = join(saved!, `${Date.now()}-${i}-${Bun.hash(url).toString(36)}.md`);
      await Bun.write(path, r.text);
      items.push({ source: path, label: url, text: r.text });
    }));
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
  if (chars <= READ_WHOLE_CHARS) {
    return { content: `${wholeText(items)}\n\n[Short enough to read whole (${chars} chars): no reader was used.]${skippedNote}`, shown: { readers: { question, whole: true, sources: items.length, chars, skipped } } };
  }
  const o = await ctx.readMaterial(items, question, ctx.callId);
  o.unread.push(...skipped);
  const shown = { readers: { question, sources: items.length, chars: o.chars, parts: o.parts, models: o.models, usage: o.usage, cost: o.cost, plan: o.plan, working: o.working, unread: o.unread, compiled: o.compiled, checked: o.checked } };
  if (!o.text) {
    // No reader read anything: the material as a long output, saved whole.
    const spilled = await spill(wholeText(items), ctx.spillDir, "readers");
    return { content: `[No reader could read the material for this request; it follows as it is.]\n${coverageNote(o, items.length, saved)}\n\n${spilled}`, shown };
  }
  return { content: `${o.text}\n\n${coverageNote(o, items.length, saved)}`, shown };
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
