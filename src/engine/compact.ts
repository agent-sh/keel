// Compaction: when the context nears the model's window (or the owner asks),
// the model writes a summary of the conversation on the session's own request
// prefix (tools and system unchanged, so that call reads them from cache), and
// a `compaction` event is appended. From there the model sees the summary and
// the owner's recent words verbatim instead of the history; the history stays
// stored, readable and searchable. Nothing earlier is rewritten.
import type { Message, PromptBlock, StoredEvent, Usage } from "../core/types.ts";

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
  // Newest first within the text budget, then oldest first.
  const kept: Entry[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(all[i]!.text);
    if (bytes + b > OWNER_WORDS_BYTES) break;
    bytes += b;
    kept.unshift({ ...all[i]! });
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
  for (let i = after; i < lineage.length; i++) {
    const e = lineage[i]!;
    if (e.kind === "compaction" || e.kind === "user" || e.kind === "tool_result" || e.kind === "assistant") bytes += JSON.stringify(e.data).length;
  }
  const estimated = Math.round(bytes / 4);
  return { used: measured + estimated, measured, estimated, last };
}
