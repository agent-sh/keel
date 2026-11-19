// What each session needs from the owner, derived from the stores: the one
// word every shell shows first (needs you, working, failed, done), the line
// of what it is doing now, and its turns over time for the wake chart.
import { useEffect } from "react";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { useSafety } from "./safety.ts";
import { actions, getState, reportError, useStore } from "./store.ts";
import { shortPath, toolKind, type ToolKind } from "./tools.ts";

// `stop`: the owner (or a parent) stopped the last turn; `resume`: a daemon
// restart cut it and it waits to go on. Neither is done.
export type Watch = "need" | "work" | "fail" | "resume" | "stop" | "done" | "idle";

export const WATCH_LABEL: Record<Watch, string> = {
  need: "Needs you", work: "Working", fail: "Failed", resume: "Waiting to resume", stop: "Stopped", done: "Done", idle: "Not started",
};
// Order of attention: what needs the owner first, quiet work last.
export const WATCH_RANK: Record<Watch, number> = { need: 0, work: 1, fail: 2, resume: 3, stop: 4, done: 5, idle: 6 };
const ENDED: Record<string, Watch> = { error: "fail", interrupted: "stop", restart: "resume" };

const openQuestion = (events: StoredEvent[] | undefined) => {
  if (!events) return false;
  const answered = new Set<string>();
  for (const e of events) if (e.kind === "tool_result") for (const r of e.data.results) answered.add(r.tool_use_id);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "turn_end") return false;
    if (e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "tool_use" && toolKind(b.name) === "ask" && !answered.has(b.id))) return true;
  }
  return false;
};

export function watchOf(s: Session, events: StoredEvent[] | undefined, approvals: number): Watch {
  if (approvals > 0) return "need";
  if (s.phase === "working") return openQuestion(events) ? "need" : "work";
  if (s.phase === "error") return "fail";
  if (events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "error") return "fail";
      if (e.kind === "turn_end") return ENDED[e.data.reason] ?? "done";
      if (e.kind === "user") break;
    }
    // A turn that started and never ended (the daemon stopped under it) failed.
    if (events.some((e) => e.kind === "turn_start")) return "fail";
    return "idle";
  }
  // Events not loaded (the rail lists every session): the daemon's marks say it.
  if (s.settings.failed_ms) return "fail";
  if (s.settings.last_end) return ENDED[s.settings.last_end] ?? "done";
  return s.usage.output > 0 ? "done" : "idle";
}

export function useWatch(s: Session | undefined): Watch {
  const events = useStore((x) => (s ? x.events[s.id] : undefined));
  const n = useSafety((x) => (s ? x.approvals[s.id]?.length ?? 0 : 0));
  return s ? watchOf(s, events, n) : "idle";
}

// All sessions' watch words in one pass (for boards and lists).
export function useWatches(list: Session[]): Record<string, Watch> {
  const events = useStore((x) => x.events);
  const approvals = useSafety((x) => x.approvals);
  const out: Record<string, Watch> = {};
  for (const s of list) out[s.id] = watchOf(s, events[s.id], approvals[s.id]?.length ?? 0);
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
export function lastLine(events: StoredEvent[] | undefined, cwd?: string): string {
  if (!events) return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "error") return e.data.message;
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
// kind or an origin of their own (engine.send spreads its meta into the event) and are not his.
const OWNER = new Set([undefined, "steer", "queued", "voice", "cli"]);
const ownWords = (e: StoredEvent) => !e.data.kind && !e.data.meta && OWNER.has(e.data.origin) && !/^\s*(<[a-z_]+[\s>]|\[harness\])/i.test(String(e.data.text ?? ""));
// One readable line: no tags, no markdown marks.
const clean = (t: string) => String(t).replace(/<\/?[a-z_][^>]*>/gi, " ").replace(/[*`#_]/g, "").replace(/\s+/g, " ").trim();

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
