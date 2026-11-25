// A file read through a reader. A text file read with a family's read tool
// goes by default to the session's reader model (the owner's small models,
// then the cheaper models of the listing: src/engine/reader.ts), which reads
// the page and writes a compiled reading: what the file is, its parts with
// their lines, what matters for the caller's aim, and marks for the lines the
// caller will need exactly. Keel puts the file's own lines at the marks, so
// exact text is copied from the file, never retyped by a model. The caller's
// context then carries the reading instead of the page, which it would
// otherwise write to its cache and read again at every later step.
//
// The file itself is read when the caller asks for it (`raw` on the read
// tool), when the page is
// under the carry size (src/tools/carry.ts: a reader costs more than the text
// there), for a program's own read (run_code), and when no other model than
// the session's own can read. A reader that fails, refuses or is slower than
// READER_WAIT_MS falls back to the file itself, said once.
//
// A reading counts as having read the file only for the lines it shows as
// they are: an edit of other lines is refused once, with the read to make
// first (editGuard).
import { isAbsolute, relative } from "node:path";
import { addUsage, emptyUsage } from "../core/types.ts";
import { QUOTE_MARK, readingPrompt, type Chunk, type Material } from "../engine/reader.ts";
import { FLOOR } from "./carry.ts";
import { diffLines, splitLines } from "./diff.ts";
import type { ToolContext } from "./types.ts";

export type Span = { from: number; to: number };

// ---- what a session holds of a file it read through a reader -----------------

// The lines of a file the session has as they are (shown by a reading, read as a
// range since, or written by its own edits), the file's time then, and whether
// an edit of other lines was refused already. A file the session has seen whole
// (`ctx.seen`: a raw read, a command that printed it, its own Write) has no
// entry: nothing is held back from it. Kept with `ctx.seen`, for as long.
export type Known = { mtime: number; lines: Span[]; told: boolean };
type Book = { files: Map<string, Known>; restUntil: number; said: boolean };
const books = new WeakMap<Map<string, number>, Book>();
const bookOf = (ctx: Pick<ToolContext, "seen">): Book => {
  let b = books.get(ctx.seen);
  if (!b) books.set(ctx.seen, (b = { files: new Map(), restUntil: 0, said: false }));
  return b;
};
export function knownOf(ctx: Pick<ToolContext, "seen">, p: string): Known | undefined {
  const b = books.get(ctx.seen);
  const k = b?.files.get(p);
  // Seen whole since the reading: nothing is held back any more.
  if (k && ctx.seen.has(p)) { b!.files.delete(p); return undefined; }
  return k;
}

export function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].filter((x) => x.to >= x.from).sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}
const has = (known: Span[], line: number) => known.some((s) => line >= s.from && line <= s.to);

// The lines of `before` an edit changes, as runs: the lines it removes or
// replaces, and for lines it only adds, the two lines it adds them between
// (`insert`: knowing either is knowing where they go).
export type Touch = Span & { insert?: boolean };
export function touched(before: string, after: string): Touch[] {
  const out: Touch[] = [];
  let line = 0; // lines of `before` passed
  let run: { at: number; removed: number } | undefined;
  const flush = () => {
    if (run) out.push(run.removed ? { from: run.at + 1, to: run.at + run.removed } : { from: run.at, to: run.at + 1, insert: true });
    run = undefined;
  };
  for (const op of diffLines(splitLines(before), splitLines(after))) {
    if (op.t === " ") { flush(); line++; continue; }
    run ??= { at: line, removed: 0 };
    if (op.t === "-") { line++; run.removed++; }
  }
  flush();
  return out;
}

// The touched lines the session does not have, as runs.
export function missing(known: Span[], touches: Touch[], total: number): Span[] {
  const out: Span[] = [];
  for (const t of touches) {
    if (t.insert) {
      const near = [t.from, t.to].filter((l) => l >= 1 && l <= total);
      if (near.length && !near.some((l) => has(known, l))) out.push({ from: near[0]!, to: near.at(-1)! });
      continue;
    }
    for (let l = t.from; l <= t.to; l++) if (!has(known, l)) out.push({ from: l, to: l });
  }
  return merge(out);
}

// The known lines after an edit, in the new text's numbers: a kept line stays
// known under its new number, and the lines the edit wrote are known.
export function rebase(known: Span[], before: string, after: string): Span[] {
  const out: Span[] = [];
  let old = 0, now = 0;
  for (const op of diffLines(splitLines(before), splitLines(after))) {
    if (op.t === "-") { old++; continue; }
    now++;
    if (op.t === "+" || has(known, ++old)) out.push({ from: now, to: now });
  }
  return merge(out);
}

// How a family reads a file itself: the words a reading and a refused edit name it by.
export type RawForm = { how: string; range: (from: number, to: number, path: string) => string };
export const CLAUDE_RAW: RawForm = { how: "Read it with raw: true (offset and limit name a range)", range: (a, b) => `Read with raw: true, offset ${a}, limit ${b - a + 1}` };
export const GEMINI_RAW: RawForm = { how: "use read_file with raw: true (start_line and end_line name a range)", range: (a, b) => `read_file with raw: true, start_line ${a}, end_line ${b}` };

// An edit of a file the session read through a reader: refused when it changes
// lines the session does not have as they are, once for a file, with the read
// to make first. The refusal is recorded, so the same edit sent again is
// applied: a model that has the lines from somewhere else (a search, a
// command's output) is not held in a loop, and one that has not is told once
// what to read. `mtime`: the file's time before the edit; a file that changed
// since the reading has no line the session is known to have.
export function editGuard(ctx: Pick<ToolContext, "seen">, p: string, mtime: number, before: string, after: string, form: RawForm = CLAUDE_RAW): string | undefined {
  const k = knownOf(ctx, p);
  if (!k) return undefined;
  if (k.mtime !== mtime) { k.lines = []; k.mtime = mtime; }
  if (k.told) return undefined;
  const miss = missing(k.lines, touched(before, after), splitLines(before).length);
  if (!miss.length) return undefined;
  k.told = true;
  const says = (s: Span) => (s.from === s.to ? `${s.from}` : `${s.from}-${s.to}`);
  const all = { from: miss[0]!.from, to: miss.at(-1)!.to };
  return `Not applied: you have ${p} as a compiled reading, and line${miss.length === 1 && miss[0]!.from === miss[0]!.to ? "" : "s"} ${miss.slice(0, 4).map(says).join(", ")}${miss.length > 4 ? ", ..." : ""} ` +
    `that this edit changes ${miss.length === 1 && miss[0]!.from === miss[0]!.to ? "is" : "are"} not among the lines it showed. Read them first (${form.range(all.from, all.to, p)}), then send the edit again. ` +
    "If you have these lines exactly from another result, send the same edit again as it is: it is applied.";
}

// After an edit of such a file was written: its known lines in the new text's numbers.
export function edited(ctx: Pick<ToolContext, "seen">, p: string, before: string, after: string, mtime: number): void {
  const k = books.get(ctx.seen)?.files.get(p);
  if (!k) return;
  k.lines = rebase(k.lines, before, after);
  k.mtime = mtime;
  ctx.seen.delete(p);
}

// A raw read of a text file: seen whole, it is the session's as any file it read; a range of a file it has a
// reading of adds those lines to the ones it has.
export function sawText(ctx: Pick<ToolContext, "seen">, p: string, mtime: number, lines?: Span & { whole: boolean }): void {
  const b = books.get(ctx.seen);
  const k = b?.files.get(p);
  if (!k || !lines || lines.whole) { b?.files.delete(p); ctx.seen.set(p, mtime); return; }
  if (k.mtime !== mtime) { k.lines = []; k.mtime = mtime; k.told = false; }
  k.lines = merge([...k.lines, { from: lines.from, to: lines.to }]);
}

// A command that ran to its end with status 0 and names a file the session has a reading of looked at the file
// itself (a printed range, a search, a count): nothing is held back from it after that. The command's words are
// not read further: an edit still needs its exact text to match.
export function shellSaw(ctx: Pick<ToolContext, "seen">, command: string): void {
  const b = books.get(ctx.seen);
  if (!b?.files.size) return;
  for (const p of [...b.files.keys()]) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    if (name && command.includes(name)) b.files.delete(p);
  }
}

// ---- the page and the reading ---------------------------------------------------

// A page of a file as a read tool shows it: its lines by number, and the note under them (where to continue).
export type Page = { rows: Map<number, string>; first: number; last: number; total?: number; chars: number; more: string };

// The page a raw read would return, from its text: rows `N<tab>line` (`numbered`) or bare lines from `first`.
export function pageOf(body: string, numbered: boolean, first: number, total?: number): Page {
  const cut = body.indexOf("\n\nPARTIAL view:");
  const text = cut < 0 ? body : body.slice(0, cut);
  const rows = new Map<number, string>();
  let last = first - 1;
  text.split("\n").forEach((l, i) => {
    if (!numbered) { rows.set((last = first + i), l); return; }
    const tab = l.indexOf("\t");
    const n = Number(l.slice(0, tab));
    if (tab > 0 && Number.isInteger(n)) rows.set((last = n), l.slice(tab + 1));
  });
  return { rows, first: rows.size ? Math.min(...rows.keys()) : first, last, total, chars: text.length, more: cut < 0 ? "" : body.slice(cut + 2) };
}

// A mark on a line of its own: `@@ 120-145`, with a bullet, backticks or a closing `@@` around it, and words after it.
const MARK = new RegExp(`^[\\s>*-]*\`?${QUOTE_MARK}\\s*(\\d+)(?:\\s*(?:-|\\u2013|to)\\s*(\\d+))?\\s*(?:${QUOTE_MARK})?\`?[\\s:.-]*(.*)$`);
// A row as the reader may type one: a number and a tab at the start of a line, behind a bullet, a quote mark or
// spaces, the number padded or not.
const ROW = /^[\s>*-]*(\d+)\s*\t/;
// Where the reader's text ends a line: a row is one line whatever ended it.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/;

// The reader's text with the file's own lines put at its marks (`@@ START-END`,
// as rows `N<tab>line`), at most `budget` characters of them; a mark past the
// budget is a line saying so. Only Keel's rows carry a number and a tab: a row
// the reader typed itself is replaced by the file's row of that number (text
// under a line number is always the file's), or loses its row form when the
// page has no such line, and every other tab of the reader's text is spaces.
// `quoted`: the lines shown as they are.
export function expandReading(reading: string, page: Pick<Page, "rows">, budget: number): { text: string; quoted: Span[] } {
  const out: string[] = [];
  const quoted: Span[] = [];
  let left = budget;
  // The page's first and last line: a mark is walked only inside them, whatever numbers the reader wrote.
  let lo = Infinity, hi = -Infinity;
  for (const n of page.rows.keys()) { if (n < lo) lo = n; if (n > hi) hi = n; }
  for (const typed of reading.split(LINE_END)) {
    const row = ROW.exec(typed);
    const own = row ? page.rows.get(Number(row[1])) : undefined;
    if (own !== undefined) {
      const n = Number(row![1]);
      out.push(`${n}\t${own}`);
      quoted.push({ from: n, to: n });
      continue;
    }
    const line = typed.replace(/\t/g, " ");
    const m = row ? null : MARK.exec(line);
    if (!m) { out.push(line); continue; }
    const a = Number(m[1]), b = Math.max(a, Number(m[2] ?? m[1]));
    if (m[3]?.trim()) out.push(m[3].trim());
    const from = Math.max(a, lo), to = Math.min(b, hi);
    // (No line of the mark is on the page: said in the reader's own numbers, shortened.)
    if (!(from <= to)) { out.push(`[lines ${m[1]!.slice(0, 12)}${m[2] ? `-${m[2].slice(0, 12)}` : ""} are not shown here]`); continue; }
    let shown = 0, end = from - 1;
    for (let n = from; n <= to; n++) {
      const own = page.rows.get(n);
      if (own === undefined) continue;
      const r = `${n}\t${own}`;
      if (r.length + 1 > left && shown) break;
      if (r.length + 1 > left) { left = 0; break; }
      out.push(r);
      left -= r.length + 1;
      shown++;
      end = n;
      quoted.push({ from: n, to: n });
    }
    if (!shown) out.push(`[lines ${from}-${to} are not shown here]`);
    else if (end < to && [...page.rows.keys()].some((n) => n > end && n <= to)) out.push(`[lines ${end + 1}-${to} are not shown here]`);
  }
  return { text: out.join("\n").trim(), quoted: merge(quoted) };
}

// How long a reading of a page may be, and how many lines it may mark: about a tenth of the page in words
// (a reading longer than that carries too much of what it was to keep out), and a fifth of its lines.
export function readingSize(page: Pick<Page, "chars" | "rows">): { words: number; mark: number; excerpt: number } {
  return {
    words: Math.round(Math.min(900, Math.max(150, page.chars / 60))),
    mark: Math.round(Math.min(300, Math.max(20, page.rows.size * 0.2))),
    // The marked lines, in characters: a quarter of the page.
    excerpt: Math.max(2_000, Math.floor(page.chars * 0.25)),
  };
}

// What the reader is told of the caller's aim: its own words for this read, else what the engine knows of
// what it is doing (its task and what it last said), else that none was stated.
export function aimOf(asked: unknown, ctx: Pick<ToolContext, "aim">): string {
  const own = typeof asked === "string" ? asked.trim().slice(0, 1_000) : "";
  if (own) return `Its aim for this read, in its own words: ${own}`;
  let told = "";
  try { told = ctx.aim?.().trim() ?? ""; } catch {}
  return told || "It stated no aim for this read: write a reading that serves any work on the file.";
}

// A reader that has not answered by then is not waited for, and the read comes
// back as the file itself. A small model reads one part and writes a reading
// in seconds to a quarter of a minute; a minute is several times that, and a
// fifth of the five minutes the caller's own cache lives. Past it the step has
// waited longer than the reading is worth, and a wait as long again would be
// what a second read costs.
export const READER_WAIT_MS = 60_000;
const waitMs = () => { const n = Number(process.env.KEEL_READ_WAIT_MS); return Number.isFinite(n) && n > 0 ? n : READER_WAIT_MS; };
// After a reader failed, reads are the file itself for this long without
// asking it (each failed ask costs the caller its wait); then one read asks
// again. The fallback is said on the first of them only, until a reading
// comes back.
export const READER_REST_MS = 5 * 60_000;

// A page at most this long is read as it is: the session's carry size
// (src/tools/carry.ts), what a result may hold inline for what carrying it costs.
export const smallCap = (ctx: Pick<ToolContext, "inline">) => ctx.inline?.cap ?? FLOOR;

// A reading no shorter than this share of the page saves too little: the page goes back as it is.
const WORTH = 0.6;

export type Through =
  | { content: string; shown: unknown }
  // The file itself is to be returned: with `note` above it when a reader was asked and gave nothing.
  | { note?: string };

// The read of a page through the session's reader. `raw`: the caller asked for the file itself.
export async function throughReader(p: string, ctx: ToolContext, page: Page, o: { raw?: boolean; aim?: unknown; mtime: number; form?: RawForm }): Promise<Through> {
  if (o.raw || !ctx.readMaterial || ctx.readThrough === false || ctx.nestedIn || page.chars <= smallCap(ctx) || !page.rows.size) return {};
  const book = bookOf(ctx);
  if (Date.now() < book.restUntil) return {};
  const form = o.form ?? CLAUDE_RAW;
  const rel = relative(ctx.cwd, p);
  const source = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  const lines: string[] = [];
  for (let n = page.first; n <= page.last; n++) lines.push(page.rows.get(n) ?? "");
  const item: Material = { source, text: lines.join("\n"), first: page.first, total: page.total };
  const size = readingSize(page);
  const aim = aimOf(o.aim, ctx);
  const slow = AbortSignal.timeout(waitMs());
  const failed = (why: string): Through => {
    book.restUntil = Date.now() + READER_REST_MS;
    if (book.said) return {};
    book.said = true;
    return { note: `[The reader model did not give a reading of this file (${why}): the file itself follows, and file reads come back as they are until a reader answers again.]` };
  };
  let o2: Awaited<ReturnType<NonNullable<ToolContext["readMaterial"]>>>;
  try {
    o2 = await ctx.readMaterial([item], aim, ctx.callId, { signal: slow, others: true, join: true, prompt: (c: Chunk, k: number, n: number) => readingPrompt(c, aim, k, n, size) });
  } catch (e) {
    // The turn was stopped: the call ends as any stopped call. Only the reader's own time limit is a fallback.
    if (ctx.signal.aborted) throw e;
    return failed(slow.aborted ? `no answer in ${Math.round(waitMs() / 1000)} s` : String((e as Error)?.message ?? e).slice(0, 160));
  }
  // No model but the session's own to read with: the file, with nothing to say.
  if (o2.none) return {};
  const unread = o2.parts.filter((x) => x.state !== "read");
  if (!o2.text.trim() || unread.length) return failed(unread[0]?.error?.slice(0, 160) ?? "it gave no answer");
  const { text, quoted } = expandReading(o2.text, page, size.excerpt);
  const who = o2.models.join(" and ") || "a reader";
  const head = `[Compiled reading of ${source}, lines ${page.first}-${page.last}${page.total ? ` of ${page.total}` : ""}, by ${who}: not the file's text. ` +
    `Lines shown with their number (N<tab>text) are the file's own and can be edited as they are; to see or change any other lines, ${form.how}.]`;
  const content = `${head}\n${text}${page.more ? `\n\n${page.more}` : ""}`;
  // A reader answered: the next failure is said again.
  book.said = false;
  if (content.length > page.chars * WORTH) return {};
  // Seen whole already and unchanged since: the reading takes nothing back.
  if (ctx.seen.get(p) !== o.mtime) {
    ctx.seen.delete(p);
    book.files.set(p, { mtime: o.mtime, lines: quoted, told: false });
  }
  const usage = addUsage(emptyUsage(), o2.usage);
  return {
    content,
    // (What a readers job leaves for its card and the savings ledger: src/admin/outcomes.ts.)
    shown: { readers: { question: aim, read: true, sources: 1, chars: o2.chars, parts: o2.parts, models: o2.models, usage, cost: o2.cost, plan: o2.plan, working: o2.working, unread: [], unread_sources: 0, compiled: true, quoted } },
  };
}
