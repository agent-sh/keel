// Compaction: when the context nears the model's window (or the owner asks),
// the model writes a summary of the conversation on the session's own request
// prefix (tools and system unchanged, so that call reads them from cache), and
// a `compaction` event is appended. From there the model sees the summary and
// the owner's recent words verbatim instead of the history; the history stays
// stored, readable and searchable. Nothing earlier is rewritten.
import type { Message, PromptBlock, StoredEvent, Usage } from "../core/types.ts";
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

export function summaryPrompt(focus?: string): string {
  return [
    "[harness] The context is being compacted. Write a summary of the conversation so far that lets you continue the work without it: everything before this point will be replaced by your summary.",
    "Use these sections:",
    "1. Goal: what the owner asked for, every request, the current one last.",
    "2. Decisions and constraints the owner set or the work settled.",
    "3. Files and code: paths read or changed, what changed and why.",
    "4. Commands and results that still matter (builds, tests, errors and their fixes).",
    "5. State: where the work stands and the exact next step.",
    "Be specific: names, paths, numbers, error text. Do not call tools; reply with the summary only.",
    focus ? `\nKeep above all: ${focus}` : "",
  ].join("\n");
}

// Images and files of the owner's kept messages travel through a compaction
// with their message, newest first within this many bytes (base64 images,
// attached files by size): under Anthropic's 32 MB and OpenAI's 50 MB request
// caps with room for the rest. Older ones leave a note in their place.
export const OWNER_MEDIA_BYTES = 20 * 1024 * 1024;

type Entry = { text: string; media: PromptBlock[] };

// The owner's own messages since the last checkpoint (and those the last
// summary kept), with their images and files.
function ownerEntries(lineage: StoredEvent[], budget = OWNER_WORDS_BYTES): Entry[] {
  let all: Entry[] = [];
  const at: number[] = []; // the index of each message's event
  lineage.forEach((e, i) => {
    if (e.kind === "compaction") {
      // Messages of the verbatim tail of a summary prepared ahead stay.
      const covered = e.data.covered ? lineage.findIndex((x) => x.id === e.data.covered) : -1;
      const tail = covered >= 0 ? all.filter((_, k) => at[k]! > covered) : [];
      const kept: Entry[] = e.data.mode === "summary" ? (e.data.owner_messages ?? []).map((t: string, k: number) => ({ text: t, media: e.data.owner_media?.[k] ?? [] })) : [];
      all = [...kept, ...tail];
      at.length = 0;
      at.push(...all.map(() => i));
    } else if (e.kind === "user" && (!e.data.origin || e.data.origin === "steer" || e.data.origin === "queued")) {
      all.push({ text: e.data.text, media: (e.data.images ?? []).filter((b: any) => b.type === "image" || b.type === "attachment") });
      at.push(i);
    }
  });
  // Newest first within the text budget, then oldest first. The message that
  // crosses the budget keeps a marked excerpt (its start and end) with its
  // images and files, as Codex cuts the message at its remaining allowance.
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
    if (part !== null) kept.unshift({ ...all[i]!, text: part });
    break;
  }
  let media = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    kept[i]!.media = kept[i]!.media.map((m: any) => {
      const n = m.type === "image" ? m.data.length : m.type === "attachment" ? m.size : 0;
      if (m.type === "text" || media + n <= OWNER_MEDIA_BYTES) { media += n; return m; }
      return { type: "text", text: `[An ${m.type === "image" ? "image" : `attached file (${m.name})`} the owner sent with this message is no longer in the context.]` };
    });
  }
  return kept;
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

// `budget`: the bytes of owner words to keep, when the model's window is too
// small for OWNER_WORDS_BYTES (they must fit it beside the summary).
export function ownerWords(lineage: StoredEvent[], budget?: number): string[] {
  return ownerEntries(lineage, budget).map((e) => e.text);
}

// Aligned with ownerWords; absent when no kept message carried an image or a file.
export function ownerMedia(lineage: StoredEvent[], budget?: number): PromptBlock[][] | undefined {
  const m = ownerEntries(lineage, budget).map((e) => e.media);
  return m.some((x) => x.length) ? m : undefined;
}

export function summaryMessage(data: { summary: string; owner_messages?: string[]; owner_media?: PromptBlock[][] }): Message {
  const head = `[harness] This conversation was compacted. Summary of everything before this point:\n\n${data.summary}`;
  const msgs = data.owner_messages ?? [];
  if (!data.owner_media) {
    const owner = msgs.length ? `\n\n[The owner's messages before the compaction, oldest first:]\n${msgs.map((t) => `<message>\n${t}\n</message>`).join("\n")}` : "";
    return { role: "user", content: [{ type: "text", text: head + owner }] };
  }
  // Each message with the images and files it was sent with, in place.
  const content: any[] = [{ type: "text", text: `${head}\n\n[The owner's messages before the compaction, oldest first, with what they attached:]` }];
  msgs.forEach((t, k) => content.push(...(data.owner_media![k] ?? []), { type: "text", text: `<message>\n${t}\n</message>` }));
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
  const have = ratios.get(model);
  const next = have ? have + (sample - have) * RATIO_RATE : sample;
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
  if (e.kind === "assistant") return e.data.stop === "refusal" ? 0 : utf8Bytes(JSON.stringify(e.data.blocks ?? []));
  if (e.kind === "tool_result") return jsonBytes(e.data.results ?? [], per);
  if (e.kind === "note") return e.data.model ? utf8Bytes(String(e.data.text ?? "")) : 0;
  if (e.kind === "compaction") return e.data.mode === "summary" ? jsonBytes({ summary: e.data.summary, owner_messages: e.data.owner_messages, owner_media: e.data.owner_media }, per) : 0;
  if (e.kind !== "user") return 0;
  let n = utf8Bytes(String(e.data.text ?? ""));
  for (const b of (e.data.images ?? []) as any[]) {
    if (b.type !== "attachment") n += jsonBytes(b, per);
    else n += b.size <= TEXT_INLINE && (TEXT_MEDIA.test(b.media_type) || b.media_type === "application/octet-stream") ? b.size + PATH_NOTE_BYTES : PATH_NOTE_BYTES;
  }
  return n;
}

// --- A history too long for one summary request ---
// The summary is normally written on the session's own request (its cached
// prefix). When that request would not fit the model's window, the history
// goes as a plain-text transcript instead (no media, no reasoning, as OpenCode
// and pi serialize it): tool outputs are shortened oldest first until it fits
// one request; when it still does not, it is cut into parts read oldest
// first, each with the summary of the parts before it, so nothing is left out.

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
  for (let i = 0; i < all.length; i++) {
    let text = all[i]!.text;
    let n = size[i]!;
    // One piece larger than a part keeps its start and end.
    if (n > budget) {
      text = (excerpt(text, budget) ?? "") + "\n";
      n = utf8Bytes(text);
    }
    if (bytes + n > budget && cur) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += text;
    bytes += n;
  }
  if (cur) parts.push(cur);
  return { parts, clipped };
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
