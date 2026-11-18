// Compaction: when the context nears the model's window (or the owner asks),
// the model writes a summary of the conversation on the session's own request
// prefix (tools and system unchanged, so that call reads them from cache), and
// a `compaction` event is appended. From there the model sees the summary and
// the owner's recent words verbatim instead of the history; the history stays
// stored, readable and searchable. Nothing earlier is rewritten.
import type { Message, StoredEvent, Usage } from "../core/types.ts";

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

// The owner's own messages since the last checkpoint (and those the last
// summary kept), newest kept first within the byte budget, oldest first.
export function ownerWords(lineage: StoredEvent[]): string[] {
  let all: string[] = [];
  const at: number[] = []; // the index of each word's event
  lineage.forEach((e, i) => {
    if (e.kind === "compaction") {
      // Words of the verbatim tail of a summary prepared ahead stay.
      const covered = e.data.covered ? lineage.findIndex((x) => x.id === e.data.covered) : -1;
      const tail = covered >= 0 ? all.filter((_, k) => at[k]! > covered) : [];
      all = [...(e.data.mode === "summary" ? e.data.owner_messages ?? [] : []), ...tail];
      at.length = 0;
      at.push(...all.map(() => i));
    } else if (e.kind === "user" && (!e.data.origin || e.data.origin === "steer" || e.data.origin === "queued")) {
      all.push(e.data.text);
      at.push(i);
    }
  });
  const kept: string[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(all[i]!);
    if (bytes + b > OWNER_WORDS_BYTES) break;
    bytes += b;
    kept.unshift(all[i]!);
  }
  return kept;
}

export function summaryMessage(data: { summary: string; owner_messages?: string[] }): Message {
  const owner = data.owner_messages?.length
    ? `\n\n[The owner's messages before the compaction, oldest first:]\n${data.owner_messages.map((t) => `<message>\n${t}\n</message>`).join("\n")}`
    : "";
  return {
    role: "user",
    content: [{ type: "text", text: `[harness] This conversation was compacted. Summary of everything before this point:\n\n${data.summary}${owner}` }],
  };
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
