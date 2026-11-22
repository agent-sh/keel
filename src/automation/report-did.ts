// What an agent did, in one or two short lines that go with its report: the
// steps it took, its tool calls, which tools failed and how many calls were
// refused before they ran, and the files it wrote with its edit tools. An
// agent's own words say what it concluded ("Done"), not what it took to get
// there; a parent that reads "3 of 4 calls failed" knows to look before it
// trusts the conclusion.
//
// Counted as the turn's end counts (src/engine/turn.ts): a call that ran and
// failed is a failed call; one a gate refused (the owner, a rule, the judge,
// plan mode) never ran and is said apart, as "denied"; one that was not run
// for another reason, or that the turn's stop or a restart reached, is
// neither. The engine marks each stored error result with its verdict; an
// error result from before that mark counts as failed.
//
// Counts and names only, never a tool's input or output. The names are other
// parties' words inside a harness line: each is cut to NAME_MAX characters
// with control characters, brackets and quotes taken out, and the whole line
// is held to DID_MAX. Pure.
import type { StoredEvent } from "../core/types.ts";
import { notRun, stopKind } from "../core/stops.ts";

export const DID_MAX = 240;
const NAME_MAX = 40;
// The edit tools of the families, and where each names its file.
const EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "replace", "apply_patch"]);
const PATCHED = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
function filesOf(name: string, input: any): string[] {
  if (!EDITS.has(name)) return [];
  if (name === "apply_patch") return [...String(typeof input === "string" ? input : input?.input ?? input?.patch ?? "").matchAll(PATCHED)].map((m) => m[1]!.trim());
  const p = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof p === "string" && p ? [p] : [];
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A name as it may stand in the line: one line, no bracket or quote that closes a wrapper or opens a tag.
const safe = (s: unknown) => { const t = String(s).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/[<>\[\]"`]/g, "").replace(/\s+/g, " ").trim() || "?"; return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t; };
// A path as short as it can be said: its last two parts.
const short = (p: string) => safe(p.split("/").filter(Boolean).slice(-2).join("/"));

// `evs`: the agent's events since its task. Nothing for an agent that only answered (no call of a tool).
export function didLine(evs: readonly StoredEvent[]): string {
  const calls = new Map<string, { name: string; input: unknown }>();
  let steps = 0;
  const failed: Record<string, number> = {};
  let results = 0, bad = 0, denied = 0;
  // Calls the turn did not run for a reason of its own (cut at the output limit), by the reason.
  const unrun: Record<string, number> = {};
  const files = new Set<string>();
  for (const e of evs) {
    if (e.kind === "assistant") {
      steps++;
      for (const b of e.data.blocks as any[]) if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: b.input });
    } else if (e.kind === "tool_result") {
      // What the engine said of an error result when it stored it: "failed" (it ran), "denied" (a gate), "none" (not run otherwise).
      const verdict = e.data.verdict as string | undefined;
      for (const r of e.data.results as any[]) {
        const c = calls.get(r.tool_use_id);
        // A call the turn's stop or a restart reached did not fail.
        if (stopKind(r.content)) continue;
        results++;
        const why = r.is_error ? notRun(r.content) : undefined;
        if (why) { unrun[why] = (unrun[why] ?? 0) + 1; continue; }
        if (!r.is_error) { if (c) for (const f of filesOf(c.name, c.input)) files.add(f); }
        else if (verdict === "denied") denied++;
        else if (verdict === "failed" || verdict === undefined) { bad++; const n = safe(c?.name ?? "a tool"); failed[n] = (failed[n] ?? 0) + 1; }
      }
    }
  }
  // (Also one that answered a message after its answer: more steps, still nothing but words.)
  if (!results) return "";
  const by = Object.entries(failed).sort((a, b) => b[1] - a[1]);
  const which = by.slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(", ") + (by.length > 3 ? `, ${by.length - 3} more` : "");
  const count = `${plural(steps, "step")}, ${plural(results, "tool call")}`;
  const refused = `${denied ? `, ${denied} denied` : ""}${Object.entries(unrun).map(([why, n]) => `, ${n} not run: ${why}`).join("")}`;
  const list = [...files];
  const edited = list.length ? `; edited ${plural(list.length, "file")}` : "";
  const named = list.length ? `: ${list.slice(0, 3).map(short).join(", ")}${list.length > 3 ? `, ${list.length - 3} more` : ""}` : "";
  // The fullest form that fits: the failed tools and the files named, then without the files' names, then the counts alone.
  for (const text of [
    `(What it did: ${count}${bad ? `, ${bad} failed (${which})` : ""}${refused}${edited}${named}.)`,
    `(What it did: ${count}${bad ? `, ${bad} failed (${which})` : ""}${refused}${edited}.)`,
    `(What it did: ${count}${bad ? `, ${bad} failed` : ""}${refused}${edited}.)`,
  ]) if (text.length <= DID_MAX) return text;
  return "";
}
