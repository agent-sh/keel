// What an agent did, in one or two short lines that go with its report: the
// steps it took, its tool calls and which tools failed, and the files it wrote
// with its edit tools. An agent's own words say what it concluded ("Done"),
// not what it took to get there; a parent that reads "3 of 4 calls failed"
// knows to look before it trusts the conclusion. Counts and names only, never
// a tool's input or output, and within DID_MAX characters. Pure.
import type { StoredEvent } from "../core/types.ts";
import { stopKind } from "../core/stops.ts";

export const DID_MAX = 240;
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
// A path as short as it can be said: its last two parts.
const short = (p: string) => p.split("/").filter(Boolean).slice(-2).join("/");

// `evs`: the agent's events since its task. Nothing for an agent that only answered (one step, no call).
export function didLine(evs: readonly StoredEvent[]): string {
  const calls = new Map<string, { name: string; input: unknown }>();
  let steps = 0;
  const failed: Record<string, number> = {};
  let results = 0, bad = 0;
  const files = new Set<string>();
  for (const e of evs) {
    if (e.kind === "assistant") {
      steps++;
      for (const b of e.data.blocks as any[]) if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: b.input });
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results as any[]) {
        const c = calls.get(r.tool_use_id);
        // A call the turn's stop or a restart reached did not fail.
        if (stopKind(r.content)) continue;
        results++;
        if (r.is_error) { bad++; const n = c?.name ?? "a tool"; failed[n] = (failed[n] ?? 0) + 1; }
        else if (c) for (const f of filesOf(c.name, c.input)) files.add(f);
      }
    }
  }
  if (!results && steps <= 1) return "";
  const by = Object.entries(failed).sort((a, b) => b[1] - a[1]);
  const which = by.slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ${c}` : n)).join(", ") + (by.length > 3 ? `, ${by.length - 3} more` : "");
  const took = `${plural(steps, "step")}, ${plural(results, "tool call")}${bad ? `, ${bad} failed (${which})` : ""}`;
  const list = [...files];
  const edited = list.length ? `; edited ${plural(list.length, "file")}: ${list.slice(0, 3).map(short).join(", ")}${list.length > 3 ? `, ${list.length - 3} more` : ""}` : "";
  const text = `(What it did: ${took}${edited}.)`;
  return text.length <= DID_MAX ? text : `(What it did: ${took}; edited ${plural(list.length, "file")}.)`;
}
