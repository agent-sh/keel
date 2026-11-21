// What each session needs from the owner, derived from the stores: the one
// word every shell shows first (needs you, working, failed, done), the line
// of what it is doing now, and its turns over time for the wake chart.
import { useEffect, useMemo } from "react";
import { ownerPrompt } from "../../../src/core/owner.ts";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { agentLive, liveAgentCounts, watchLabel, watchOf as sharedWatch, type Watch } from "../../../src/core/watch.ts";
import { useAuto } from "./automation.ts";
import { useSafety } from "./safety.ts";
import { unsentOf, useShelfVersion, useUnsent } from "./send-drafts.ts";
import { actions, getState, reportError, useStore } from "./store.ts";
import { shortPath, stripAnsi, toolKind, type ToolKind } from "./tools.ts";

export { WATCH_LABEL, WATCH_RANK, watchLabel, type Watch } from "../../../src/core/watch.ts";

// Agents still at work, per parent session (the automation store keeps every live one).
export function useAgentCounts(): Record<string, number> {
  const agents = useAuto((x) => x.agents);
  return useMemo(() => liveAgentCounts(Object.values(agents)), [agents]);
}
export const useAgentCount = (id: string | undefined) =>
  useAuto((x) => { let n = 0; if (id) for (const a of Object.values(x.agents)) if (a.parent_id === id && agentLive(a)) n++; return n; });

// A message this browser keeps because it was not sent, or nobody confirmed
// it, waits for the owner like a question does: the session needs them.
export function useWatch(s: Session | undefined): Watch {
  const events = useStore((x) => (s ? x.events[s.id] : undefined));
  const n = useSafety((x) => (s ? x.approvals[s.id]?.length ?? 0 : 0));
  const asking = useStore((x) => !!s && !!(x.questionCalls[s.id]?.length || x.questionChildren[s.id]?.length));
  const unsent = useUnsent(s?.id);
  const agents = useAgentCount(s?.id);
  return s ? sharedWatch(s, events, { approvals: n, asking: asking || !!unsent, agents }) : "idle";
}

// The word as shown, with the agents that keep it working.
export function useWatchLabel(s: Session | undefined): string {
  const w = useWatch(s);
  return watchLabel(w, useAgentCount(s?.id));
}

// All sessions' watch words in one pass (for boards and lists).
export function useWatches(list: Session[]): Record<string, Watch> {
  const events = useStore((x) => x.events);
  const calls = useStore((x) => x.questionCalls);
  const children = useStore((x) => x.questionChildren);
  const approvals = useSafety((x) => x.approvals);
  const agents = useAgentCounts();
  useShelfVersion();
  const out: Record<string, Watch> = {};
  for (const s of list) out[s.id] = sharedWatch(s, events[s.id], { approvals: approvals[s.id]?.length, asking: !!(calls[s.id]?.length || children[s.id]?.length || unsentOf(s.id)), agents: agents[s.id] });
  return out;
}

// Loads the events of sessions an overview shows, once each.
const asked = new Set<string>();
export function useLoadEvents(ids: string[]) {
  const key = ids.join(",");
  useEffect(() => {
    for (const id of ids) {
      if (asked.has(id) || getState().events[id]) continue;
      asked.add(id);
      // A session deleted meanwhile is simply not shown.
      // A failed load is asked again next time (the marks stand meanwhile).
      actions.loadSession(id).catch((e) => { if ((e as { status?: number }).status !== 404) { asked.delete(id); reportError(e, { at: "overview events" }); } });
    }
  }, [key]);
}

const VERB: Partial<Record<ToolKind, string>> = {
  shell: "Running", stdin: "Typing into", read: "Reading", edit: "Editing", write: "Writing", patch: "Patching",
  search: "Searching", glob: "Finding", list: "Listing", web: "Searching the web for", fetch: "Fetching", plan: "Planning",
  ask: "Asking you", skill: "Using skill", mcp: "Calling",
};

export function toolLine(name: string, input: any, cwd?: string): string {
  const k = toolKind(name);
  const arg =
    k === "shell" ? input.cmd ?? input.command ?? input.description
    : k === "read" || k === "edit" || k === "write" ? shortPath(input.file_path ?? "", cwd)
    : k === "search" || k === "glob" ? input.pattern
    : k === "list" ? shortPath(input.dir_path ?? input.path ?? "", cwd)
    : k === "web" ? input.query
    : k === "fetch" ? input.url
    : k === "ask" ? "" : name;
  return [VERB[k] ?? "Using", arg].filter(Boolean).join(" ");
}

// The newest thing a session did: its last tool call, the reply it is
// writing, or the first line of its last reply.
// Terminal escapes a reply, a command or an error quotes are taken out.
export function lastLine(events: StoredEvent[] | undefined, cwd?: string): string {
  return stripAnsi(newest(events, cwd)).trim();
}

function newest(events: StoredEvent[] | undefined, cwd?: string): string {
  if (!events) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "error") return String(e.data.message ?? "");
    if (e.kind === "assistant") {
      const blocks = e.data.blocks as any[];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.type === "text" && clean(b.text)) return clean(b.text.trim().split("\n")[0]!) || clean(b.text);
        if (b.type === "tool_use") return toolLine(b.name, b.input ?? {}, cwd);
      }
    }
    if (e.kind === "user" && ownWords(e)) return clean(e.data.text);
    // A subagent's first message is the harness's preamble around its task:
    // the line is the parent's words only (they start at task_at).
    if (e.kind === "user" && e.data.kind === "task") return clean(taskWords(e));
  }
  return "";
}

const taskWords = (e: StoredEvent) => {
  const text = String(e.data.text ?? ""), at = e.data.task_at;
  return typeof at === "number" && at >= 0 && at <= text.length ? text.slice(at) : "";
};

// What the owner wrote (typed, steered, queued, spoken or sent from the CLI). Messages
// the harness delivers (a wait firing, a subagent's task or report, a hook) carry a
// kind or an origin of their own (engine.send spreads its meta into the event) and are not their.
const ownWords = (e: StoredEvent) => ownerPrompt(e.data) && !e.data.meta && !/^\s*(<[a-z_]+[\s>]|\[harness\])/i.test(String(e.data.text ?? ""));
// One readable line: no tags, no markdown marks.
const clean = (t: string) => stripAnsi(String(t)).replace(/<\/?[a-z_][^>]*>/gi, " ").replace(/[*`#_]/g, "").replace(/\s+/g, " ").trim();

export type Span = { start: number; end: number | null; reason?: string };
export type Tick = { ts: number; kind: ToolKind; error: boolean };

// Turns as time spans and tool calls as ticks, for the wake chart.
export function timeline(events: StoredEvent[] | undefined, working = false): { spans: Span[]; ticks: Tick[]; errors: number[] } {
  const spans: Span[] = [];
  const ticks: Tick[] = [];
  const errors: number[] = [];
  if (!events) return { spans, ticks, errors };
  const failed = new Set<string>();
  for (const e of events) if (e.kind === "tool_result") for (const r of e.data.results) if (r.is_error) failed.add(r.tool_use_id);
  for (const e of events) {
    if (e.kind === "turn_start") spans.push({ start: e.ts, end: null });
    else if (e.kind === "turn_end" && spans.length) Object.assign(spans[spans.length - 1]!, { end: e.ts, reason: e.data.reason });
    else if (e.kind === "assistant") {
      for (const b of e.data.blocks as any[]) if (b.type === "tool_use") ticks.push({ ts: e.ts, kind: toolKind(b.name), error: failed.has(b.id) });
    } else if (e.kind === "error") errors.push(e.ts);
  }
  // Only a working session has an open turn; one cut off ends at its last event.
  const last = spans[spans.length - 1];
  if (last && last.end === null && !working) Object.assign(last, { end: events[events.length - 1]!.ts, reason: "error" });
  return { spans, ticks, errors };
}
