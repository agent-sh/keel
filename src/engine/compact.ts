// Compaction: when the context nears the model's window (or the owner asks),
// the model writes a summary of the conversation on the session's own request
// prefix (tools and system unchanged, so that call reads them from cache), and
// a `compaction` event is appended. From there the model sees the summary and
// the owner's recent words verbatim instead of the history; the history stays
// stored, readable and searchable. Nothing earlier is rewritten.
import type { AssistantBlock, Message, PromptBlock, StoredEvent, Usage } from "../core/types.ts";
import { ownerPrompt } from "../core/owner.ts";
import { imageTokens } from "./images.ts";

// Share of the model's window at which a turn compacts before its next call.
export const COMPACT_SHARE = 0.85;
// Owner words kept verbatim through a compaction, newest first (Codex keeps
// about 20k tokens of user messages; at ~2.5 bytes per token that is 50 KB).
export const OWNER_WORDS_BYTES = 50_000;

// A summary prepared ahead covers the history up to an earlier event; the
// events between that one and the checkpoint stay verbatim after the summary.
// Where the context starts: the last checkpoint, and the first event it keeps.
export function checkpointAt(lineage: readonly StoredEvent[]): { at: number; keepFrom: number } {
  for (let i = lineage.length - 1; i >= 0; i--) {
    const e = lineage[i]!;
    if (e.kind !== "compaction") continue;
    // (The event it covers lies before it, and near: looked for from the checkpoint back, not from the session's first event.)
    let covered = -1;
    if (e.data.covered) for (let k = i - 1; k >= 0; k--) if (lineage[k]!.id === e.data.covered) { covered = k; break; }
    return { at: i, keepFrom: covered >= 0 ? covered + 1 : i + 1 };
  }
  return { at: -1, keepFrom: 0 };
}

// A summary is written from one branch and applies only to it. Events never
// change and each points to its parent, so the head names the whole lineage:
// when the head is not the one the summary was written from (the owner showed
// another branch, or a prompt, a turn or another summary landed meanwhile),
// nothing is applied. Storing it off the branch instead would make it the newest
// end under the old branch, so showing that branch again would open on a summary
// the owner never applied.
export function headMoved(written: string | null | undefined, now: string | null | undefined): Error | null {
  if ((written ?? null) === (now ?? null)) return null;
  return Object.assign(
    new Error("the conversation changed while the summary was written (another branch is shown, or a prompt or another summary landed): nothing was applied; summarize again on the branch shown now"),
    { status: 409, code: "head_moved" },
  );
}

// Share of the window at which a summary is prepared in the background, so the
// turn that reaches COMPACT_SHARE swaps it in without waiting for a model call.
export const PREPARE_SHARE = 0.7;

// Idle compaction, as Claude Code does it: a long context left idle is
// summarized while its cache is still warm (that call reads the history at
// the cache read price), and the summary replaces the history only when the
// owner comes back after the cache expired, when the next request would
// otherwise write the whole history again at the cache write price.
// Prepared this long before the cache lifetime ends (Claude Code: about 54 of 60 minutes):
export const IDLE_MARGIN_MS = 6 * 60_000;
// From this many tokens (Claude Code's default minimum), or from the
// preparing share of a smaller limit, where a summary is due soon anyway.
export const IDLE_MIN_TOKENS = 200_000;
export const idleMinTokens = (limit: number) => Math.min(IDLE_MIN_TOKENS, Math.floor(limit * (PREPARE_SHARE / COMPACT_SHARE)));

// What idle compaction needs to know of the context a session shows: the
// tokens it holds, when its cache was last read or written on the model's
// route, and how long that route keeps it. They are read from the events once
// and kept with the head they were read at, so a daemon that starts decides
// without reading any events (the engine's idle_facts).
export type IdleFacts = { head: string | null; model: string; wire: string; used: number; warm: number; sure: number; max: number };

// When the summary of an idle context is due, undefined when none is
// prepared: the context is too small, the documented lifetime leaves no idle
// time to use (a five-minute cache), nothing shows the model's cache holds
// the context, or the cache has surely expired already (a turn that failed
// long after its last cached reply, a restart of an old session), when a
// summary would read the whole context at the full price.
export function idleDue(f: Pick<IdleFacts, "used" | "warm" | "sure" | "max">, limit: number, now: number): number | undefined {
  if (f.used < idleMinTokens(limit)) return undefined;
  if (f.sure < 2 * IDLE_MARGIN_MS) return undefined;
  if (!f.warm || now - f.warm > f.max) return undefined;
  return f.warm + f.sure - IDLE_MARGIN_MS;
}

// The newest reply that shows this context's cache was read or written on
// `model`'s route: a reply of that model after the last checkpoint whose usage
// reported cache activity. Another model's reply used another route's cache, a
// reply that reported none touched no cache, and a reply before the checkpoint
// was on the history the checkpoint replaced. -1 when there is none.
export function warmReplyAt(lineage: readonly StoredEvent[], model: string): number {
  const cp = checkpointAt(lineage).at;
  for (let i = lineage.length - 1; i > cp; i--) {
    const e = lineage[i]!;
    if (e.kind !== "assistant" || e.data.model !== model) continue;
    const u = e.data.usage;
    if (u && (u.cache_read ?? 0) + (u.cache_write ?? 0) > 0) return i;
  }
  return -1;
}

// When a request last read or wrote this context's cache on `model`'s route:
// that reply, or a summary prepared after it on the same prefix (preparedWarm).
// 0 when nothing shows the cache was used.
export function lastWarm(lineage: readonly StoredEvent[], model: string, preparedMs = 0): number {
  const at = warmReplyAt(lineage, model);
  return Math.max(at < 0 ? 0 : lineage[at]!.ts, preparedMs);
}

// When a prepared summary's request read this context's cache, 0 when it did
// not: only a summary written on the session's own request by the same model,
// with cache activity reported, used that prefix. One written from a
// transcript (`parts`) sent another request with another prefix.
export function preparedWarm(data: { prepared_ms?: number; parts?: number; model?: string; usage?: Usage }, model: string): number {
  if (data.parts || data.model !== model) return 0;
  const u = data.usage;
  return u && (u.cache_read ?? 0) + (u.cache_write ?? 0) > 0 ? Number(data.prepared_ms ?? 0) : 0;
}

// A prepared summary that covers up to `covered` still serves: it covers part
// of this branch after its last checkpoint, and for idle compaction (which
// covers the whole context) only notes came after it, such as a job notice its
// own request stored. Those follow it verbatim when it is applied.
export function preparedHolds(lineage: readonly StoredEvent[], covered: string, idle: boolean, data?: { statements_done?: string[] }): boolean {
  const at = lineage.findIndex((e) => e.id === covered);
  const cp = checkpointAt(lineage).at;
  if (at < 0 || at <= cp) return false;
  // A summary prepared before scoped requests could mark any quote done.
  // Reuse it only if each retirement is backed by a recorded scoped request.
  if (data?.statements_done?.length) {
    const previous: StoredStatement[] = cp >= 0 && lineage[cp]!.data.mode === "summary" ? lineage[cp]!.data.statements ?? [] : [];
    if (data.statements_done.some((text) => !previous.some((s) => s.kind === "request" && s.text === text))) return false;
  }
  return !idle || lineage.slice(at + 1).every((e) => e.kind === "note" || e.kind === "turn_start" || e.kind === "turn_end");
}

// A summary may shorten the conversation but never change what a statement
// means. Rules, constraints, decisions and requests are quoted, not retold
// (summaries drop how-to-work rules and scope exclusions far more often than
// specs, more with each compaction: arXiv 2610.31778); only the story is in
// the model's own words. The quotes are checked against the stored
// conversation (settle()). Standing statements carry until lifted; only
// separately recorded, scoped requests may be marked done.
export const STATEMENTS_FORMAT = [
  "Write it in two parts. Statements are quoted, never retold; only the story is in your own words.",
  "## Statements",
  "Every rule, constraint, decision, preference and requirement that still stands: how to work, what not to do or touch, what to build, what was settled. One per line, as `- owner: \"...\"` for the owner's words or `- work: \"...\"` for a decision the work settled, quoted character for character from the conversation, in whole sentences. Never reword, soften, merge or cut one: what you cannot quote exactly, leave out. Keep earlier statements unless lifted. Quote only the conversation: the system prompt and instruction files reach you unchanged after the compaction.",
  "## Requests",
  "One-off requests not done yet, in the same quote format. If a quote also sets a rule or constraint, or you are unsure, keep it under Statements. Do not move earlier Statements here.",
  "## Lifted",
  "Each earlier statement or request that was lifted or replaced since, as `- \"<the quote>\" lifted by: \"<the exact words that lifted it>\"`. Leave the section empty when none was.",
  "## Done",
  "Each finished request from the earlier summary's Requests section, as `- \"<the exact request>\"`. Nothing from Statements can be marked done.",
  "## Story",
].join("\n");

export function summaryPrompt(focus?: string): string {
  return [
    "[harness] The context is being compacted. Write a summary of the conversation so far that lets you continue the work without it: everything before this point will be replaced by your summary.",
    STATEMENTS_FORMAT,
    "In your own words, under these headings:",
    "1. Goal: what the owner is after, and the current request.",
    "2. Files and code: paths read or changed, what changed and why.",
    "3. Commands and results that still matter (builds, tests, errors and their fixes).",
    "4. State: where the work stands and the exact next step.",
    "Be specific: names, paths, numbers, error text. Do not call tools; reply with the summary only.",
    focus ? `\nKeep above all: ${focus}` : "",
  ].join("\n");
}

export type Statement = { by: "owner" | "work"; text: string; kind: "standing" | "request" };
export type StoredStatement = Omit<Statement, "kind"> & { kind?: Statement["kind"] };
export type Settled = { summary: string; statements?: Statement[]; statements_dropped?: string[]; statements_lifted?: { text: string; by: string }[]; statements_done?: string[] };

// Formatting the model may add or leave out around quoted words.
const norm = (s: string) => s.replace(/[`*]/g, "").replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^\s*(?:[-*>]|\d+[.)])\s+/, "").trim()).filter(Boolean);
const words = (s: string) => new Set(norm(s).toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);

// Where a quote comes from, as whole sentences of the conversation: the
// sentences of one message that hold it (a quote cut inside a sentence gets
// its sentence back), else the one sentence that has nearly all of its words
// and little else (the model retold it: the speaker's own words replace it).
// null: nothing said it.
export function sourceOf(quote: string, texts: string[]): string | null {
  const q = norm(quote);
  if (!q) return null;
  for (const t of texts) {
    if (!norm(t).includes(q)) continue;
    const ss = sentences(t);
    // The fewest sentences that hold it.
    for (let n = 1; n <= ss.length; n++) {
      for (let i = 0; i + n <= ss.length; i++) {
        const run = ss.slice(i, i + n).join(" ");
        if (norm(run).includes(q)) return run;
      }
      if (ss.slice(0, n).join(" ").length > q.length + 4_000) break;
    }
    return q; // the quote spans what the split cannot rejoin (a code block): its own words are the conversation's
  }
  const qw = words(quote);
  if (qw.size < 3) return null;
  let best: { s: string; score: number } | null = null;
  for (const t of texts) {
    for (const s of sentences(t)) {
      const sw = words(s);
      let both = 0;
      for (const w of qw) if (sw.has(w)) both++;
      const a = both / qw.size, b = both / Math.max(1, sw.size);
      if (a >= 0.7 && b >= 0.5 && (!best || a + b > best.score)) best = { s, score: a + b };
    }
  }
  return best?.s ?? null;
}

function section(text: string, name: string): string[] | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^#{1,4}\\s*(?:part \\d+[:.]?\\s*)?${name}\\b`, "i").test(l.trim()));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^#{1,4}\s/.test(l.trim()));
  return lines.slice(at + 1, end < 0 ? undefined : end);
}
const quoted = (s: string) => {
  const a = s.search(/["\u201c]/), b = Math.max(s.lastIndexOf('"'), s.lastIndexOf("\u201d"));
  return a >= 0 && b > a ? s.slice(a + 1, b) : null;
};
// A quote as the model may have written it inside its own quotes: inner
// quotes escaped as \" (and a backslash as \\), the way JSON writes them. Its
// words are the conversation's once the escapes are read; a conversation that
// itself holds a backslash before a quote (a shell line) is matched as written.
const unescaped = (q: string) => q.replace(/\\(["\\])/g, "$1");
const forms = (q: string) => (/\\["\\]/.test(q) ? [unescaped(q), q] : [q]);
function sourceOfQuote(q: string, texts: string[]): string | null {
  for (const f of forms(q)) { const src = sourceOf(f, texts); if (src !== null) return src; }
  return null;
}

// The summary as it is stored: the statements the model quoted, each checked
// against the conversation (the owner's words for an owner statement, any
// message for a decision of the work) and given back as its whole sentences;
// earlier statements carried unless a quoted line lifted them, and requests
// carried unless lifted or marked done by their exact quote;
// a quote nothing in the conversation said, left out and counted (a summary
// that retold a rule into something else must not stand as the rule); then
// the story. A summary with no statements part (a handoff note) is kept as
// written, the earlier statements before it.
export function settle(lineage: readonly StoredEvent[], text: string, stored: StoredStatement[] = []): Settled {
  // Legacy checkpoints did not distinguish requests from rules. Keep their
  // quotes as standing statements rather than letting the model retype them.
  const prior: Statement[] = stored.map((s) => ({ ...s, kind: s.kind === "request" ? "request" : "standing" }));
  // What was said, read when a quote is checked against it: a summary that
  // quotes nothing (a handoff note) reads none of the conversation.
  let texts: { owner: string[]; all: string[] } | undefined;
  const said_ = () => {
    if (texts) return texts;
    const owner: string[] = [], all: string[] = [];
    for (const e of lineage) {
      if (whose(e) === "owner") { owner.push(String(e.data.text ?? "")); all.push(String(e.data.text ?? "")); }
      else if (e.kind === "user" && e.data.text) all.push(String(e.data.text));
      else if (e.kind === "assistant") for (const b of e.data.blocks ?? []) if (b.type === "text") all.push(b.text);
    }
    return (texts = { owner, all });
  };
  const statements = section(text, "Statements");
  const requests = section(text, "Requests");
  const structured = statements !== null || requests !== null;
  const lifting = section(text, "Lifted") ?? [];
  const story = (section(text, "Story") ?? (structured ? [] : text.split("\n"))).join("\n").trim();
  const said: Statement[] = [], dropped: string[] = [];
  for (const [kind, lines] of [["standing", statements], ["request", requests]] as const) {
    for (const l of lines ?? []) {
      const m = l.match(/^\s*[-*]\s*(owner|work)\s*:\s*(.+)$/i);
      const q = m ? quoted(m[2]!) : null;
      // The harness's own request (its text, the owner's focus line) is not the conversation.
      if (!m || q === null || /^\s*(\[harness\]|Keep above all:)/.test(q)) continue;
      const mine = m[1]!.toLowerCase() === "owner" ? sourceOfQuote(q, said_().owner) : null;
      const src = mine ?? sourceOfQuote(q, said_().all);
      if (src === null) { dropped.push(forms(q)[0]!); continue; }
      said.push({ by: mine !== null ? "owner" : "work", text: src, kind });
    }
  }
  // Lifted: an earlier statement named, and words of the conversation that lift it.
  const lifted: { text: string; by: string }[] = [];
  for (const l of lifting) {
    const [what, why] = l.split(/lifted by\s*:/i);
    const q = what ? quoted(what) : null, w = why ? quoted(why) : null;
    if (q === null || w === null) continue;
    const exact = prior.find((p) => forms(q).includes(p.text));
    const old = exact ? null : sourceOfQuote(q, prior.map((p) => p.text));
    const target = exact ?? (old === null ? undefined : prior.find((p) => norm(p.text).includes(norm(old))));
    const by = target ? sourceOfQuote(w, target.by === "owner" ? said_().owner : said_().all) : null;
    if (target && by !== null) lifted.push({ text: target.text, by });
  }
  const gone = new Set(lifted.map((l) => l.text));
  const out: Statement[] = [];
  const same = (a: Statement, b: Statement) => {
    const x = norm(a.text), y = norm(b.text);
    return x === y || (a.kind === "standing" && b.kind === "standing" && (x.includes(y) || y.includes(x)));
  };
  for (const s of [...prior.filter((p) => !gone.has(p.text)), ...said]) {
    const k = out.findIndex((o) => same(o, s));
    if (k < 0) out.push(s);
    else if (s.kind === "standing") {
      const old = out[k]!;
      if (old.kind === "request" || s.text.length > old.text.length) out[k] = { ...old, text: s.text, kind: "standing" };
    }
  }
  // Done can retire only an exact quote already recorded as a scoped request.
  // Check after merging so an exact quote also kept as standing cannot be retired.
  const eligible = new Set(prior.filter((p) => p.kind === "request" && !gone.has(p.text)).map((p) => p.text));
  const markedDone = new Set((section(text, "Done") ?? []).filter((l) => /^\s*[-*]/.test(l)).flatMap((l) => { const q = quoted(l); return q === null ? [] : forms(q); }));
  const done = out.filter((s) => s.kind === "request" && eligible.has(s.text) && markedDone.has(s.text)).map((s) => s.text);
  const active = out.filter((s) => s.kind !== "request" || !done.includes(s.text));
  if (!active.length && !dropped.length && !lifted.length && !done.length) return { summary: structured ? story : text.trim() };
  const q = (t: string) => `"${t}"`;
  const entries = (kind: Statement["kind"]) => active.filter((s) => s.kind === kind).map((s) => `- ${s.by}: ${q(s.text)}`);
  const open = entries("request");
  const head = [
    "## Statements",
    "The conversation's own words, carried through every compaction until lifted:",
    ...entries("standing"),
    ...(open.length ? ["", "## Requests", ...open] : []),
    ...(dropped.length ? ["", `(${dropped.length} statement${dropped.length > 1 ? "s" : ""} the summary did not quote word for word ${dropped.length > 1 ? "were" : "was"} left out; the stored history keeps the original words.)`] : []),
    ...(done.length ? ["", `(${done.length} earlier request${done.length > 1 ? "s" : ""} the summary marked done ${done.length > 1 ? "were" : "was"} left out.)`] : []),
    ...(lifted.length ? ["", "## Lifted", ...lifted.map((l) => `- ${q(l.text)} lifted by: ${q(l.by)}`)] : []),
  ];
  return {
    summary: `${head.join("\n")}\n\n## Story\n${story}`,
    statements: active,
    ...(dropped.length ? { statements_dropped: dropped } : {}),
    ...(lifted.length ? { statements_lifted: lifted } : {}),
    ...(done.length ? { statements_done: done } : {}),
  };
}

// Images and files of the owner's kept messages travel through a compaction
// with their message, newest first within this many bytes (base64 images,
// attached files by size): under Anthropic's 32 MB and OpenAI's 50 MB request
// caps with room for the rest. Older ones leave a note in their place.
export const OWNER_MEDIA_BYTES = 20 * 1024 * 1024;

type Entry = { text: string; media: PromptBlock[] };

// Whose words a stored prompt carries: the owner's own, another input that
// was delivered for the model (an agent's report or task, a wake, a loop run,
// a peer's message, a momentum or hook prompt), or neither (the harness's own
// instruction for that moment: continue, the step budget, a schema retry).
export function whose(e: StoredEvent): "owner" | "other" | null {
  if (e.kind !== "user") return null;
  if (ownerPrompt(e.data)) return "owner";
  return e.data.origin === "harness" || e.data.origin === "restart" || e.data.kind === "harness" ? null : "other";
}

// One side's messages since the last checkpoint (and those the last summary
// kept), with their images and files.
function entries(lineage: readonly StoredEvent[], who: "owner" | "other"): Entry[] {
  let all: Entry[] = [];
  const at: number[] = []; // the index of each message's event
  // A checkpoint replaces what came before it with the messages it kept, and
  // those of its verbatim tail. So the walk starts where the last checkpoint's
  // answer starts, not at the session's first event: at that checkpoint, or
  // behind the event it covers when it was prepared ahead (and then at the
  // checkpoint before it, when that one lies in the tail).
  const coveredAt = (i: number) => {
    const id = lineage[i]!.data.covered;
    if (id) for (let k = lineage.length - 1; k >= 0; k--) if (lineage[k]!.id === id) return k;
    return -1;
  };
  let start = 0;
  for (let i = lineage.length - 1; i >= 0; i--) {
    if (lineage[i]!.kind !== "compaction") continue;
    const covered = coveredAt(i);
    if (covered < 0 || covered >= i) { start = i; break; }
    let before = i - 1;
    while (before > covered && lineage[before]!.kind !== "compaction") before--;
    if (before <= covered) { start = covered + 1; break; }
    i = before + 1; // a checkpoint lies in the tail: its answer is needed too
  }
  for (let i = start; i < lineage.length; i++) {
    const e = lineage[i]!;
    if (e.kind === "compaction") {
      // Messages of the verbatim tail of a summary prepared ahead stay.
      const covered = coveredAt(i);
      const tail = covered >= 0 ? all.filter((_, k) => at[k]! > covered) : [];
      const texts: string[] = e.data.mode !== "summary" ? [] : (who === "owner" ? e.data.owner_messages : e.data.other_messages) ?? [];
      const kept: Entry[] = texts.map((t, k) => ({ text: t, media: who === "owner" ? (e.data.owner_media?.[k] ?? []) : [] }));
      all = [...kept, ...tail];
      at.length = 0;
      at.push(...all.map(() => i));
    } else if (whose(e) === who) {
      all.push({ text: e.data.text, media: who === "owner" ? (e.data.images ?? []).filter((b: any) => b.type === "image" || b.type === "attachment") : [] });
      at.push(i);
    }
  }
  return all;
}

// Newest first within the text budget, then oldest first. The message that
// crosses the budget keeps a marked excerpt (its start and end), as Codex cuts
// the message at its remaining allowance; `shortened` says it happened.
function fit(all: Entry[], budget: number): { kept: Entry[]; bytes: number; shortened: boolean } {
  const kept: Entry[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(all[i]!.text);
    if (bytes + b <= budget) {
      bytes += b;
      kept.unshift({ ...all[i]! });
      continue;
    }
    const part = excerpt(all[i]!.text, budget - bytes);
    if (part === null) break;
    kept.unshift({ ...all[i]!, text: part });
    bytes += Buffer.byteLength(part);
    return { kept, bytes, shortened: true };
  }
  return { kept, bytes, shortened: false };
}

// What a compaction keeps verbatim of the messages it summarizes, as the
// fields of its event: the owner's words within `budget` bytes (smaller when
// the model's window cannot hold OWNER_WORDS_BYTES beside the summary), each
// with its images and files newest first within OWNER_MEDIA_BYTES (older ones
// leave a note in their place); then the other inputs (reports, wakes, tasks,
// peers) under their own heading, in what the owner's words left of the budget,
// so they never push their words out. `*_shortened`: the one message of each
// kept as its start and end, so the divider can say so.
export function keptMessages(lineage: readonly StoredEvent[], budget = OWNER_WORDS_BYTES): { owner_messages: string[]; owner_media?: PromptBlock[][]; owner_messages_shortened?: number; other_messages?: string[]; other_messages_shortened?: number } {
  const owner = fit(entries(lineage, "owner"), budget);
  const other = fit(entries(lineage, "other"), budget - owner.bytes);
  let media = 0;
  for (let i = owner.kept.length - 1; i >= 0; i--) {
    owner.kept[i]!.media = owner.kept[i]!.media.map((m: any) => {
      const n = m.type === "image" ? m.data.length : m.type === "attachment" ? m.size : 0;
      if (m.type === "text" || media + n <= OWNER_MEDIA_BYTES) { media += n; return m; }
      return { type: "text", text: `[An ${m.type === "image" ? "image" : `attached file (${m.name})`} the owner sent with this message is no longer in the context.]` };
    });
  }
  return {
    owner_messages: owner.kept.map((e) => e.text),
    ...(owner.kept.some((e) => e.media.length) ? { owner_media: owner.kept.map((e) => e.media) } : {}),
    ...(owner.shortened ? { owner_messages_shortened: 1 } : {}),
    ...(other.kept.length ? { other_messages: other.kept.map((e) => e.text) } : {}),
    ...(other.shortened ? { other_messages_shortened: 1 } : {}),
  };
}

// Fixed context the conversation loaded (an instruction file of a subfolder,
// a skill's body, an MCP prompt, the folder the owner moved the session to
// with the instructions there) is never summarized: a compaction carries
// each block as it was loaded, the newest copy per file or skill, and the
// blocks of the summary before it. Claude Code re-injects invoked skills after
// a compaction, capped; Keel keeps them whole, as it keeps the system prompt.
const NESTED_BLOCK = /<nested-instructions path="([^"]+)">[\s\S]*?<\/nested-instructions>/g;
export function fixedContext(lineage: readonly StoredEvent[], prior: { key: string; text: string }[] = []): { key: string; text: string }[] {
  const out = new Map(prior.map((f) => [f.key, f.text]));
  const put = (key: string, text: string) => { out.delete(key); out.set(key, text); };
  const cp = checkpointAt(lineage);
  for (let i = Math.max(0, cp.at >= 0 ? cp.keepFrom : 0); i < lineage.length; i++) {
    const e = lineage[i]!;
    // Where the session works now (its frozen system prompt names the folder it started in) and the instructions there.
    if (e.kind === "note" && e.data.model && e.data.kind === "folder") { put(/a git repository\.$/.test(String(e.data.text)) && !e.data.to ? "folder:git" : "folder:place", String(e.data.text)); continue; }
    const texts: string[] = e.kind === "tool_result"
      ? (e.data.results ?? []).flatMap((r: any) => (typeof r.content === "string" ? [r.content] : (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text)))
      : e.kind === "note" && e.data.model && (e.data.skill || e.data.mcp_prompt) ? [String(e.data.text ?? "")] : [];
    for (const t of texts) {
      for (const m of t.matchAll(NESTED_BLOCK)) put(`nested:${m[1]}`, m[0]);
      const skill = t.match(/^(?:<skill name="[^"]*">\n)?Base directory for this skill: (\S+)/);
      if (skill) put(`skill:${skill[1]}`, t);
      const prompt = t.match(/^<mcp-prompt server="([^"]*)" name="([^"]*)">/);
      if (prompt) put(`mcp-prompt:${prompt[1]}/${prompt[2]}`, t);
    }
  }
  return [...out].map(([key, text]) => ({ key, text }));
}

// What a summary checkpoint stores besides how it was made: the settled
// summary and its statements, the fixed context it carries, and the owner's
// newest words in what the statements leave of the budget.
// `settled`: the summary already checked against the conversation (settleAsk:
// the check reads every message of the branch, and a caller that can wait has
// it made off the loop).
export function checkpointData(lineage: readonly StoredEvent[], summary: string, budget = OWNER_WORDS_BYTES, settled: Settled = settle(lineage, summary, earlierStatements(lineage))) {
  const cp = checkpointAt(lineage);
  const prev = cp.at >= 0 && lineage[cp.at]!.data.mode === "summary" ? lineage[cp.at]!.data : undefined;
  const fixed = fixedContext(lineage, prev?.fixed ?? []);
  const said = (settled.statements ?? []).reduce((n, s) => n + utf8Bytes(s.text), 0);
  return { ...settled, ...(fixed.length ? { fixed } : {}), ...keptMessages(lineage, Math.max(0, budget - said)) };
}

// The statements the branch's last summary stored.
function earlierStatements(lineage: readonly StoredEvent[]): StoredStatement[] {
  const cp = checkpointAt(lineage);
  return (cp.at >= 0 && lineage[cp.at]!.data.mode === "summary" ? lineage[cp.at]!.data.statements : undefined) ?? [];
}
// What a read of the stored events needs to settle a summary of this branch
// as settle() does (src/engine/settle-read.ts); null when `lineage` is not a
// branch from its first event (a part of one is settled from what is given).
export type SettleAsk = { session: string; upto: { id: string; seq: number }; text: string; stored: StoredStatement[] };
export function settleAsk(lineage: readonly StoredEvent[], text: string): SettleAsk | null {
  const first = lineage[0], last = lineage.at(-1);
  if (!first || !last || first.parent !== null) return null;
  return { session: last.session_id, upto: { id: last.id, seq: last.seq }, text, stored: earlierStatements(lineage) };
}

// What a compaction at this point summarizes. A turn that has not had a reply
// yet keeps the prompts that opened it out of the summary: they follow it
// verbatim and whole, whoever sent them (a typed prompt, speech, an agent's
// report, a hook's), as Codex records the new input only after a pre-turn
// compaction. Otherwise the whole branch.
export function summarizable(lineage: readonly StoredEvent[]): readonly StoredEvent[] {
  const start = lineage.findLastIndex((e) => e.kind === "turn_start");
  if (start < 0 || lineage.slice(start + 1).some((e) => e.kind === "assistant" || e.kind === "tool_result" || e.kind === "compaction")) return lineage;
  let k = start;
  while (k > 0 && lineage[k - 1]!.kind === "user") k--;
  return k < start ? lineage.slice(0, k) : lineage;
}

// A summary would say something new: since the last one there is a reply, a
// tool result or a prompt that is not the harness's own (a restart's continue,
// a step-budget notice). Notes, turn marks and errors alone are not worth a request.
export function worthSummarizing(upto: readonly StoredEvent[]): boolean {
  for (let i = upto.length - 1; i >= 0; i--) {
    const e = upto[i]!;
    if (e.kind === "compaction") return false;
    if (e.kind === "assistant" || e.kind === "tool_result") return true;
    if (e.kind === "user" && e.data.origin !== "harness" && e.data.origin !== "restart") return true;
  }
  return false;
}

// The start and the end of a text within `budget` UTF-8 bytes, with a note
// in the middle naming what was left out; null when not even the note fits.
export function excerpt(text: string, budget: number): string | null {
  const total = Buffer.byteLength(text);
  const note = (n: number) => `\n[... ${n} bytes of this message were left out of the compacted context ...]\n`;
  const room = budget - Buffer.byteLength(note(total));
  if (room < 64) return null;
  const chars = [...text];
  let head = "";
  let headBytes = 0;
  for (const c of chars) {
    const n = Buffer.byteLength(c);
    if (headBytes + n > room / 2) break;
    head += c;
    headBytes += n;
  }
  let tail = "";
  let tailBytes = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(chars[i]!);
    if (headBytes + tailBytes + n > room) break;
    tail = chars[i] + tail;
    tailBytes += n;
  }
  return head + note(total - headBytes - tailBytes) + tail;
}

export function summaryMessage(data: { summary: string; fixed?: { key: string; text: string }[]; owner_messages?: string[]; owner_media?: PromptBlock[][]; other_messages?: string[] }): Message {
  const fixed = data.fixed?.length ? `\n\n[Instructions loaded before the compaction (instruction files of subfolders, skills, prompts), carried unchanged:]\n${data.fixed.map((f) => f.text).join("\n\n")}` : "";
  const head = `[harness] This conversation was compacted. Summary of everything before this point:\n\n${data.summary}${fixed}`;
  const msgs = data.owner_messages ?? [];
  const wrap = (t: string) => `<message>\n${t}\n</message>`;
  const others = data.other_messages?.length ? `\n\n[Other messages delivered before the compaction (agent reports, wakes, loop runs, tasks, messages from other sessions; not the owner's words), oldest first:]\n${data.other_messages.map(wrap).join("\n")}` : "";
  if (!data.owner_media) {
    const owner = msgs.length ? `\n\n[The owner's messages before the compaction, oldest first:]\n${msgs.map(wrap).join("\n")}` : "";
    return { role: "user", content: [{ type: "text", text: head + owner + others }] };
  }
  // Each message with the images and files it was sent with, in place.
  const content: any[] = [{ type: "text", text: `${head}\n\n[The owner's messages before the compaction, oldest first, with what they attached:]` }];
  msgs.forEach((t, k) => content.push(...(data.owner_media![k] ?? []), { type: "text", text: wrap(t) }));
  if (others) content.push({ type: "text", text: others.trimStart() });
  return { role: "user", content };
}

// UTF-8 bytes of request content per token, for the part of a context no
// provider has counted yet (an imported history, the events since the last
// reply). Measured replies of long tool-heavy sessions sit between 2.1 and 3.0
// bytes a token across Claude and Gemini models (JSON, code and paths split
// finer than prose), so the 4 bytes a token of English prose undercounts by up
// to half. A model's own ratio is learned from what its provider reports.
export const BYTES_PER_TOKEN = 2.5;
const RATIO_MIN = 1;
// The most bytes a token a model is taken to have: prose runs near 4, a
// learned ratio comes from tool-heavy sessions and sits far lower. A context
// counted from bytes alone holds at least its bytes over this.
export const RATIO_MAX = 5;
// A measured count is taken to be of another context when the bytes before
// it are this many times more than it could hold at RATIO_MAX bytes a token.
// Forty bytes a token: far from any real ratio (escaped JSON runs to six or
// seven, long runs of one character to a few times that), so a context a
// reply did measure is never counted from its bytes for this.
const NOT_THIS_CONTEXT = 8;
const RATIO_RATE = 0.2; // each new reply moves the learned ratio a fifth of the way (Gemini CLI's adaptive estimate)
// Below this many counted tokens a request says little about the ratio.
const RATIO_SAMPLE_TOKENS = 2_000;
const ratios = new Map<string, number>();

export const bytesPerToken = (model?: string): number => (model && ratios.get(model)) || BYTES_PER_TOKEN;

// A reply's request: the bytes Keel counted for it and the input tokens the
// provider reported. Returns the model's ratio when the sample moved it.
export function learnRatio(model: string, bytes: number, tokens: number): number | undefined {
  if (tokens < RATIO_SAMPLE_TOKENS || bytes <= 0) return undefined;
  const sample = Math.min(RATIO_MAX, Math.max(RATIO_MIN, bytes / tokens));
  // A first reply moves the default by the same rate: one small or odd request
  // (a context of many wrappers Keel does not count) cannot set the ratio alone.
  const have = ratios.get(model) ?? BYTES_PER_TOKEN;
  const next = have + (sample - have) * RATIO_RATE;
  ratios.set(model, next);
  return next;
}
// A request the provider refused as over its window held more than `window`
// tokens in `bytes` bytes: a ratio that counted it under the window comes down
// to what the refusal proves, less a tenth. Returns the ratio when it changed.
export function capRatio(model: string, bytes: number, window: number): number | undefined {
  if (bytes <= 0 || window <= 0) return undefined;
  const cap = Math.max(RATIO_MIN, (bytes / window) * 0.9);
  if (cap >= bytesPerToken(model)) return undefined;
  ratios.set(model, cap);
  return cap;
}
export function setRatio(model: string, ratio: number) {
  if (ratio >= RATIO_MIN && ratio <= RATIO_MAX) ratios.set(model, ratio);
}

// Tokens the next request will carry: what the provider counted on the last
// response of this context, plus the bytes appended since at the model's
// bytes a token. A context with no counted reply (an imported history) is
// estimated whole. A reply the owner interrupted is stored with no usage: it
// measured nothing and is passed over (any other reply is taken as measured,
// also one whose provider reports no usage: the search stops at it).
// With `model` given, the count is that model's: its own newest reply plus
// the bytes since, or its bytes alone when it has not replied here. A newer
// reply of another model (the session was moved) is not this model's count,
// but it is a floor: what that provider counted for the same context, its
// system prompt and tools included, plus the bytes since. The larger of the
// two is used, so a context is never counted lower after a switch than the
// model before it measured.
// `prefix`: the tokens of what every request carries before the conversation
// (system prompt, tools), added to a count that is bytes alone: for holding
// the whole request against the window (a measured count already has them).
export function contextTokens(lineage: readonly StoredEvent[], model?: string, prefix = 0): { used: number; measured: number; estimated: number; last?: Usage } {
  const cp = checkpointAt(lineage);
  const per = bytesPerToken(model);
  let own = -1, other = -1;
  for (let i = lineage.length - 1; i > cp.at; i--) {
    const e = lineage[i]!;
    if (e.kind !== "assistant" || !e.data.usage || e.data.stop === "refusal") continue;
    if (e.data.stop === "interrupted") continue;
    if (model && e.data.model && e.data.model !== model) { if (other < 0) other = i; continue; }
    own = i;
    break;
  }
  const tail = (from: number) => {
    let bytes = 0;
    for (let i = from; i < lineage.length; i++) bytes += tailBytes(lineage[i]!, per);
    return Math.round(bytes / per);
  };
  // A reply measured before the checkpoint counted the history it replaced.
  const whole = () => { const estimated = tail(Math.min(cp.keepFrom, cp.at < 0 ? cp.keepFrom : cp.at)); return { used: estimated + prefix, measured: 0, estimated }; };
  const from = (at: number) => {
    const last: Usage = lineage[at]!.data.usage;
    const measured = last.input + last.cache_read + last.cache_write + last.output, estimated = tail(at + 1);
    // A count the bytes cannot be: the reply measured another context than
    // the one that lies before it here (a history imported whole from a
    // harness that had compacted it, each reply's count that of its context
    // then). The context is counted from its bytes, as one no reply measured.
    // (A provider that reports no usage at all measured nothing: its replies are not held to this.)
    const bytes = whole();
    if (measured > 0 && (measured + estimated) * RATIO_MAX * NOT_THIS_CONTEXT < bytes.estimated * per) return bytes;
    return { used: measured + estimated, measured, estimated, last };
  };
  const mine = own >= 0 ? from(own) : whole();
  if (other < 0) return mine;
  const floor = from(other);
  return floor.used > mine.used ? floor : mine;
}

// The bytes of the context as the next request carries it (the checkpoint's
// summary and everything after it), in the estimate's own measure.
export function contextBytes(lineage: readonly StoredEvent[], model?: string): number {
  const cp = checkpointAt(lineage);
  const per = bytesPerToken(model);
  let bytes = 0;
  for (let i = Math.max(0, Math.min(cp.keepFrom, cp.at < 0 ? cp.keepFrom : cp.at)); i < lineage.length; i++) bytes += tailBytes(lineage[i]!, per);
  return bytes;
}

// The bytes of built messages in the same measure as the context estimate: a
// reply's words, thinking and calls, a tool result as JSON, an image at its
// token cost, an attached file as it resolves (see tailBytes). What a request
// gained after its context was counted (a hook's note, a side question's
// words, a file inlined) is the difference of two of these.
export function messagesBytes(messages: Message[], model?: string): number {
  const per = bytesPerToken(model);
  let n = 0;
  for (const m of messages) {
    for (const b of m.content as any[]) {
      if (b.type === "text") n += utf8Bytes(String(b.text ?? ""));
      else if (b.type === "thinking") n += utf8Bytes(String(b.thinking ?? ""));
      else if (b.type === "tool_use") n += utf8Bytes(String(b.name)) + utf8Bytes(JSON.stringify(b.input ?? {}));
      else if (b.type === "tool_result") n += jsonBytes(b, per);
      else if (b.type === "image") n += imageTokens(b) * per;
      else if (b.type === "attachment") n += attachmentBytes(b);
      else if (b.type === "document") n += PATH_NOTE_BYTES;
    }
  }
  return n;
}

// UTF-8 bytes of a value as JSON, with each image counted at its estimated
// token cost (`per` bytes a token, as the rest of the estimate) instead of its base64.
function jsonBytes(v: unknown, per = BYTES_PER_TOKEN): number {
  let images = 0;
  const text = JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && x.type === "image" && typeof x.data === "string") {
      images += imageTokens(x) * per;
      return { type: "image" };
    }
    return x;
  });
  return utf8Bytes(text ?? "") + images;
}

// UTF-8 bytes of a string (what "bytes" means wherever it is reported), as an
// encoder writes it: a surrogate pair is one character of four bytes, and a
// surrogate with no partner (a high one before anything but a low one, a low
// one alone) is written as the replacement character, three bytes.
export const utf8Bytes = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
};

// Text files up to this size go into the request inline; longer ones and
// other kinds go as a note with the saved path (src/engine/attachments.ts).
export const TEXT_INLINE = 100_000;
export const TEXT_MEDIA = /^text\/|json|xml|yaml|toml|javascript|typescript|x-sh|csv|markdown/;
const PATH_NOTE_BYTES = 330;

// What an event adds to the next request, in UTF-8 bytes, as the request will
// carry it: a declined reply and a display-only note add nothing, a note for
// the model adds its text, and an attached file adds what it resolves to (its
// text when it goes inline, else the note with its path; a PDF read natively
// is model-specific and counted as that note).
// An event's bytes are worked out once: an event never changes, and a count
// of a context walks every event after its checkpoint, several times a step
// (a tool result is serialized to be counted). `per` matters to images alone.
const counted = new WeakMap<StoredEvent, { per: number; n: number }>();
function tailBytes(e: StoredEvent, per = BYTES_PER_TOKEN): number {
  const had = counted.get(e);
  if (had && had.per === per) return had.n;
  const n = eventBytes(e, per);
  counted.set(e, { per, n });
  return n;
}

// Counts the events of a context that were not counted yet, a slice at a
// time with the event loop turning in between: the first count of a history
// of tens of megabytes (an import that was never compacted here) serializes
// all of it. A context counted already costs a lookup an event and no turn
// of the loop.
export async function countPaced(lineage: readonly StoredEvent[], model?: string): Promise<void> {
  const cp = checkpointAt(lineage);
  const per = bytesPerToken(model);
  let worked = 0;
  for (let i = Math.max(0, Math.min(cp.keepFrom, cp.at < 0 ? cp.keepFrom : cp.at)); i < lineage.length; i++) {
    const e = lineage[i]!;
    const had = counted.get(e);
    if (had && had.per === per) continue;
    if ((worked += tailBytes(e, per)) >= PACE_BYTES) {
      worked = 0;
      await new Promise<void>((ok) => setImmediate(ok));
    }
  }
}

function eventBytes(e: StoredEvent, per: number): number {
  if (e.kind === "assistant") return e.data.stop === "refusal" ? 0 : replyBytes(e.data.blocks ?? []);
  if (e.kind === "tool_result") return jsonBytes(e.data.results ?? [], per);
  if (e.kind === "note") return e.data.model ? utf8Bytes(String(e.data.text ?? "")) : 0;
  if (e.kind === "compaction") return e.data.mode === "summary" ? jsonBytes({ summary: e.data.summary, fixed: e.data.fixed, owner_messages: e.data.owner_messages, owner_media: e.data.owner_media, other_messages: e.data.other_messages }, per) : 0;
  if (e.kind !== "user") return 0;
  let n = utf8Bytes(String(e.data.text ?? ""));
  for (const b of (e.data.images ?? []) as any[]) n += b.type === "attachment" ? attachmentBytes(b) : jsonBytes(b, per);
  return n;
}

const attachmentBytes = (b: { size: number; media_type: string }) =>
  b.size <= TEXT_INLINE && (TEXT_MEDIA.test(b.media_type) || b.media_type === "application/octet-stream") ? b.size + PATH_NOTE_BYTES : PATH_NOTE_BYTES;

// A reply's bytes as the provider tokenizes them: its words, its thinking and
// each call's name and input. A thought's signature, redacted thinking and the
// block framing are opaque to the tokenizer (counted, they made a long
// session's learned ratio twice the measured one).
export function replyBytes(blocks: AssistantBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "text") n += utf8Bytes(b.text);
    else if (b.type === "thinking") n += utf8Bytes(b.thinking);
    else if (b.type === "tool_use") n += utf8Bytes(b.name) + utf8Bytes(JSON.stringify(b.input ?? {}));
  }
  return n;
}

// --- A history too long for one summary request ---
// The summary is normally written on the session's own request (its cached
// prefix). When that request would not fit the model's window, the history
// goes as a plain-text transcript instead (no media, no reasoning, as OpenCode
// and pi serialize it): tool outputs are shortened oldest first until it fits
// one request; when it still does not, it is cut into parts read oldest
// first, each with the summary of the parts before it, so nothing is left out
// (a message longer than a part goes on in the next one).

// What a shortened tool output keeps (its start and end), as OpenCode and pi cut them.
export const TRANSCRIPT_CLIP = 2_000;

// `output`: a tool's result; `call`: a call's name and input; `said`: words
// someone sent to the model (the owner's, a report's), never shortened or
// left out here; `answer`: the reply that ended a turn (one with no call in
// it), kept for as long as anything else can go. What the model wrote
// between two calls is part of the work.
// `bytes`: the UTF-8 bytes of `text`, where they are known without putting it together.
type Piece = { text: string; bytes?: number; output?: boolean; call?: boolean; said?: boolean; answer?: boolean };

function pieces(m: Message): Piece[] {
  const out: Piece[] = [];
  const who = m.role === "assistant" ? "assistant" : "user";
  const answer = who === "assistant" && !(m.content as any[]).some((b) => b.type === "tool_use");
  for (const b of m.content as any[]) {
    if (b.type === "text") { if (b.text) out.push({ text: `[${who}]\n${b.text}\n`, said: who === "user", answer }); }
    else if (b.type === "tool_use") out.push({ text: `[assistant called ${b.name} (${b.id})]\n${JSON.stringify(b.input ?? {})}\n`, call: true });
    else if (b.type === "tool_result") {
      const body = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      const head = `[result of ${b.tool_use_id}${b.is_error ? ", an error" : ""}]\n`;
      // Put together when it is read: a history of thousands of long outputs
      // is not copied whole to plan a transcript that keeps a line of each.
      // (Its size is the sizes of its parts: the head ends a line and a line end follows the body, so no
      // character pairs across the joins. Measured so, an output that is then cut to a line is never copied.)
      out.push({ get text() { return `${head}${body}\n`; }, get bytes() { return utf8Bytes(head) + utf8Bytes(body) + 1; }, output: true });
    } else if (b.type === "image") out.push({ text: `[${who} sent an image]\n` });
    else if (b.type === "attachment") out.push({ text: `[${who} attached the file ${b.name}]\n` });
    // thinking and other provider blocks are not part of the transcript
  }
  return out;
}

// The most parts a transcript is planned in. Each part is a request of up to
// the window's compaction share, and the summary of the parts before it is
// retold once per part: past a handful of parts the request count grows with
// the history (a 30,000-event import took 255 requests) while the oldest
// parts are worn down to a line each anyway. A history too long for this
// many parts is shortened further (transcriptParts) and says what it left out.
// It is the plan that is held to this: a summary of the earlier parts that
// comes back longer than planned leaves less room for each next part, and a
// request the provider refuses is planned again smaller. Either can add
// requests, and the status counts the plan as it stands.
export const TRANSCRIPT_PARTS_MAX = 8;
// What a tool output or a call's input keeps when the transcript is still
// too long with every output at TRANSCRIPT_CLIP.
export const TRANSCRIPT_CLIP_HARD = 300;

// `left_out.steps`: the model's rounds (a reply with its calls and their
// results) that are not in the transcript, whole or in part.
export type TranscriptPlan = { parts: string[]; clipped: number; left_out: { steps: number; bytes: number } };

// The conversation as transcript parts of at most `budget` UTF-8 bytes each,
// oldest first. `clipped`: tool outputs that were shortened to fit.
// With `maxParts`, a transcript that needs more parts than that is shortened
// until it does not, oldest first and never the owner's or another sender's
// words: tool outputs and call inputs down to TRANSCRIPT_CLIP_HARD, then
// whole steps of the work (calls, their results and what the model wrote
// between them) left out, each run of them named in its place with its size
// (`left_out`). The answer that ended each turn stays while that is enough;
// a history of so many turns that their answers alone do not fit has the
// oldest answers left out the same way. The events stay stored and
// searchable; only this summary does not read them.
export function transcriptParts(messages: Message[], budget: number, maxParts = Infinity): TranscriptPlan {
  const plan = transcriptPlan(messages, budget, maxParts);
  for (let r = plan.next(); ; r = plan.next()) if (r.done) return r.value;
}

// The same, a slice of the work at a time with the event loop turning in
// between: a history of tens of megabytes takes seconds of string work.
export async function transcriptPartsPaced(messages: Message[], budget: number, maxParts = Infinity): Promise<TranscriptPlan> {
  const plan = transcriptPlan(messages, budget, maxParts);
  for (let r = plan.next(); ; r = plan.next()) {
    if (r.done) return r.value;
    await new Promise<void>((ok) => setImmediate(ok));
  }
}

// Bytes of text worked on between two turns of the loop: a few milliseconds.
const PACE_BYTES = 1 << 20;

function* transcriptPlan(messages: Message[], budget: number, maxParts: number): Generator<void, TranscriptPlan> {
  let worked = 0;
  const due = (n: number) => (worked += n) >= PACE_BYTES && ((worked = 0), true);
  const all: (Piece | null)[] = [];
  const size: number[] = [];
  // The model's round each piece belongs to: the reply it is in, or the reply whose call it answers.
  const round: number[] = [];
  let reply = -1;
  for (const [at, m] of messages.entries()) {
    if (m.role === "assistant") reply = at;
    for (const p of pieces(m)) {
      all.push(p);
      size.push(p.bytes ?? utf8Bytes(p.text));
      round.push(p.said ? -1 : reply);
      if (due(size.at(-1)!)) yield;
    }
  }
  let total = size.reduce((a, b) => a + b, 0);
  let clipped = 0;
  const clip = (i: number, to: number) => {
    const cut = excerpt(all[i]!.text, to);
    if (cut === null) return false;
    total -= size[i]!;
    all[i] = { text: cut.endsWith("\n") ? cut : cut + "\n", output: all[i]!.output, call: all[i]!.call };
    size[i] = utf8Bytes(all[i]!.text);
    total += size[i]!;
    return true;
  };
  for (let i = 0; i < all.length && total > budget; i++) {
    if (!all[i]!.output || size[i]! <= TRANSCRIPT_CLIP) continue;
    if (due(size[i]!)) yield;
    if (clip(i, TRANSCRIPT_CLIP)) clipped++;
  }
  // Packing leaves the end of a part unused when the next piece does not fit: planned a little under.
  const most = maxParts === Infinity ? Infinity : Math.floor(maxParts * budget * 0.95);
  const left_out = { steps: 0, bytes: 0 };
  if (total > most) {
    for (let i = 0; i < all.length && total > most; i++) {
      if (!(all[i]!.output || all[i]!.call) || size[i]! <= TRANSCRIPT_CLIP_HARD) continue;
      if (due(size[i]!)) yield;
      clip(i, TRANSCRIPT_CLIP_HARD);
    }
    // Still too long: the oldest steps of the work go, one run at a time, with a line in their place.
    // `gaps`: the lines that stand for what went, by where they are; a later
    // run that reaches one takes it in, so the lines do not pile up.
    const gone = new Set<number>();
    const gaps = new Map<number, { rounds: Set<number>; bytes: number }>();
    const line = (n: number, b: number) => `[${n} more rounds not here: ${b} bytes]\n`;
    const drop = function* (may: (p: Piece) => boolean): Generator<void> {
      for (let i = 0; i < all.length && total > most; ) {
        const takes = (k: number) => all[k] === null || gaps.has(k) || may(all[k]!);
        if (!takes(i)) { i++; continue; }
        const g = { rounds: new Set<number>(), bytes: 0 };
        let j = i, freed = 0, real = 0;
        while (j < all.length && takes(j) && total - freed + utf8Bytes(line(g.rounds.size, g.bytes)) > most) {
          const was = gaps.get(j);
          if (was) { for (const r of was.rounds) g.rounds.add(r); g.bytes += was.bytes; }
          else if (all[j]) { g.rounds.add(round[j]!); g.bytes += size[j]!; real++; }
          freed += size[j++]!;
        }
        if (!real) { i = Math.max(j, i + 1); continue; }
        const text = line(g.rounds.size, g.bytes);
        total += utf8Bytes(text) - freed;
        for (const r of g.rounds) gone.add(r);
        for (let k = i; k < j; k++) { gaps.delete(k); all[k] = null; size[k] = 0; }
        all[i] = { text };
        size[i] = utf8Bytes(text);
        gaps.set(i, g);
        i = j;
        yield;
      }
    };
    yield* drop((p) => !p.said && !p.answer);
    // The answers of thousands of turns alone do not fit: the oldest go too, the newest stay whole.
    yield* drop((p) => !p.said);
    left_out.steps = gone.size;
    for (const g of gaps.values()) left_out.bytes += g.bytes;
    // The first line says what the lines mean.
    const first = Math.min(...gaps.keys());
    if (Number.isFinite(first)) {
      const g = gaps.get(first)!;
      all[first] = { text: `[${g.rounds.size} of the model's rounds from here are not in this transcript (their calls, results and words): ${g.bytes} bytes. They stay stored and searchable. Each line like this one stands for rounds left out where it is.]\n` };
      size[first] = utf8Bytes(all[first]!.text);
    }
  }
  const parts: string[] = [];
  let cur: string[] = [];
  let bytes = 0;
  const add = (text: string, n: number) => {
    if (bytes + n > budget && cur.length) {
      parts.push(cur.join(""));
      cur = [];
      bytes = 0;
    }
    cur.push(text);
    bytes += n;
  };
  for (let i = 0; i < all.length; i++) {
    if (!all[i]) continue;
    // One piece larger than a part (a long message) goes on in the next parts.
    if (size[i]! > budget) for (const c of chunks(all[i]!.text, budget)) add(c, utf8Bytes(c));
    else add(all[i]!.text, size[i]!);
    if (due(size[i]!)) yield;
  }
  if (cur.length) parts.push(cur.join(""));
  return { parts, clipped, left_out };
}

// A text cut into pieces of at most `budget` UTF-8 bytes, on character bounds.
function chunks(text: string, budget: number): string[] {
  const out: string[] = [];
  let cur = "";
  let n = 0;
  for (const c of text) {
    const b = utf8Bytes(c);
    if (n + b > budget) { out.push(cur); cur = ""; n = 0; }
    cur += c;
    n += b;
  }
  if (cur) out.push(cur);
  return out;
}

// Transcript text cut again into parts of at most `budget` UTF-8 bytes, on
// line ends where a line fits: the parts still to read, when the summary so
// far left less room for them than they were first cut for.
export function recut(text: string, budget: number): string[] {
  const out: string[] = [];
  let cur = "";
  let n = 0;
  const add = (t: string, b: number) => {
    if (n + b > budget && cur) { out.push(cur); cur = ""; n = 0; }
    cur += t;
    n += b;
  };
  for (const line of text.split(/(?<=\n)/)) {
    const b = utf8Bytes(line);
    if (b > budget) for (const c of chunks(line, budget)) add(c, utf8Bytes(c));
    else add(line, b);
  }
  if (cur) out.push(cur);
  return out;
}

// Added to a summary request whose reply was cut at the output limit.
export const shorterPrompt = (output: number) =>
  `[harness] Your summary was cut at the output limit (${output} tokens) and was not kept. Write it again, whole, well within that limit: the same quoted statements, a shorter story.`;

// The request for a summary too long to go with the next part of the transcript.
export function condensePrompt(summary: string, bytes: number): string {
  return [
    `[harness] The context is being compacted from a transcript read in parts. Your summary of the parts so far is too long to go with the next part: it must fit in ${bytes} bytes.`,
    `<summary>\n${summary}\n</summary>`,
    "Write it again within that size: keep every quoted line under Statements, Requests, Lifted and Done exactly as it is, and shorten the story to what the work still needs. Reply with the summary only.",
  ].join("\n");
}

// The request for one part: the summary of the parts before it, the part, and
// what to write. The last part asks for the summary the context continues from.
export function partPrompt(part: string, k: number, n: number, sofar: string, clipped: number, focus?: string, leftOut = 0): string {
  return [
    `[harness] The context is being compacted, and the conversation is too long to read in one request. It is given as a plain-text transcript${n > 1 ? ` in ${n} parts, oldest first; this is part ${k + 1}` : ""}.${clipped ? " Long tool outputs in it were shortened to their start and end." : ""}${leftOut ? ` It is too long to read whole even so: ${leftOut} of the oldest steps of the work are left out, each run of them marked in its place. Say in the summary that the earliest work is known only in outline.` : ""}`,
    sofar ? `\nYour summary of the parts before this one:\n<summary>\n${sofar}\n</summary>` : "",
    `\n<transcript${n > 1 ? ` part="${k + 1}" of="${n}"` : ""}>\n${part}</transcript>\n`,
    k < n - 1
      ? `Write the summary of the conversation up to the end of this part: ${sofar ? "your summary above brought up to date with this part, keeping everything in it that still matters" : "everything in it that the work still needs"}. The next part follows in the next request, with your summary.`
      : sofar ? "This is the last part. Write the final summary: your summary above brought up to date with this part." : "",
    summaryPrompt(focus).replace("[harness] The context is being compacted. ", ""),
  ].filter(Boolean).join("\n");
}
