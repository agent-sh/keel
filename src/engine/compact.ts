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
export function checkpointAt(lineage: StoredEvent[]): { at: number; keepFrom: number } {
  for (let i = lineage.length - 1; i >= 0; i--) {
    const e = lineage[i]!;
    if (e.kind !== "compaction") continue;
    const covered = e.data.covered ? lineage.findIndex((x) => x.id === e.data.covered) : -1;
    return { at: i, keepFrom: covered >= 0 && covered < i ? covered + 1 : i + 1 };
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

// When a request last read or wrote this context's cache: the newest reply,
// or a summary prepared after it (that call read the same prefix).
export function lastWarm(lineage: StoredEvent[], preparedMs = 0): number {
  const last = lineage.findLast((e) => e.kind === "assistant");
  return Math.max(last?.ts ?? 0, preparedMs);
}

// A prepared summary that covers up to `covered` still serves: it covers part
// of this branch after its last checkpoint, and for idle compaction (which
// covers the whole context) only notes came after it, such as a job notice its
// own request stored. Those follow it verbatim when it is applied.
export function preparedHolds(lineage: StoredEvent[], covered: string, idle: boolean): boolean {
  const at = lineage.findIndex((e) => e.id === covered);
  if (at < 0 || at <= checkpointAt(lineage).at) return false;
  return !idle || lineage.slice(at + 1).every((e) => e.kind === "note" || e.kind === "turn_start" || e.kind === "turn_end");
}

// A summary may shorten the conversation but never change what a statement
// means. Rules, constraints, decisions and requests are quoted, not retold
// (summaries drop how-to-work rules and scope exclusions far more often than
// specs, more with each compaction: arXiv 2610.31778); only the story is in
// the model's own words. The quotes are checked against the stored
// conversation (settle()), and the statements of the last summary are carried
// into the next one until the conversation lifts them.
export const STATEMENTS_FORMAT = [
  "Write it in two parts. Statements are quoted, never retold; only the story is in your own words.",
  "## Statements",
  "Every rule, constraint, decision and requirement that still stands, and every request not done yet: how to work, what not to do or touch, what to build, what was settled. One per line, as `- owner: \"...\"` for the owner's words or `- work: \"...\"` for a decision the work settled, quoted character for character from the conversation, in whole sentences. Never reword, soften, merge or cut one: what you cannot quote exactly, leave out. Keep every statement of an earlier summary unless it is lifted or done. Quote only the conversation: the system prompt and instruction files reach you unchanged after the compaction.",
  "## Lifted",
  "Each earlier statement that was lifted or replaced since, as `- \"<the statement>\" lifted by: \"<the exact words that lifted it>\"`. Leave the section empty when none was.",
  "## Done",
  "Each request of an earlier summary that is done now, as `- \"<the statement>\"`. Rules and constraints are never done; only lifted.",
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

export type Statement = { by: "owner" | "work"; text: string };
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

// The summary as it is stored: the statements the model quoted, each checked
// against the conversation (the owner's words for an owner statement, any
// message for a decision of the work) and given back as its whole sentences;
// the earlier summary's statements carried unless a quoted line lifted them;
// a quote nothing in the conversation said, left out and counted (a summary
// that retold a rule into something else must not stand as the rule); then
// the story. A summary with no statements part (a handoff note) is kept as
// written, the earlier statements before it.
export function settle(lineage: StoredEvent[], text: string, prior: Statement[] = []): Settled {
  const owner: string[] = [], all: string[] = [];
  for (const e of lineage) {
    if (whose(e) === "owner") { owner.push(String(e.data.text ?? "")); all.push(String(e.data.text ?? "")); }
    else if (e.kind === "user" && e.data.text) all.push(String(e.data.text));
    else if (e.kind === "assistant") for (const b of e.data.blocks ?? []) if (b.type === "text") all.push(b.text);
  }
  const lines = section(text, "Statements");
  const lifting = section(text, "Lifted") ?? [];
  const story = (section(text, "Story") ?? (lines ? [] : text.split("\n"))).join("\n").trim();
  const said: Statement[] = [], dropped: string[] = [];
  for (const l of lines ?? []) {
    const m = l.match(/^\s*[-*]\s*(owner|work)\s*:\s*(.+)$/i);
    const q = m ? quoted(m[2]!) : null;
    // The harness's own request (its text, the owner's focus line) is not the conversation.
    if (!m || q === null || /^\s*(\[harness\]|Keep above all:)/.test(q)) continue;
    const mine = m[1]!.toLowerCase() === "owner" ? sourceOf(q, owner) : null;
    const src = mine ?? sourceOf(q, all);
    if (src === null) { dropped.push(q); continue; }
    said.push({ by: mine !== null ? "owner" : "work", text: src });
  }
  // Lifted: an earlier statement named, and words of the conversation that lift it.
  const lifted: { text: string; by: string }[] = [];
  for (const l of lifting) {
    const [what, why] = l.split(/lifted by\s*:/i);
    const q = what ? quoted(what) : null, w = why ? quoted(why) : null;
    if (q === null || w === null) continue;
    const old = sourceOf(q, prior.map((p) => p.text));
    const target = old === null ? undefined : prior.find((p) => norm(p.text).includes(norm(old)));
    const by = target ? sourceOf(w, target.by === "owner" ? owner : all) : null;
    if (target && by !== null) lifted.push({ text: target.text, by });
  }
  // Done: earlier requests the summary names as finished; they leave, counted.
  const done: string[] = [];
  for (const l of section(text, "Done") ?? []) {
    const q = /^\s*[-*]/.test(l) ? quoted(l) : null;
    const old = q === null ? null : sourceOf(q, prior.map((p) => p.text));
    const target = old === null ? undefined : prior.find((p) => norm(p.text).includes(norm(old)));
    if (target && !lifted.some((x) => x.text === target.text) && !done.includes(target.text)) done.push(target.text);
  }
  const gone = new Set([...lifted.map((l) => l.text), ...done]);
  const out: Statement[] = [];
  const same = (a: string, b: string) => norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  for (const s of [...prior.filter((p) => !gone.has(p.text)), ...said]) {
    const k = out.findIndex((o) => same(o.text, s.text));
    if (k < 0) out.push(s);
    else if (s.text.length > out[k]!.text.length) out[k] = { ...out[k]!, text: s.text };
  }
  if (!out.length && !dropped.length && !lifted.length && !done.length) return { summary: lines ? story : text.trim() };
  const q = (t: string) => `"${t}"`;
  const head = [
    "## Statements",
    "The conversation's own words, carried through every compaction until lifted:",
    ...out.map((s) => `- ${s.by}: ${q(s.text)}`),
    ...(dropped.length ? ["", `(${dropped.length} statement${dropped.length > 1 ? "s" : ""} the summary did not quote word for word ${dropped.length > 1 ? "were" : "was"} left out; the stored history keeps the original words.)`] : []),
    ...(done.length ? ["", `(${done.length} earlier request${done.length > 1 ? "s" : ""} the summary marked done ${done.length > 1 ? "were" : "was"} left out.)`] : []),
    ...(lifted.length ? ["", "## Lifted", ...lifted.map((l) => `- ${q(l.text)} lifted by: ${q(l.by)}`)] : []),
  ];
  return {
    summary: `${head.join("\n")}\n\n## Story\n${story}`,
    statements: out,
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
function entries(lineage: StoredEvent[], who: "owner" | "other"): Entry[] {
  let all: Entry[] = [];
  const at: number[] = []; // the index of each message's event
  lineage.forEach((e, i) => {
    if (e.kind === "compaction") {
      // Messages of the verbatim tail of a summary prepared ahead stay.
      const covered = e.data.covered ? lineage.findIndex((x) => x.id === e.data.covered) : -1;
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
  });
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
export function keptMessages(lineage: StoredEvent[], budget = OWNER_WORDS_BYTES): { owner_messages: string[]; owner_media?: PromptBlock[][]; owner_messages_shortened?: number; other_messages?: string[]; other_messages_shortened?: number } {
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

// What a summary checkpoint stores besides how it was made: the settled
// summary and its statements, and the owner's newest words in what the
// statements leave of the budget.
export function checkpointData(lineage: StoredEvent[], summary: string, budget = OWNER_WORDS_BYTES) {
  const cp = checkpointAt(lineage);
  const prev = cp.at >= 0 && lineage[cp.at]!.data.mode === "summary" ? lineage[cp.at]!.data : undefined;
  const settled = settle(lineage, summary, prev?.statements ?? []);
  const said = (settled.statements ?? []).reduce((n, s) => n + utf8Bytes(s.text), 0);
  return { ...settled, ...keptMessages(lineage, Math.max(0, budget - said)) };
}

// What a compaction at this point summarizes. A turn that has not had a reply
// yet keeps the prompts that opened it out of the summary: they follow it
// verbatim and whole, whoever sent them (a typed prompt, speech, an agent's
// report, a hook's), as Codex records the new input only after a pre-turn
// compaction. Otherwise the whole branch.
export function summarizable(lineage: StoredEvent[]): StoredEvent[] {
  const start = lineage.findLastIndex((e) => e.kind === "turn_start");
  if (start < 0 || lineage.slice(start + 1).some((e) => e.kind === "assistant" || e.kind === "tool_result" || e.kind === "compaction")) return lineage;
  let k = start;
  while (k > 0 && lineage[k - 1]!.kind === "user") k--;
  return k < start ? lineage.slice(0, k) : lineage;
}

// A summary would say something new: since the last one there is a reply, a
// tool result or a prompt that is not the harness's own (a restart's continue,
// a step-budget notice). Notes, turn marks and errors alone are not worth a request.
export function worthSummarizing(upto: StoredEvent[]): boolean {
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

export function summaryMessage(data: { summary: string; owner_messages?: string[]; owner_media?: PromptBlock[][]; other_messages?: string[] }): Message {
  const head = `[harness] This conversation was compacted. Summary of everything before this point:\n\n${data.summary}`;
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
const RATIO_MAX = 5;
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
// estimated whole.
export function contextTokens(lineage: StoredEvent[], model?: string): { used: number; measured: number; estimated: number; last?: Usage } {
  const cp = checkpointAt(lineage);
  const per = bytesPerToken(model);
  let measured = 0;
  let last: Usage | undefined;
  // A reply measured before the checkpoint counted the history it replaced.
  let after = Math.min(cp.keepFrom, cp.at < 0 ? cp.keepFrom : cp.at);
  for (let i = lineage.length - 1; i > cp.at; i--) {
    const e = lineage[i]!;
    if (e.kind === "assistant" && e.data.usage && e.data.stop !== "refusal") {
      last = e.data.usage;
      measured = last!.input + last!.cache_read + last!.cache_write + last!.output;
      after = i + 1;
      break;
    }
  }
  let bytes = 0;
  for (let i = after; i < lineage.length; i++) bytes += tailBytes(lineage[i]!, per);
  const estimated = Math.round(bytes / per);
  return { used: measured + estimated, measured, estimated, last };
}

// The bytes of the context as the next request carries it (the checkpoint's
// summary and everything after it), in the estimate's own measure.
export function contextBytes(lineage: StoredEvent[], model?: string): number {
  const cp = checkpointAt(lineage);
  const per = bytesPerToken(model);
  let bytes = 0;
  for (let i = Math.max(0, Math.min(cp.keepFrom, cp.at < 0 ? cp.keepFrom : cp.at)); i < lineage.length; i++) bytes += tailBytes(lineage[i]!, per);
  return bytes;
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

// UTF-8 bytes of a string (what "bytes" means wherever it is reported).
export const utf8Bytes = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
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
function tailBytes(e: StoredEvent, per = BYTES_PER_TOKEN): number {
  if (e.kind === "assistant") return e.data.stop === "refusal" ? 0 : replyBytes(e.data.blocks ?? []);
  if (e.kind === "tool_result") return jsonBytes(e.data.results ?? [], per);
  if (e.kind === "note") return e.data.model ? utf8Bytes(String(e.data.text ?? "")) : 0;
  if (e.kind === "compaction") return e.data.mode === "summary" ? jsonBytes({ summary: e.data.summary, owner_messages: e.data.owner_messages, owner_media: e.data.owner_media, other_messages: e.data.other_messages }, per) : 0;
  if (e.kind !== "user") return 0;
  let n = utf8Bytes(String(e.data.text ?? ""));
  for (const b of (e.data.images ?? []) as any[]) {
    if (b.type !== "attachment") n += jsonBytes(b, per);
    else n += b.size <= TEXT_INLINE && (TEXT_MEDIA.test(b.media_type) || b.media_type === "application/octet-stream") ? b.size + PATH_NOTE_BYTES : PATH_NOTE_BYTES;
  }
  return n;
}

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

type Piece = { text: string; output?: boolean };

function pieces(m: Message): Piece[] {
  const out: Piece[] = [];
  const who = m.role === "assistant" ? "assistant" : "user";
  for (const b of m.content as any[]) {
    if (b.type === "text") { if (b.text) out.push({ text: `[${who}]\n${b.text}\n` }); }
    else if (b.type === "tool_use") out.push({ text: `[assistant called ${b.name} (${b.id})]\n${JSON.stringify(b.input ?? {})}\n` });
    else if (b.type === "tool_result") {
      const body = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      out.push({ text: `[result of ${b.tool_use_id}${b.is_error ? ", an error" : ""}]\n${body}\n`, output: true });
    } else if (b.type === "image") out.push({ text: `[${who} sent an image]\n` });
    else if (b.type === "attachment") out.push({ text: `[${who} attached the file ${b.name}]\n` });
    // thinking and other provider blocks are not part of the transcript
  }
  return out;
}

// The conversation as transcript parts of at most `budget` UTF-8 bytes each,
// oldest first. `clipped`: tool outputs that were shortened to fit.
export function transcriptParts(messages: Message[], budget: number): { parts: string[]; clipped: number } {
  const all = messages.flatMap(pieces);
  const size = all.map((p) => utf8Bytes(p.text));
  let total = size.reduce((a, b) => a + b, 0);
  let clipped = 0;
  for (let i = 0; i < all.length && total > budget; i++) {
    if (!all[i]!.output || size[i]! <= TRANSCRIPT_CLIP) continue;
    const cut = excerpt(all[i]!.text, TRANSCRIPT_CLIP);
    if (cut === null) continue;
    total -= size[i]!;
    all[i] = { text: cut.endsWith("\n") ? cut : cut + "\n", output: true };
    size[i] = utf8Bytes(all[i]!.text);
    total += size[i]!;
    clipped++;
  }
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  const add = (text: string, n: number) => {
    if (bytes + n > budget && cur) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += text;
    bytes += n;
  };
  for (let i = 0; i < all.length; i++) {
    // One piece larger than a part (a long message) goes on in the next parts.
    if (size[i]! > budget) for (const c of chunks(all[i]!.text, budget)) add(c, utf8Bytes(c));
    else add(all[i]!.text, size[i]!);
  }
  if (cur) parts.push(cur);
  return { parts, clipped };
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

// The request for one part: the summary of the parts before it, the part, and
// what to write. The last part asks for the summary the context continues from.
export function partPrompt(part: string, k: number, n: number, sofar: string, clipped: number, focus?: string): string {
  return [
    `[harness] The context is being compacted, and the conversation is too long to read in one request. It is given as a plain-text transcript${n > 1 ? ` in ${n} parts, oldest first; this is part ${k + 1}` : ""}.${clipped ? " Long tool outputs in it were shortened to their start and end." : ""}`,
    sofar ? `\nYour summary of the parts before this one:\n<summary>\n${sofar}\n</summary>` : "",
    `\n<transcript${n > 1 ? ` part="${k + 1}" of="${n}"` : ""}>\n${part}</transcript>\n`,
    k < n - 1
      ? `Write the summary of the conversation up to the end of this part: ${sofar ? "your summary above brought up to date with this part, keeping everything in it that still matters" : "everything in it that the work still needs"}. The next part follows in the next request, with your summary.`
      : sofar ? "This is the last part. Write the final summary: your summary above brought up to date with this part." : "",
    summaryPrompt(focus).replace("[harness] The context is being compacted. ", ""),
  ].filter(Boolean).join("\n");
}
