// Readers: cheaper models read long material once, with the question the
// working model asked, and hand back only what answers it. The working model's
// context then carries the answer instead of the material, which it would
// otherwise write to its cache and read again on every later step. Claude
// Code's WebFetch and Gemini CLI's web_fetch read a page this way (both tools
// take a prompt); here any material does: files, a folder, a glob, a saved
// long output, pages. The material stays on disk for a Read of a cited line.
import type { ModelInfo, Price } from "../providers/types.ts";
import { bytesPerToken } from "./compact.ts";

// Text up to this many characters goes to the working model whole: a reader's
// answer runs to a few hundred tokens, so material under about four times that
// saves too little to be worth a second model's paraphrase.
export const READ_WHOLE_CHARS = 8_000;

// The most one reader reads in one request: what Claude Code's WebFetch hands
// its small model per call (100,000 characters of a page). Longer material is
// split, and its parts are read side by side.
export const READ_CHUNK_CHARS = 100_000;

// Readers running at once for one job, unless KEEL_READERS_AT_ONCE says
// otherwise. Cursor's Explore runs about ten searches side by side and Amp's
// Librarian about eight calls; a provider's rate limit answers with a wait,
// which the request's own retry takes.
export const READERS_AT_ONCE = 8;
// The override when it is a positive whole number, else the default: Infinity
// would start a reader for every part, and a fraction is not a count.
export function readersAtOnce(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.KEEL_READERS_AT_ONCE);
  return Number.isSafeInteger(n) && n >= 1 ? n : READERS_AT_ONCE;
}

// Tokens a reader's request keeps free besides its part: the instructions and
// the request around it. The answer is capped at READER_OUTPUT.
const PROMPT_TOKENS = 1_500;
export const READER_OUTPUT = 8_192;

// What a model costs to read with, per million input tokens: its own price on
// a per-token route; on a plan (a subscription, where Keel has no price) the
// public per-token rate of the same model (`listPrice`, the catalog's), which
// says how much of the plan's allowance one model takes against another.
// Absent: unknown, never free.
export function readRate(m: ModelInfo, listPrice: (m: ModelInfo) => Price | undefined = () => undefined): number | undefined {
  if (m.billing === "per_token") return m.price?.input;
  if (m.billing === "subscription") return listPrice(m)?.input;
  return undefined;
}

// The models that read for a session on `current`, best first; each holds
// `needTokens`. In order:
//   0. the owner's small models (setting `small_models`, full ids in order),
//      whatever their provider: readers send no conversation and no tools, so
//      any family can read for any other;
//   1. the owner's choice, KEEL_READER_MODEL (a full id);
//   2. the configured small model, ANTHROPIC_DEFAULT_HAIKU_MODEL, for a Claude
//      session when the session's provider lists it;
//   3. the two cheapest models of the session's provider, family and billing
//      that are cheaper than the session's own (readRate; the newest of equals);
//   4. the session's own model, always last: a reader on it still keeps the
//      material out of the working context.
// A model with no known rate is never picked by price.
export function readerChoices(
  models: ModelInfo[], current: ModelInfo, needTokens: number,
  env: Record<string, string | undefined> = process.env, listPrice?: (m: ModelInfo) => Price | undefined, ownSmall: string[] = [],
): ModelInfo[] {
  const out: ModelInfo[] = [];
  const fits = (m: ModelInfo) => m.context >= needTokens;
  const add = (m: ModelInfo | undefined | false | "") => { if (m && fits(m) && !out.some((o) => o.id === m.id)) out.push(m); };
  for (const id of ownSmall) add(models.find((m) => m.id === id));
  add(env.KEEL_READER_MODEL ? models.find((m) => m.id === env.KEEL_READER_MODEL) : undefined);
  const small = env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.replace(/\[[^\]]*\]$/, "");
  add(current.family === "claude" && small ? models.find((m) => m.provider === current.provider && m.model === small) : undefined);
  const own = readRate(current, listPrice);
  if (own !== undefined) {
    const pool = models
      .filter((m) => m.provider === current.provider && m.family === current.family && m.billing === current.billing && m.id !== current.id && fits(m))
      .map((m) => ({ m, rate: readRate(m, listPrice) }))
      .filter((x): x is { m: ModelInfo; rate: number } => x.rate !== undefined && x.rate < own);
    pool.sort((a, b) => a.rate - b.rate || (b.m.release ?? "").localeCompare(a.m.release ?? ""));
    for (const x of pool.slice(0, 2)) add(x.m);
  }
  if (!out.some((o) => o.id === current.id)) out.push(current);
  return out;
}

export const pickReader = (...a: Parameters<typeof readerChoices>): ModelInfo => readerChoices(...a)[0]!;

// Whether one request to `m` holds `prompt` and the answer in its listed
// window. A request that does not is never sent.
export const holds = (m: ModelInfo, prompt: string): boolean =>
  Math.ceil(prompt.length / bytesPerToken(m.id)) + Math.min(m.output || READER_OUTPUT, READER_OUTPUT) <= m.context;

// Characters of material one request to `reader` takes: its window less the
// prompt and the answer, below its first price tier (a prompt above it is
// billed whole at the dearer rate), and at most READ_CHUNK_CHARS.
export function chunkChars(reader: ModelInfo): number {
  const tier = reader.price?.tiers?.map((t) => t.above).sort((a, b) => a - b)[0] ?? Infinity;
  const tokens = Math.min(reader.context - PROMPT_TOKENS - Math.min(reader.output || READER_OUTPUT, READER_OUTPUT), tier - PROMPT_TOKENS);
  return Math.max(4_000, Math.min(READ_CHUNK_CHARS, Math.floor(tokens * bytesPerToken(reader.id))));
}

// The most material one job reads: what the working model would pay to fill
// its whole window once, spent at the reader's rate (never less than that
// window). The rest is reported unread, never read at any cost.
export function materialCap(current: ModelInfo, reader: ModelInfo, listPrice?: (m: ModelInfo) => Price | undefined): number {
  const own = readRate(current, listPrice), theirs = readRate(reader, listPrice);
  const ratio = own !== undefined && theirs !== undefined && theirs > 0 ? Math.max(1, own / theirs) : 1;
  return Math.floor(current.context * ratio * bytesPerToken(current.id));
}

// ---- material and its parts --------------------------------------------------

// One thing to read: `source` is what a reference names (a path relative to the
// working directory, or the file a page was saved to); `label` what it came
// from when that differs (the page's URL); `text` the content.
export type Material = { source: string; text: string; label?: string };
// A run of lines of one source, numbered from `from` (1-based); `chars` is
// what the run is in the source, without the numbers a reader sees.
export type Part = { source: string; label?: string; from: number; to: number; total: number; body: string; chars: number };
export type Chunk = { parts: Part[]; chars: number };

const HEADER = 80;
// A line longer than this is cut into pieces under the same number, so one
// minified line cannot outgrow a part.
const PIECE = 4_000;

function rowsOf(text: string): string[][] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map((l, i) => {
    if (l.length <= PIECE) return [`${i + 1}\t${l}`];
    const out: string[] = [];
    for (let at = 0; at < l.length; at += PIECE) out.push(`${i + 1}\t${l.slice(at, at + PIECE)}`);
    return out;
  });
}
const rowSize = (r: string[]) => r.reduce((k, y) => k + y.length + 1, 0);

// The material split into chunks of at most `maxChars` (numbered lines plus
// headers), balanced: as many chunks as the total needs, each about the same
// size. A source that fits stays whole in one chunk; a longer one is split at
// line boundaries and its parts say which lines they hold.
export function chunkMaterial(items: Material[], maxChars: number): Chunk[] {
  const all = items.map((m) => ({ m, rows: rowsOf(m.text) })).filter((x) => x.m.text.length > 0);
  const sizes = all.map((x) => x.rows.reduce((n, r) => n + rowSize(r), 0) + HEADER);
  const total = sizes.reduce((a, b) => a + b, 0);
  const target = Math.ceil(total / Math.max(1, Math.ceil(total / maxChars)));
  const chunks: Chunk[] = [];
  let cur: Chunk = { parts: [], chars: 0 };
  const close = () => { if (cur.parts.length) chunks.push(cur); cur = { parts: [], chars: 0 }; };
  const put = (m: Material, r: string[][], from: number, n: number) => {
    const lines = r.slice(from, from + n);
    // Each line without its number, with its newline (the last line may have none).
    const chars = lines.reduce((k, x, j) => k + x.reduce((q, y) => q + y.length, 0) - x.length * (String(from + j + 1).length + 1), 0)
      + n - (from + n === r.length && !m.text.endsWith("\n") ? 1 : 0);
    cur.parts.push({ source: m.source, label: m.label, from: from + 1, to: from + n, total: r.length, body: lines.flat().join("\n"), chars });
    cur.chars += lines.reduce((k, x) => k + rowSize(x), 0) + HEADER;
  };
  all.forEach(({ m, rows }, idx) => {
    const whole = sizes[idx]!;
    if (whole <= maxChars) {
      if (cur.chars + whole > maxChars) close();
      put(m, rows, 0, rows.length);
      if (cur.chars >= target) close();
      return;
    }
    // Longer than a chunk: fill the open chunk to the target, then whole chunks.
    // What is left of the source from each line on: a rest that fits the open
    // chunk goes in whole, so no small last part is left over.
    const left: number[] = new Array(rows.length + 1).fill(0);
    for (let j = rows.length - 1; j >= 0; j--) left[j] = left[j + 1]! + rowSize(rows[j]!);
    let i = 0;
    while (i < rows.length) {
      if (cur.chars + left[i]! + HEADER <= maxChars) { put(m, rows, i, rows.length - i); break; }
      const room = target - cur.chars - HEADER;
      let n = 0, used = 0;
      while (i + n < rows.length && (n === 0 || used + rowSize(rows[i + n]!) <= room)) {
        if (n === 0 && cur.parts.length && rowSize(rows[i]!) > room) break;
        used += rowSize(rows[i + n]!);
        n++;
      }
      if (n === 0) { close(); continue; }
      put(m, rows, i, n);
      i += n;
      if (cur.chars >= target || i < rows.length) close();
    }
  });
  close();
  return chunks;
}

// Where a part sits, for coverage notes: "src/a.ts" or "src/a.ts:201-400".
export const partRef = (p: Part) => (p.from === 1 && p.to === p.total ? p.source : `${p.source}:${p.from}-${p.to}`);

export const partBlock = (p: Part) =>
  `<file path="${p.source}"${p.label ? ` from="${p.label}"` : ""} lines="${p.from}-${p.to} of ${p.total}">\n${p.body}\n</file>`;

// Material short enough for the working model to read whole, as the readers would see it.
export const wholeText = (items: Material[]) => chunkMaterial(items, Number.MAX_SAFE_INTEGER).flatMap((c) => c.parts).map(partBlock).join("\n");

export const NOTHING = "NOTHING RELEVANT";

// One reader's request. A number leads each line (`N<tab>text`), so a
// reference is exact without the reader counting.
export function partPrompt(chunk: Chunk, question: string, k: number, n: number): string {
  const head = n > 1 ? `You read part ${k} of ${n} of the material; other readers have the rest.\n\n` : "";
  const refs = "with the exact quote and its reference as path:line or path:start-end (the number at the start of each line). " +
    "Quote values, code, commands, names, numbers and URLs verbatim.";
  const ask = n > 1
    ? `Report what in this part bears on the request: each finding ${refs} Use this part only and do not guess about the rest. ` +
      `If nothing in this part bears on the request, answer exactly: ${NOTHING}. No preamble.`
    : `Answer the request from the material above only, each finding ${refs} ` +
      "When the material does not answer part of the request, say so plainly and name what it does cover. No preamble.";
  return `${head}<material>\n${chunk.parts.map(partBlock).join("\n")}\n</material>\n\nRequest: ${question}\n\n${ask}`;
}

export type Finding = { covers: string; text: string };
const findingBlock = (f: Finding, i: number) => `<findings reader="${i + 1}" read="${f.covers}">\n${f.text}\n</findings>`;
const findingSize = (f: Finding) => findingBlock(f, 999).length + 1;
export const findingsSize = (fs: Finding[]) => fs.reduce((n, f) => n + findingSize(f), 0);

// Findings in order, grouped so each group's blocks stay within `maxChars`
// (what one request to the reader holds). A finding longer than that is a
// group alone.
export function groupFindings<T extends Finding>(findings: T[], maxChars: number): T[][] {
  const groups: T[][] = [];
  let size = 0;
  for (const f of findings) {
    const n = findingSize(f);
    if (!groups.length || size + n > maxChars) { groups.push([]); size = 0; }
    groups.at(-1)!.push(f);
    size += n;
  }
  return groups;
}

// The compile step: the readers' findings merged into one answer. The parts
// that held nothing are named, so the compiler does not take them for unread;
// what went unread is Keel's to say, under the answer. With `group` the
// findings are too many for one request: this request merges group k of n
// into one set of findings, and a later one writes the answer from the sets.
export function compilePrompt(question: string, findings: Finding[], nothing: string[] = [], group?: { k: number; n: number }): string {
  return [
    "Readers each read one part of the material for this request and reported what they found." +
      (group ? ` The findings are too many for one request, so they are merged in groups first: this is group ${group.k} of ${group.n}.` : ""),
    "",
    `Request: ${question}`,
    "",
    ...findings.map(findingBlock),
    ...(nothing.length ? ["", `These parts were read too and hold nothing that bears on the request: ${nothing.join(", ")}.`] : []),
    "",
    group
      ? "Merge these findings into one set of findings: say once what repeats, and keep every finding that bears on the request with its exact quote and " +
        "its path:line reference, in the order of the material. Do not answer the request yet and do not guess about the other groups. No preamble."
      : "Write one answer to the request from these findings only: merge findings that repeat, keep every exact quote and its path:line reference, " +
        "and put what matters most first. If the findings leave part of the request unanswered, say which in one sentence. " +
        "Do not comment on which parts were read, on coverage, or on whether quotes or line numbers were checked: the harness reports that itself. No preamble.",
  ].join("\n");
}

// Room in a preview for one part's findings at the least: a quote, its
// reference and a sentence around them. Fewer parts are shown before each
// gets less.
const PREVIEW_PART = 400;
const PREVIEW_HEAD = 160;

// Findings no reader could compile, as the working model gets them: each
// part's findings from their start (a reader puts what bears most on the
// request first), in part order, within `cap` characters in all. Short
// findings are whole and leave their room to the long ones. `whole`, `cut`
// and `left` count the parts shown whole, shown in part, and not shown.
export function findingsPreview(found: (Finding & { k: number })[], cap: number): { text: string; whole: number; cut: number; left: number } {
  const shown = found.slice(0, Math.max(1, Math.floor(cap / (PREVIEW_PART + PREVIEW_HEAD))));
  const take = new Map<number, number>();
  let room = cap - shown.length * PREVIEW_HEAD, n = shown.length;
  for (const f of [...shown].sort((a, b) => a.text.length - b.text.length)) {
    const t = Math.min(f.text.length, Math.floor(room / n--));
    take.set(f.k, t);
    room -= t;
  }
  let cut = 0;
  const blocks = shown.map((f) => {
    const t = take.get(f.k)!;
    const covers = f.covers.length > 100 ? `${f.covers.slice(0, 100)}...` : f.covers;
    if (t >= f.text.length) return `Findings of part ${f.k} (${covers}):\n${f.text}`;
    cut++;
    return `Findings of part ${f.k} (${covers}), the first ${t} of ${f.text.length} characters:\n${f.text.slice(0, t)}`;
  });
  return { text: blocks.join("\n\n"), whole: shown.length - cut, cut, left: found.length - shown.length };
}

export const READER_SYSTEM = "You read material for a coding agent and answer its request from that material.";

// ---- the answer checked against the material ---------------------------------

// What Keel found when it held the answer against the material the readers
// read. A quote is `verbatim` when it is there word for word, case included
// (runs of whitespace and the style of quote marks aside), and `atLine` when
// that is on the very lines the answer cites for it, in a file its path names
// alone. `loose` quotes match only when case is ignored. A reference is
// `valid` when it names lines a reader read, `ambiguous` when more than one
// file ends with its path. A working model that sees its answer checked has
// no reason to search the material again.
export type Checked = { quotes: number; verbatim: number; atLine: number; loose: number; refs: number; valid: number; ambiguous: number; missing: string[] };
// Lines of a source a reader read (1-based, inclusive).
export type Span = { source: string; from: number; to: number };

const norm = (s: string) => s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
const REF = /([\w@.\/-]*[\w-]\.[A-Za-z0-9]+):(\d+)(?:\s*[-\u2013]\s*(\d+))?|(?<![\w.\/])`?:(\d+)(?:\s*[-\u2013]\s*(\d+))?/g;
const QUOTE = /"([^"\n]{12,})"|\u201c([^\u201d\n]{12,})\u201d/g;
// A quote with an ellipsis is checked piece by piece.
const pieces = (q: string) => q.split(/\.\.\.|\u2026/).map((p) => p.trim().replace(/[.,;:!?]+$/, "")).filter((p) => p.length >= 12);

// `read`: the lines the readers read; without it, every line of `items`.
export function checkAnswer(answer: string, items: Material[], read?: Span[]): Checked {
  // Each source's lines; a line no reader read is absent.
  const lines = new Map<string, (string | undefined)[]>();
  for (const m of items) {
    const ls: (string | undefined)[] = m.text.split("\n");
    if (ls.length > 1 && ls.at(-1) === "") ls.pop();
    if (read) {
      const got = new Uint8Array(ls.length);
      for (const s of read) if (s.source === m.source) got.fill(1, Math.max(0, s.from - 1), Math.min(ls.length, s.to));
      for (let i = 0; i < ls.length; i++) if (!got[i]) ls[i] = undefined;
    }
    lines.set(m.source, ls);
  }
  // What was read, as runs of neighbouring lines: a quote is never matched across a gap.
  const runs: string[] = [];
  for (const ls of lines.values()) {
    for (let i = 0; i < ls.length; ) {
      let j = i;
      while (j < ls.length && ls[j] !== undefined) j++;
      if (j > i) runs.push(norm(ls.slice(i, j).join("\n")));
      i = j + 1;
    }
  }
  const all = runs.join("\n"), lower = all.toLowerCase();
  // A source as the answer names it: exact, else by its ending (the readers
  // may drop a folder) when one source alone ends that way.
  const find = (p: string): string | "ambiguous" | undefined => {
    if (lines.has(p)) return p;
    const ends = [...lines.keys()].filter((k) => k.endsWith(`/${p}`) || p.endsWith(`/${k}`));
    return ends.length > 1 ? "ambiguous" : ends[0];
  };
  const out: Checked = { quotes: 0, verbatim: 0, atLine: 0, loose: 0, refs: 0, valid: 0, ambiguous: 0, missing: [] };
  let last: string | undefined;
  // A quote goes with the references on its own line, else with those of the
  // lines just above it (a heading line that names the file, then the quote).
  let recent: Span[] = [];
  let since = 0;
  for (const line of answer.split("\n")) {
    let spans: Span[] = [];
    for (const r of line.matchAll(REF)) {
      const path = r[1] ? find(r[1]) : last;
      if (path === "ambiguous") { out.refs++; out.ambiguous++; last = undefined; continue; }
      if (r[1] && !path) { if (lines.size && /[\/.]/.test(r[1])) out.refs++; continue; }
      if (!path) continue;
      last = path;
      const from = Number(r[2] ?? r[4]), to = Number(r[3] ?? r[5] ?? from);
      out.refs++;
      const ls = lines.get(path)!;
      if (from >= 1 && to >= from && to <= ls.length && ls.slice(from - 1, to).every((l) => l !== undefined)) { out.valid++; spans.push({ source: path, from, to }); }
    }
    if (spans.length) { recent = spans; since = 0; } else if (++since <= 3) spans = recent;
    for (const q of line.matchAll(QUOTE)) {
      const ps = pieces(q[1] ?? q[2] ?? "");
      if (!ps.length) continue;
      out.quotes++;
      const n = ps.map(norm);
      if (n.every((p) => all.includes(p))) {
        out.verbatim++;
        // On the lines cited, and no others.
        if (spans.some((s) => { const text = norm(lines.get(s.source)!.slice(s.from - 1, s.to).join("\n")); return n.every((p) => text.includes(p)); })) out.atLine++;
      } else if (n.every((p) => lower.includes(p.toLowerCase()))) out.loose++;
      else if (out.missing.length < 5) out.missing.push((q[1] ?? q[2]!).slice(0, 120));
    }
  }
  return out;
}

// The line under an answer that says what the check found. Only a quote found
// word for word on the lines cited for it is called that; a looser match is
// counted apart.
export function checkedNote(c: Checked): string {
  if (!c.quotes && !c.refs) return "";
  const parts: string[] = [];
  if (c.quotes) {
    parts.push(c.atLine === c.quotes ? `all ${c.quotes} quotes are word for word at the lines they cite` : `${c.atLine} of ${c.quotes} quotes are word for word at the lines they cite`);
    const off = c.verbatim - c.atLine;
    if (off) parts.push(`${off} more ${off === 1 ? "is" : "are"} word for word in the material but not on a line cited for ${off === 1 ? "it" : "them"}`);
    if (c.loose) parts.push(`${c.loose} more match${c.loose === 1 ? "es" : ""} the material only when case is ignored`);
  }
  if (c.refs) parts.push(`${c.valid} of ${c.refs} path:line references name lines the readers read` + (c.ambiguous ? `; ${c.ambiguous} name${c.ambiguous === 1 ? "s" : ""} a path that more than one file ends with` : ""));
  const miss = c.missing.length ? `\nNot found in what the readers read, so treat as unconfirmed:\n- "${c.missing.join('"\n- "')}"` : "";
  return `[Keel checked the answer against the files: ${parts.join("; ")}.${miss}]`;
}
