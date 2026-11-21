// The rows of a session's timeline: what happened, one plain sentence each.
// A row is built from records (ids, kinds, counts, classes, durations) and the
// titles the session list already shows. It never carries a prompt, a tool's
// input or output, a wait's note or an error's message: those stay behind the
// ids a row names (the turn's receipt, its trace, the agent's session, the error).
import type { ErrorRecord, TurnStatus } from "../core/types.ts";
import { errorClass } from "./classes.ts";

export type TimelineKind =
  | "turn" | "agent" | "wait" | "loop" | "approval" | "question" | "compaction" | "model" | "restart" | "error" | "goal" | "limit"
  // Only in "now": what is queued, and a session with nothing going on.
  | "queue" | "idle";
// Color is state: `failed` went wrong, `owner` waits on the owner, `live` runs now.
export type Tone = "plain" | "failed" | "owner" | "live";
export type Refs = {
  trace_id?: string; span_id?: string; error_id?: string; agent_id?: string; child_session?: string; child_turn?: string;
  wait_id?: string; loop_id?: string; run_id?: string; approval_id?: string; call_id?: string; queue_id?: string; from_session?: string;
};
export type TurnFacts = {
  origin: string; queued?: true; outcome: string; reason?: string; model?: string;
  steps: number; tools: number; failed_tools: number; compactions?: number;
  input?: number; output?: number; cache_read?: number; cost?: number;
};
export type TimelineRow = {
  id: string;
  ts: number;
  kind: TimelineKind;
  sub: string;
  tone: Tone;
  text: string;
  bad?: string;        // the part of `text` that went wrong inside a row that is otherwise fine ("2 failed tools")
  ms?: number;         // how long it took
  open?: true;         // not over yet: a running turn, a card not answered
  until?: number;      // when what it waits on is due
  turn_event?: string; // the turn it happened in (a turn's own row: itself): opens the receipt
  refs?: Refs;
  turn?: TurnFacts;
};
export type TimelineNow = { state: "working" | "owner" | "waiting" | "idle"; lines: TimelineRow[] };
export type TimelinePage = { session_id: string; now?: TimelineNow; rows: TimelineRow[]; next: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n === 0 ? "no" : n} ${n === 1 ? one : many}`;
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
const refs = (r: Refs): { refs?: Refs } => { const c = clean(r); return Object.keys(c).length ? { refs: c } : {}; };
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
// A title is shown as the session list shows it, short.
const title = (t: unknown, fallback: string) => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s ? `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"` : fallback; };

// "850 ms", "4 s", "3 min", "1 h 12 min", "2 d 3 h".
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

// Who started a turn, from the prompt before it: what it says it is (`kind`:
// a wake, a report, a loop run, a message from another session), else how it
// arrived (`origin`), else the owner typing.
const WHO: Record<string, string> = {
  owner: "the owner", queued: "a queued prompt", steer: "a steer", harness: "the harness", restart: "a daemon restart",
  voice: "the owner by voice", hook: "a stop hook", momentum: "a momentum message", wait: "a wait wake", wake: "several wakes",
  subagent: "an agent report", loop: "a loop run", goal: "a goal check", task: "its parent's task", parent: "its parent",
  peer: "another session", task_start: "a task from another session", verify_goal: "a goal verification", review: "a review request",
  review_fix: "review findings", diagnostic: "a diagnostic", helper_digest: "the helper's digest",
};
export type Opener = { origin?: unknown; kind?: unknown; queue_id?: unknown; wait_id?: unknown; agent_id?: unknown; loop_id?: unknown; run_id?: unknown; from?: unknown } | null | undefined;
export const whoWords = (key: string) => WHO[key] ?? "something else";
export function originOf(o: Opener): { key: string; words: string; queued: boolean } {
  const origin = str(o?.origin), kind = str(o?.kind);
  const key = origin === "restart" ? "restart" : kind && WHO[kind] ? kind : origin && WHO[origin] ? origin : kind || origin ? "other" : "owner";
  return { key, words: WHO[key] ?? "something else", queued: origin === "queued" && key !== "queued" };
}

// A turn's end reason as an outcome class: the classes of src/admin/outcomes.ts
// (a test holds the two together). Kept here so the page can load this file.
const NORMAL = new Set(["end_turn", "stop_sequence", "stop"]);
export function outcomeOf(reason: string, stoppedBy?: string | null): string {
  if (NORMAL.has(reason)) return "ok";
  if (reason === "interrupted") return stoppedBy && stoppedBy !== "owner" ? "stopped_by_parent" : "stopped_by_owner";
  if (reason === "restart") return "cut";
  if (reason === "max_steps" || reason === "max_tokens") return "budget";
  if (reason === "refusal") return "refusal";
  return "error";
}

export type TurnInput = {
  start: { id: string; ts: number; model?: string };
  opener?: Opener;
  end?: { reason: string; ms?: number; ts?: number; stopped_by?: string | null; usage?: { input?: number; output?: number; cache_read?: number; cost?: number } } | null;
  running?: boolean;
  steps: number;
  tools: number;
  failed_tools: number;
  compactions?: number;
  error_id?: string;
  now?: number;
};

export function turnRow(t: TurnInput): TimelineRow {
  const who = originOf(t.opener);
  const outcome = t.end ? outcomeOf(t.end.reason, t.end.stopped_by) : t.running ? "running" : "open";
  const head = who.key === "restart" ? "Turn continued after a daemon restart" : `Turn started by ${who.words}${who.queued ? " (queued)" : ""}`;
  const n = plural(t.steps, "step");
  const after = t.steps ? ` after ${n}` : " before its first step";
  const bad = t.failed_tools ? plural(t.failed_tools, "failed tool") : undefined;
  let text: string;
  let tone: Tone = "plain";
  switch (outcome) {
    case "running": text = `${head}: running, ${t.steps ? `${n} so far` : "on its first step"}`; tone = "live"; break;
    case "ok": text = `${head}, ${n}`; break;
    case "error": text = `${head} failed${after}`; tone = "failed"; break;
    case "refusal": text = `${head}: the model declined${after}`; tone = "failed"; break;
    case "stopped_by_owner": text = `${head}, stopped by the owner${after}`; break;
    case "stopped_by_parent": text = `${head}, stopped by its parent${after}`; break;
    case "cut": text = `${head}, cut by a daemon restart${after}`; break;
    case "budget": text = `${head}, ended at ${t.end!.reason === "max_tokens" ? "the output limit" : "its step budget"}${after}`; break;
    default: text = `${head}: no end was recorded, ${n}`;
  }
  if (bad) text += `, ${bad}`;
  const u = t.end?.usage;
  const ms = t.end ? t.end.ms ?? (t.end.ts !== undefined ? t.end.ts - t.start.ts : undefined) : undefined;
  return clean({
    id: t.start.id, ts: t.start.ts, kind: "turn" as const, sub: outcome, tone, text, bad, ms,
    open: outcome === "running" ? (true as const) : undefined,
    turn_event: t.start.id,
    ...refs({ error_id: t.error_id, queue_id: str(t.opener?.queue_id), wait_id: str(t.opener?.wait_id), agent_id: str(t.opener?.agent_id), loop_id: str(t.opener?.loop_id), run_id: str(t.opener?.run_id), from_session: str(t.opener?.from) }),
    turn: clean({
      origin: who.key, queued: who.queued || who.key === "queued" ? (true as const) : undefined, outcome, reason: t.end?.reason, model: t.start.model,
      steps: t.steps, tools: t.tools, failed_tools: t.failed_tools, compactions: t.compactions || undefined,
      input: u?.input, output: u?.output, cache_read: u?.cache_read, cost: u?.cost,
    }),
  });
}

// The marks a session's events leave besides its turns.
export type Mark = { id: string; ts: number; kind: string; data: Record<string, any> | null };
const short = (model: unknown) => String(model ?? "").split(":").pop() || "another model";
const tokens = (n: unknown) => (typeof n === "number" && n > 0 ? `, from ${n < 1000 ? n : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`} tokens` : "");
export function markRow(e: Mark, turn?: string): TimelineRow | null {
  const d = e.data ?? {};
  const row = (kind: TimelineKind, sub: string, text: string, tone: Tone = "plain"): TimelineRow => clean({ id: e.id, ts: e.ts, kind, sub, tone, text, turn_event: turn });
  if (e.kind === "compaction") {
    const text = d.mode === "clear" ? "Context cleared" : d.trigger === "model" ? "The model started a fresh context" : d.auto ? "Context compacted by itself" : "Context compacted by the owner";
    return row("compaction", String(d.mode ?? "summary"), `${text}${tokens(d.tokens_before)}`);
  }
  if (e.kind === "turn_end") {
    if (d.reason !== "restart") return null;
    return row("restart", d.crashed ? "crash" : "stop", d.crashed ? "The daemon went down without warning: the turn was cut" : "The daemon stopped for a restart: the turn was parked");
  }
  if (e.kind !== "note") return null;
  switch (d.kind) {
    case "model_told": return row("model", "switch", `Model changed from ${short(d.from)} to ${short(d.to)}`);
    case "fallback": return row("model", "fallback", "The model declined: the turn went on with the fallback model");
    case "restart": return row("restart", "held", "Not continued after the daemon restart: it waits for the owner", "owner");
    case "compaction_failed": return row("compaction", "failed", "The context could not be compacted", "failed");
    case "rewind": return row("compaction", "rewind", "The conversation was rewound");
    case "fork": return row("model", "fork", "Forked from another session");
    default: return null;
  }
}

// What the activity list recorded, with the records its ids name.
export type ActivityIn = { id: string; ts: number; kind: string; sub: string; text: string; data?: Record<string, any> | null; turn_event?: string | null };
export type Lookups = {
  agent?(id: string): { session_id?: string; title?: string; type?: string; status?: string; created?: number; ended?: number | null; stopped_by?: string | null; end_reason?: string | null } | undefined;
  wait?(id: string): { kind?: string; status?: string; created?: number; deadline?: number; ended?: number | null } | undefined;
  loop?(id: string): { name?: string } | undefined;
  approval?(id: string): { tool?: string; risk?: string; state?: string; choice?: string; created?: number; resolved?: number } | undefined;
};
const WAIT_ON: Record<string, string> = {
  timer: "a timer", file: "a file", log: "a log line", http: "an HTTP check", process: "a process", monitor: "a monitor",
  websocket: "a WebSocket", pr_checks: "a pull request's checks", session: "another session",
};
export const waitWords = (kind: unknown) => WAIT_ON[String(kind)] ?? "a condition";
const STOPPED: Record<string, string> = {
  owner: "the owner stopped it", parent: "its parent stopped it", parent_turn: "it stopped with its parent's turn",
  time_limit: "its time limit passed", parent_archived: "its parent session was archived",
};
const AGENT_END: Record<string, string> = { refusal: "the model declined", max_tokens: "it hit the output limit", max_steps: "it ran out of its step budget" };
const CHOICE: Record<string, string> = { once: " once", session: " for the session", always: " from now on" };
const toolOf = (text: string) => { const t = text.split(":")[0] ?? ""; return /^[\w.-]{1,80}$/.test(t) ? t : "a tool"; };

export function activityRow(a: ActivityIn, look: Lookups = {}): TimelineRow | null {
  const d = a.data ?? {};
  // A subagent's happening is listed under its parent: the row says whose it is.
  const inChild = d.child_session && a.kind !== "agent" ? `, in agent ${title(d.child_title, "of this session")}` : "";
  const row = (kind: TimelineKind, text: string, o: Partial<TimelineRow> = {}, r: Refs = {}): TimelineRow => clean({
    id: a.id, ts: a.ts, kind, sub: a.sub, tone: "plain" as Tone, text: `${text}${inChild}`, turn_event: a.turn_event ?? undefined, ...o,
    ...refs({ child_session: str(d.child_session), child_turn: str(d.child_turn), ...r }),
  });
  if (a.kind === "agent") {
    if (a.sub === "staggered") return null;
    if (a.sub === "consult") return row("agent", "Consulted the advisor");
    const g = d.agent_id ? look.agent?.(d.agent_id) : undefined;
    const name = `Agent ${title(g?.title, "(no longer kept)")}`;
    const r = { agent_id: str(d.agent_id), child_session: str(d.child_session) ?? g?.session_id };
    if (a.sub === "started") return row("agent", `${name} started${g?.type ? ` (${g.type})` : ""}`, { open: g && (g.status === "running" || g.status === "waiting") ? true : undefined }, r);
    const ms = g?.created !== undefined ? a.ts - g.created : undefined;
    const took = ms !== undefined && ms >= 0 ? ` after ${dur(ms)}` : "";
    const by = str(d.stopped_by) ?? g?.stopped_by ?? undefined;
    switch (a.sub) {
      case "completed": return row("agent", `${name} reported${took}`, { ms }, r);
      case "failed": return row("agent", `${name} failed${took}`, { ms, tone: "failed" }, r);
      case "incomplete": return row("agent", `${name} did not finish${g?.end_reason ? `: ${AGENT_END[g.end_reason] ?? g.end_reason}` : ""}`, { ms, tone: "failed" }, r);
      case "stopped": return row("agent", `${name} stopped${by ? `: ${STOPPED[by] ?? by}` : ""}`, { ms }, r);
      default: return row("agent", `${name}: ${a.sub}`, {}, r);
    }
  }
  if (a.kind === "wait") {
    const w = d.wait_id ? look.wait?.(d.wait_id) : undefined;
    const on = waitWords(w?.kind);
    const r = { wait_id: str(d.wait_id) };
    if (a.sub === "set") return row("wait", `Wait set on ${on}`, w?.status === "active" ? { open: true, until: w.deadline } : {}, r);
    const ms = w?.created !== undefined ? a.ts - w.created : undefined;
    const took = ms !== undefined && ms >= 0 ? ` after ${dur(ms)}` : "";
    switch (a.sub) {
      case "fired": return row("wait", `Wait on ${on} fired${took}`, { ms }, r);
      case "timeout": return row("wait", `Wait on ${on} timed out${took}`, { ms, tone: "failed" }, r);
      case "cancelled": return row("wait", `Wait on ${on} was cancelled${took}`, { ms }, r);
      default: return row("wait", `Wait on ${on} ended${took}`, { ms }, r);
    }
  }
  if (a.kind === "loop") {
    const name = `Loop ${title(d.loop_id ? look.loop?.(d.loop_id)?.name : undefined, "(removed)")}`;
    const r = { loop_id: str(d.loop_id), run_id: str(d.run_id) };
    switch (a.sub) {
      case "run": return row("loop", `${name} started a run`, {}, r);
      // The reason is the harness's own sentence, never the loop's prompt.
      case "skip": { const why = a.text.split(" did not run: ")[1]; return row("loop", `${name} did not run${why ? `: ${why.slice(0, 100)}` : ""}`, {}, r); }
      case "ok": return row("loop", `${name} finished a run`, {}, r);
      case "stopped": return row("loop", `${name}: its run was stopped`, {}, r);
      case "incomplete": return row("loop", `${name}: its run did not finish`, { tone: "failed" }, r);
      default: return row("loop", `${name}: its run failed`, { tone: "failed" }, r);
    }
  }
  if (a.kind === "approval") {
    // Full auto settled a high-risk call itself: a rule, the judge or a retry.
    if (!d.approval_id) {
      const refused = a.sub.startsWith("refused");
      return row("approval", `${toolOf(a.text)} call ${refused ? "refused by the judge" : a.sub}${a.sub === "refused again" ? " again" : ""}`, refused ? { tone: "failed" } : {}, { call_id: str(d.call_id) });
    }
    const p = look.approval?.(d.approval_id);
    const ms = p?.created !== undefined ? a.ts - p.created : undefined;
    const tool = p?.tool ?? toolOf(a.text);
    const said = a.sub === "allowed" ? `allowed${CHOICE[p?.choice ?? ""] ?? ""}` : a.sub === "denied" ? "denied" : "cancelled";
    return row("approval", `Approval for ${tool} ${said}${ms !== undefined && ms >= 0 ? ` after ${dur(ms)}` : ""}`, { ms }, { approval_id: d.approval_id });
  }
  if (a.kind === "alert") {
    if (a.sub === "approval") {
      const p = d.approval_id ? look.approval?.(d.approval_id) : undefined;
      const pending = p?.state === "pending";
      return row("approval", `Approval asked${p?.tool ? ` for ${p.tool}` : ""}${p?.risk === "high" ? " (high risk)" : ""}`, pending ? { tone: "owner", open: true, sub: "asked" } : { sub: "asked" }, { approval_id: str(d.approval_id) });
    }
    if (a.sub === "question") return row("question", "Asked the owner a question", { sub: "asked" }, { call_id: str(d.call_id) });
    if (a.sub === "limit") return row("limit", "A usage limit is close", { sub: "close" });
    return null;
  }
  if (a.kind === "turn" && a.sub === "goal") {
    const m = /^Goal (set|cleared)|^Goal (check|verification): ([a-z ]+)\./.exec(a.text);
    if (!m) return null;
    return row("goal", m[1] ? `Goal ${m[1]}` : `Goal ${m[2]}: ${m[3]}`, { sub: m[1] ?? m[2]! });
  }
  return null;
}

const SOURCE: Record<string, string> = { provider: "Model request", tool: "Tool", server: "Daemon", client: "Page" };
const CLASS: Record<string, string> = {
  rate_limit: "rate limit", overloaded: "overloaded", server: "server error", stream_drop: "dropped stream", context_overflow: "context too long",
  auth: "sign-in", quota: "quota or billing", refusal: "declined", invalid_request: "refused request",
};
// One row per kind of failure (the errors table folds repeats): its class, how
// often, and where it last happened. The message stays in the Errors panel.
export function errorRow(e: Pick<ErrorRecord, "id" | "ts" | "source" | "message" | "count" | "turn_event" | "span_id" | "resolved_ts">): TimelineRow {
  const cls = e.source === "provider" ? errorClass({ message: e.message }) : null;
  const n = e.count ?? 1;
  return clean({
    id: e.id, ts: e.ts, kind: "error" as const, sub: e.source, tone: (e.resolved_ts ? "plain" : "failed") as Tone,
    text: `${SOURCE[e.source] ?? "Other"} error${cls && CLASS[cls] ? ` (${CLASS[cls]})` : ""}${n > 1 ? `, ${n} times` : ""}${e.resolved_ts ? ", marked fixed" : ""}`,
    turn_event: e.turn_event, ...refs({ error_id: e.id, span_id: e.span_id }),
  });
}

// What the session is doing and waiting on now, most pressing first.
export type NowInput = {
  ts: number;
  turn?: { id: string; ts: number; opener?: Opener; steps: number; status: TurnStatus } | null;
  approvals: { id: string; tool?: string; risk?: string; created?: number; child_session?: string; child_title?: string }[];
  questions: { call_id: string; child_session?: string; child_title?: string }[];
  held?: { since?: number } | null; // a cut turn that was not continued
  waits: { id: string; kind: string; created: number; deadline: number }[];
  agents: { id: string; session_id: string; title: string; status: string; created: number }[];
  queue: { queued: number; steers: number; held: boolean; owed: boolean };
  loops: { id: string; name: string; next_ms: number }[];
  last?: { ts: number; outcome: string } | null;
};
const DOING = (s: TurnStatus): string => {
  switch (s.kind) {
    case "model": return s.connected ? "the model is answering" : "waiting for the model";
    case "tool": return `running ${s.names.slice(0, 3).join(", ")}${s.names.length > 3 ? ` and ${s.names.length - 3} more` : ""}`;
    case "retry": return `retrying the model request (attempt ${s.attempt} of ${s.max})`;
    case "compacting": return "compacting the context";
    default: return "between steps";
  }
};
const ENDED: Record<string, string> = {
  ok: "finished", error: "failed", refusal: "was declined by the model", stopped_by_owner: "was stopped by the owner",
  stopped_by_parent: "was stopped by its parent", cut: "was cut by a daemon restart", budget: "ended at its budget",
};
const AGENTS_SHOWN = 4;
export function nowLines(n: NowInput): TimelineNow {
  const lines: TimelineRow[] = [];
  const add = (id: string, kind: TimelineKind, tone: Tone, text: string, o: Partial<TimelineRow> = {}, r: Refs = {}) =>
    void lines.push(clean({ id: `now:${id}`, ts: o.ts ?? n.ts, kind, sub: "now", tone, text, ...o, ...refs(r) }));
  const inChild = (c: { child_session?: string; child_title?: string }) => (c.child_session ? `, in agent ${title(c.child_title, "of this session")}` : "");
  for (const a of n.approvals) {
    add(`approval:${a.id}`, "approval", "owner", `Waits on the owner: approval for ${a.tool ?? "a tool"}${a.risk === "high" ? " (high risk)" : ""}${inChild(a)}`, { ts: a.created, open: true }, { approval_id: a.id, child_session: a.child_session });
  }
  for (const q of n.questions) add(`question:${q.call_id}`, "question", "owner", `Waits on the owner: a question${inChild(q)}`, { open: true }, { call_id: q.call_id, child_session: q.child_session });
  if (n.held) add("held", "restart", "owner", "Waits on the owner: a turn cut by a daemon restart was not continued", { ts: n.held.since });
  if (n.turn) {
    const who = originOf(n.turn.opener);
    const head = who.key === "restart" ? "Running a turn continued after a daemon restart" : `Running a turn started by ${who.words}`;
    add("turn", "turn", "live", `${head}: step ${n.turn.steps + (n.turn.status.kind === "model" || n.turn.status.kind === "retry" ? 1 : 0) || 1}, ${DOING(n.turn.status)}`, { ts: n.turn.ts, open: true, turn_event: n.turn.id });
  }
  for (const a of n.agents.slice(0, AGENTS_SHOWN)) {
    add(`agent:${a.id}`, "agent", "live", `Agent ${title(a.title, "(untitled)")} ${a.status === "waiting" ? "is waiting on a wake of its own" : "is running"}`, { ts: a.created, open: true }, { agent_id: a.id, child_session: a.session_id });
  }
  if (n.agents.length > AGENTS_SHOWN) add("agents", "agent", "live", `${n.agents.length - AGENTS_SHOWN} more agents are running`, { open: true });
  for (const w of n.waits) add(`wait:${w.id}`, "wait", "plain", `Waits on ${waitWords(w.kind)}`, { ts: w.created, until: w.deadline, open: true }, { wait_id: w.id });
  const q = n.queue;
  if (q.queued || q.steers) {
    const parts = [q.queued ? plural(q.queued, "queued prompt") : "", q.steers ? plural(q.steers, "steer") : ""].filter(Boolean).join(" and ");
    add("queue", "queue", q.held ? "owner" : "plain", `${parts} ${q.queued + q.steers === 1 ? "waits" : "wait"}${q.held ? ": the queue is held until the owner resumes it" : n.turn ? " for the turn" : ""}`);
  } else if (q.held && !n.turn) add("queue", "queue", "plain", "The queue is held: nothing starts by itself until the owner sends or resumes");
  if (q.owed) add("owed", "queue", "plain", "A report or a wake waits for the turn to end");
  for (const l of n.loops.slice(0, 2)) add(`loop:${l.id}`, "loop", "plain", `Loop ${title(l.name, "(unnamed)")} runs next`, { until: l.next_ms }, { loop_id: l.id });
  const state: TimelineNow["state"] = n.approvals.length || n.questions.length || n.held ? "owner" : n.turn || n.agents.length ? "working" : n.waits.length || n.loops.length || q.queued || q.steers || q.owed ? "waiting" : "idle";
  if (!lines.length) add("idle", "idle", "plain", n.last ? `Nothing is running or waited on. The last turn ${ENDED[n.last.outcome] ?? "ended"}.` : "Nothing has run in this session yet.", n.last ? { ts: n.last.ts } : {});
  return { state, lines };
}

// The same story as text, for a model: one line per row, newest first, the ids
// that open a row's detail at the end of its line. Times are UTC.
const STATE: Record<TimelineNow["state"], string> = { working: "working", owner: "waiting on the owner", waiting: "waiting", idle: "idle" };
const stamp = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace("T", " ");
export function timelineText(p: TimelinePage, opts: { title?: string; ids?: boolean; now?: number } = {}): string {
  const at = opts.now ?? Date.now();
  const out: string[] = [`Timeline of session ${title(opts.title, p.session_id)} (${p.session_id}), newest first, UTC.`];
  if (p.now) {
    out.push(`Now: ${STATE[p.now.state]}.`);
    for (const l of p.now.lines) {
      const since = l.open && l.ts < at ? `, for ${dur(at - l.ts)}` : "";
      const due = l.until ? (l.until > at ? `, due in ${dur(l.until - at)}` : ", due now") : "";
      out.push(`  ${l.text}${since}${due}${opts.ids === false ? "" : idsOf(l)}`);
    }
  }
  if (!p.rows.length) out.push("No rows.");
  for (const r of p.rows) {
    const took = r.ms !== undefined && r.kind === "turn" ? `, ${dur(r.ms)}` : "";
    const cost = r.turn?.cost ? `, $${r.turn.cost < 0.01 ? r.turn.cost.toFixed(4) : r.turn.cost.toFixed(2)}` : "";
    out.push(`${stamp(r.ts)} ${r.tone === "failed" ? "!" : r.tone === "owner" ? "?" : " "} ${r.text}${took}${cost}${opts.ids === false ? "" : idsOf(r)}`);
  }
  if (p.next) out.push(`Older rows: before=${p.next}`);
  return out.join("\n");
}
function idsOf(r: TimelineRow): string {
  const ids = [
    r.kind === "turn" && r.turn_event ? `turn=${r.turn_event}` : "",
    r.refs?.error_id ? `error=${r.refs.error_id}` : "",
    r.kind === "agent" && r.refs?.child_session ? `session=${r.refs.child_session}` : "",
  ].filter(Boolean);
  return ids.length ? `  [${ids.join(" ")}]` : "";
}

// How a row counts for the "failures" filter: it failed, or something in it did.
export const isFailure = (r: TimelineRow) => r.tone === "failed" || !!r.bad;
