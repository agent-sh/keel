// A block of the system prompt that changed on the owner's side (an
// instruction file was edited, a skill installed, a server's instructions
// changed) reaches a session with a warm cache as a note at the tail of its
// history: the prefix keeps its bytes, so the cache still holds the context,
// and the model reads what changed, as a diff, after everything else. The
// block is folded into the prompt when the cache is cold anyway (a compaction,
// a clear, an expiry, another model: src/engine/build-pin.ts), and from then
// no note is needed. OpenCode and Codex deliver an edited AGENTS.md the same
// way, as a message after the history (OpenCode as a diff, or whole when that
// is shorter), and fold it in at a compaction.
//
// What the model holds as a block's text is the newest note about it since
// the context's checkpoint, else the prompt it was sent. A note is written
// when that differs from the newest render, so an edit made twice, or taken
// back, is told once each time, and a restart that finds the same change
// tells nothing again.
import type { StoredEvent } from "../core/types.ts";
import { diffLines, splitLines } from "../tools/diff.ts";
import { changedBlocks, ownChanges, type PromptBlock } from "./prompt-store.ts";

export const NOTE_KIND = "prompt_update";

export type Rendered = { text: string; blocks: PromptBlock[] };
// What a note said a block is from then on: its fingerprints and its text.
export type Told = { hash: string; data?: string; text: string };

// Each block's text, cut from the prompt by the blocks' byte lengths (two
// blocks of one name are one text); undefined when they do not add up to the
// prompt (one kept from before its blocks were measured).
export function blockTexts(p: Rendered): Map<string, string> | undefined {
  const buf = Buffer.from(p.text);
  if (p.blocks.reduce((n, b) => n + b.bytes, 0) !== buf.length) return undefined;
  const out = new Map<string, string>();
  let at = 0;
  for (const b of p.blocks) {
    out.set(b.name, (out.get(b.name) ?? "") + buf.subarray(at, at + b.bytes).toString());
    at += b.bytes;
  }
  return out;
}

// The newest note about each block since `from` (where the context the model
// reads begins: checkpointAt(...).keepFrom).
export function toldOf(events: readonly StoredEvent[], from = 0): Map<string, Told> {
  const out = new Map<string, Told>();
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i]!;
    if (e.kind !== "note" || e.data.kind !== NOTE_KIND) continue;
    for (const [name, t] of Object.entries((e.data.blocks ?? {}) as Record<string, Told>)) if (!out.has(name)) out.set(name, t);
  }
  return out;
}

const fingerprint = (blocks: PromptBlock[], name: string) => {
  const of = blocks.filter((b) => b.name === name);
  return of.length ? { hash: of.map((b) => b.hash).join(","), data: of.some((b) => b.data !== undefined) ? of.map((b) => b.data ?? "").join(",") : undefined } : undefined;
};

// A block's change as the model reads it: the lines around each change, or
// the whole new text when that is shorter than the diff. A run of lines left
// out is "@@", followed by the nearest file heading above it (the instruction
// files name each file on a line "# /path"), so a rule is read with its file.
const CONTEXT = 3;
const HEADING = /^# \//;
export function blockDiff(before: string, after: string): string {
  if (!after.trim()) return "It is empty now: what the system prompt says under it no longer applies.";
  if (!before.trim()) return `It reads:\n${after.trimEnd()}`;
  const ops = diffLines(splitLines(before), splitLines(after));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== " ") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true; });
  const lines: string[] = [];
  let heading: string | undefined;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      if (o.t !== "+" && HEADING.test(o.line)) heading = o.line;
      return;
    }
    if (i > 0 && !keep[i - 1]) lines.push(heading ? `@@ ${heading}` : "@@");
    if (o.t !== "+" && HEADING.test(o.line)) heading = o.line;
    lines.push(`${o.t}${o.line}`);
  });
  if (!lines.length) return `It reads:\n${after.trimEnd()}`;
  const diff = lines.join("\n");
  return diff.length < after.length ? `Changed lines (- before, + now, the rest as it was):\n${diff}` : `It reads in full:\n${after.trimEnd()}`;
}

// The note a session's next request carries, when the model holds an older
// text of a block of the owner's side than `latest`, the newest render.
// `sent`: the prompt its requests carry. Undefined when nothing is to be told.
export function promptNote(sent: Rendered, latest: Rendered, told: Map<string, Told>): { text: string; short: string; blocks: Record<string, Told>; names: string[] } | undefined {
  const names = new Set([...ownChanges(sent.blocks, latest.blocks, changedBlocks(sent.blocks, latest.blocks)), ...told.keys()]);
  if (!names.size) return undefined;
  const was = blockTexts(sent), now = blockTexts(latest);
  if (!now) return undefined;
  const out: Record<string, Told> = {};
  const parts: string[] = [];
  for (const name of names) {
    const after = fingerprint(latest.blocks, name);
    // A block the newest render no longer has is the build's change: it waits for the fold.
    if (!after) continue;
    const t = told.get(name);
    const before = t ?? { ...fingerprint(sent.blocks, name), text: was?.get(name) ?? "" };
    if (before.hash === after.hash || (before.data !== undefined && before.data === after.data && t)) continue;
    const text = now.get(name) ?? "";
    out[name] = { hash: after.hash, ...(after.data !== undefined && { data: after.data }), text };
    parts.push(`<changed block="${name}">\n${blockDiff(before.text, text)}\n</changed>`);
  }
  const list = Object.keys(out);
  if (!list.length) return undefined;
  const short = list.map((n) => (n.length > 32 ? `${n.slice(0, 30).trimEnd()}...` : n)).join(", ");
  return {
    names: list, blocks: out, short: `Told the model what changed in its prompt (${short})`,
    text: `[harness] Part of your system prompt changed during this session: ${list.join(", ")}. The system prompt above still shows the earlier text (so the cached context is kept); what follows is in force from here and replaces it.\n\n${parts.join("\n\n")}`,
  };
}
