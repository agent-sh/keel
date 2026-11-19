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

// Share of the window at which a summary is prepared in the background, so the
// turn that reaches COMPACT_SHARE swaps it in without waiting for a model call.
export const PREPARE_SHARE = 0.7;

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
function ownerEntries(lineage: StoredEvent[]): Entry[] {
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
    if (bytes + b <= OWNER_WORDS_BYTES) {
      bytes += b;
      kept.unshift({ ...all[i]! });
      continue;
    }
    const part = excerpt(all[i]!.text, OWNER_WORDS_BYTES - bytes);
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

export function ownerWords(lineage: StoredEvent[]): string[] {
  return ownerEntries(lineage).map((e) => e.text);
}

// Aligned with ownerWords; absent when no kept message carried an image or a file.
export function ownerMedia(lineage: StoredEvent[]): PromptBlock[][] | undefined {
  const m = ownerEntries(lineage).map((e) => e.media);
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

// Tokens the next request will carry: what the provider counted on the last
// response of this context, plus the bytes appended since at ~4 bytes a token.
export function contextTokens(lineage: StoredEvent[]): { used: number; measured: number; estimated: number; last?: Usage } {
  const cp = checkpointAt(lineage);
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
  for (let i = after; i < lineage.length; i++) bytes += tailBytes(lineage[i]!);
  const estimated = Math.round(bytes / 4);
  return { used: measured + estimated, measured, estimated, last };
}

// UTF-8 bytes of a value as JSON, with each image counted at its estimated
// token cost (4 bytes a token, as the rest of the estimate) instead of its base64.
function jsonBytes(v: unknown): number {
  let images = 0;
  const text = JSON.stringify(v, (_k, x) => {
    if (x && typeof x === "object" && x.type === "image" && typeof x.data === "string") {
      images += imageTokens(x) * 4;
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
function tailBytes(e: StoredEvent): number {
  if (e.kind === "assistant") return e.data.stop === "refusal" ? 0 : utf8Bytes(JSON.stringify(e.data.blocks ?? []));
  if (e.kind === "tool_result") return jsonBytes(e.data.results ?? []);
  if (e.kind === "note") return e.data.model ? utf8Bytes(String(e.data.text ?? "")) : 0;
  if (e.kind === "compaction") return jsonBytes(e.data);
  if (e.kind !== "user") return 0;
  let n = utf8Bytes(String(e.data.text ?? ""));
  for (const b of (e.data.images ?? []) as any[]) {
    if (b.type !== "attachment") n += jsonBytes(b);
    else n += b.size <= TEXT_INLINE && (TEXT_MEDIA.test(b.media_type) || b.media_type === "application/octet-stream") ? b.size + PATH_NOTE_BYTES : PATH_NOTE_BYTES;
  }
  return n;
}
