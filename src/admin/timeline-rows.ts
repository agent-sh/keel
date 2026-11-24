// The rows of a session's timeline: what happened, one plain sentence each.
// A row is built from records (ids, kinds, counts, classes, durations) and the
// titles the session list already shows. Its sentence never carries a prompt, a
// tool's input or output, a wait's note or an error's message: those stay behind
// the ids a row names (the turn's receipt, its trace, the agent's session, the
// error). A turn the owner started carries the first words of their prompt
// apart from the sentence (`about`), only for a reader that asks for it (the
// owner's page): the route leaves it out otherwise, and the text form, which
// a model reads, never has it.
import { localStamp, localTime, zoneNote } from "../core/clock.ts";
import { PEER_PREFIX } from "../core/owner.ts";
import type { ErrorRecord, TurnStatus } from "../core/types.ts";
import { classOfText, errorClass } from "./classes.ts";
import { waitWords } from "../core/watch.ts";
import { FAIL_WORD, NEEDS, STATE_WORD, attemptWords, failWord, limitWord, unreachableSince } from "../core/state-words.ts";
import { ownerStop, stopSays, stopper } from "../core/stoppers.ts";
import { probeWords } from "../engine/trail.ts";

export type TimelineKind =
  | "turn" | "agent" | "wait" | "loop" | "approval" | "question" | "compaction" | "model" | "restart" | "error" | "goal" | "limit" | "files" | "check" | "cache"
  // Only in "now": what is queued, and a session with nothing going on.
  | "queue" | "idle";
// Color is state: `failed` went wrong, `owner` waits on the owner, `live` runs now.
export type Tone = "plain" | "failed" | "owner" | "live";
export type Refs = {
  trace_id?: string; span_id?: string; error_id?: string; agent_id?: string; child_session?: string; child_turn?: string;
  wait_id?: string; loop_id?: string; run_id?: string; approval_id?: string; call_id?: string; queue_id?: string; from_session?: string;
  note_id?: string; // the note a "now" line stands for, so its row is not shown too
};
export type TurnFacts = {
  origin: string; queued?: true; outcome: string; reason?: string; model?: string;
  // `steps`: the replies the model gave. `failed_tools`: calls that ran and failed. `denied_tools`: calls a gate
  // refused before they ran (not failures). `branch`: "other" when the turn is not on the branch shown,
  // "unknown" when the read that made the row had not walked that far up the branch yet (see `partial`).
  steps: number; tools: number; failed_tools: number; denied_tools?: number; compactions?: number; branch?: "other" | "unknown";
  // `requests`: every model request of the turn; `failed_requests`: the attempts among them that failed.
  requests?: number; failed_requests?: number;
  input?: number; output?: number; cache_read?: number; cost?: number;
};
export type TimelineRow = {
  id: string;
  ts: number;
  kind: TimelineKind;
  sub: string;
  tone: Tone;
  text: string;
  about?: string;      // a turn the owner started: the first words of their prompt (the page only, never the text form)
  bad?: string;        // the part of `text` that went wrong inside a row that is otherwise fine ("2 failed tools")
  ms?: number;         // how long it took
  open?: true;         // not over yet: a running turn, a card not answered
  until?: number;      // when what it waits on is due
  turn_event?: string; // the turn it happened in (a turn's own row: itself): opens the receipt
  refs?: Refs;
  turn?: TurnFacts;
};
// `state`: the word of "now". It follows the session's one state (src/core/watch.ts) when the
// caller has it: needs you is `owner`, a stopped turn `stopped`, a cut one about to go on `resume`.
// `done`: its last turn ended; `idle`: no turn yet (the page's Done and Not started).
export type TimelineNow = { state: "working" | "owner" | "waiting" | "failed" | "declined" | "stopped" | "resume" | "done" | "idle"; lines: TimelineRow[] };
// `as_of`: when it was read (the daemon's clock). `scanned`: how many rows a
// filtered page read to find its rows, when it stopped at its bound.
// `partial`: a turn of the page is not placed on a branch yet (`turn.branch` "unknown"): the same read again goes on and places it.
export type TimelinePage = { session_id: string; as_of: number; now?: TimelineNow; rows: TimelineRow[]; next: string | null; scanned?: number; partial?: true };

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
// arrived (`origin`), else the owner typing. The owner's Continue is stored as
// a harness prompt with no kind of its own; a note the harness writes has one.
const WHO: Record<string, string> = {
  owner: "the owner", queued: "a queued prompt", steer: "a steer", continue: "the owner's Resume", harness: "a harness note", restart: "a daemon restart",
  voice: "the owner by voice", hook: "a stop hook", momentum: "a momentum message", wait: "a wait wake", wake: "several wakes",
  subagent: "an agent report", loop: "a loop run", goal: "a goal check", task: "its parent's task", parent: "its parent",
  peer: "another session", channel: "an event from a connected source", task_start: "a task from another session", verify_goal: "a goal verification", review: "a review request",
  review_fix: "review findings", diagnostic: "a diagnostic", helper_digest: "the helper's digest", failures: "a failure notice",
  command: "the end of a command it waited on", provider_wait: "Keel, after the provider's wait",
};
// The same, as the words a turn's row starts with: the column scans by them.
const LEAD: Record<string, string> = {
  owner: "Owner prompt", queued: "Queued prompt", steer: "Steer", continue: "Owner's Resume", harness: "Harness note", restart: "Resumed after a daemon restart",
  voice: "Owner by voice", hook: "Stop hook", momentum: "Momentum message", wait: "Wait wake", wake: "Several wakes",
  subagent: "Agent report", loop: "Loop run", goal: "Goal check", task: "Parent's task", parent: "Parent's message",
  peer: "Message from another session", channel: "Event from a connected source", task_start: "Task from another session", verify_goal: "Goal verification", review: "Review request",
  review_fix: "Review findings", diagnostic: "Diagnostic", helper_digest: "Helper digest", failures: "Failure notice",
  command: "Command ended", provider_wait: "Resumed by itself after the provider's wait",
};
// `continued`: the harness went on with a failed turn by itself when the wait the provider asked for was over (its round).
export type Opener = { about?: unknown; origin?: unknown; kind?: unknown; job?: unknown; queue_id?: unknown; wait_id?: unknown; agent_id?: unknown; loop_id?: unknown; run_id?: unknown; from?: unknown; outcome?: unknown; status?: unknown; continued?: unknown; parts?: unknown } | null | undefined;
export const whoWords = (key: string) => WHO[key] ?? "something else";
export function originOf(o: Opener): { key: string; words: string; lead: string; queued: boolean } {
  const origin = str(o?.origin), kind = str(o?.kind);
  // The end of a command its turn had been waiting on (a harness input that names the job, src/tools/jobs.ts).
  // A harness prompt with no kind is the owner's Resume, unless the harness wrote it itself after the provider's wait.
  const key = origin === "restart" ? "restart" : kind === "harness" && str(o?.job) ? "command" : kind && WHO[kind] ? kind
    : origin === "harness" && !kind ? (o?.continued != null ? "provider_wait" : "continue") : origin && WHO[origin] ? origin : kind || origin ? "other" : "owner";
  return { key, words: WHO[key] ?? "something else", lead: LEAD[key] ?? "Other input", queued: origin === "queued" && key !== "queued" };
}

// A turn's end reason as an outcome class: the classes of src/admin/outcomes.ts
// (a test holds the two together). Kept here so the page can load this file.
const NORMAL = new Set(["end_turn", "stop_sequence", "stop"]);
export function outcomeOf(reason: string, stoppedBy?: string | null): string {
  if (NORMAL.has(reason)) return "ok";
  if (reason === "interrupted") return ownerStop(stoppedBy) ? "stopped_by_owner" : stopper(stoppedBy).parent ? "stopped_by_parent" : "stopped";
  if (reason === "restart") return "cut";
  if (reason === "max_steps" || reason === "max_tokens" || reason === "budget") return "budget";
  if (reason === "refusal") return "refusal";
  return "error";
}

export type TurnInput = {
  start: { id: string; ts: number; model?: string };
  opener?: Opener;
  // `crashed`: the daemon went down under it. `unstarted`: it never began (the pair a restart writes for a prompt it found accepted).
  end?: { reason: string; ms?: number; provider_wait_ms?: number; ts?: number; stopped_by?: string | null; crashed?: boolean; unstarted?: boolean } | null;
  // What it spent: its rollup over all its requests when there is one, else what its end says.
  usage?: { input?: number; output?: number; cache_read?: number; cost?: number | null } | null;
  running?: boolean;
  steps: number;
  // Every model request made while it ran, and of them the attempts that failed (a retry sent again, the one it ended on).
  requests?: number;
  failed_requests?: number;
  tools: number;
  failed_tools: number;
  denied_tools?: number;
  compactions?: number;
  error_id?: string;
  // Whether it is on the branch shown: "unknown" until the walk from the session's head has reached it.
  branch?: "on" | "other" | "unknown";
  // What woke it, told in its own row instead of a row of its own: the wait
  // that fired, or the agent whose report it is.
  wake?: { kind?: string; ms?: number } | null;
  agent?: { title?: string; session_id?: string } | null;
};

// The first words of a prompt, on one line: cut at a word when it is longer than a row holds.
export const ABOUT_MAX = 96;
export function aboutOf(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  // Words another session or the harness wrote are not the owner's, also when their record does not say whose they are.
  if (!line || line.startsWith(PEER_PREFIX) || line.startsWith("[harness]")) return undefined;
  if (line.length <= ABOUT_MAX) return line;
  const cut = line.slice(0, ABOUT_MAX);
  const at = cut.lastIndexOf(" ");
  return `${(at > ABOUT_MAX * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}...`;
}

export function turnRow(t: TurnInput): TimelineRow {
  const who = originOf(t.opener);
  const outcome = t.end?.unstarted ? "unstarted" : t.end ? outcomeOf(t.end.reason, t.end.stopped_by) : t.running ? "running" : "open";
  const told = who.key === "wait" && t.wake ? ` (${waitWords(t.wake.kind)}${t.wake.ms !== undefined && t.wake.ms >= 0 ? `, after ${dur(t.wake.ms)}` : ""})`
    : who.key === "subagent" && t.agent ? ` from ${title(t.agent.title, "an agent")}`
      // Several reports in one input: how many (each is named in its own row of the agent's end).
      : who.key === "subagent" && Number(t.opener?.parts) > 1 ? ` from ${Number(t.opener!.parts)} agents` : "";
  const head = `${who.lead}${told}${who.queued ? " (queued)" : ""}`;
  const n = plural(t.steps, "step");
  const after = t.steps ? ` after ${n}` : " before its first step";
  const bad = t.failed_tools ? plural(t.failed_tools, "failed tool") : undefined;
  let text: string;
  let tone: Tone = "plain";
  switch (outcome) {
    case "running": text = `${head}: running, ${t.steps ? `${n} so far` : "on its first step"}`; tone = "live"; break;
    case "ok": text = `${head}, ${n}`; break;
    case "error": text = `${head}: failed${after}`; tone = "failed"; break;
    case "refusal": text = `${head}: the model declined${after}`; tone = "failed"; break;
    // In the stopper's own words (src/core/stoppers.ts): the owner only when the owner stopped it.
    case "stopped_by_owner": case "stopped_by_parent": case "stopped": text = `${head}, ${stopSays(t.end!.stopped_by)}${after}`; break;
    case "cut": text = `${head}, cut ${t.end!.crashed ? "when the daemon went down" : "by a daemon restart"}${after}`; break;
    case "budget": text = `${head}, ended at ${t.end!.reason === "max_tokens" ? "the output limit" : "its step budget"}${after}`; break;
    // No turn ran: the row says what happened instead of a turn of no length.
    case "unstarted": text = "A prompt was accepted; the daemon went down before its turn started"; break;
    default: text = `${head}: no end was recorded, ${n}`;
  }
  // A turn whose requests were sent again says so: its steps count the replies, not the attempts.
  if (t.end?.provider_wait_ms) text += `, waited ${dur(t.end.provider_wait_ms)} for the provider`;
  if (t.failed_requests && t.requests) text += `, ${plural(t.requests, "request")}, ${t.failed_requests} failed`;
  if (bad) text += `, ${bad}`;
  // A call the owner, a rule or the judge refused is a decision, not a failure.
  if (t.denied_tools) text += `, ${plural(t.denied_tools, "denied call")}`;
  if (t.branch === "other") text += ", on a branch not shown";
  else if (t.branch === "unknown") text += ", branch not placed yet";
  const u = t.usage;
  const took = t.end && outcome !== "unstarted" ? t.end.ms ?? (t.end.ts !== undefined ? t.end.ts - t.start.ts : undefined) : undefined;
  return clean({
    id: t.start.id, ts: t.start.ts, kind: "turn" as const, sub: outcome, tone, text, bad, about: aboutOf(t.opener?.about),
    // A turn of no length (stopped while it was set up) has no duration to show.
    ms: took ? took : undefined,
    open: outcome === "running" ? (true as const) : undefined,
    turn_event: t.start.id,
    ...refs({ error_id: t.error_id, queue_id: str(t.opener?.queue_id), wait_id: str(t.opener?.wait_id), agent_id: str(t.opener?.agent_id), loop_id: str(t.opener?.loop_id), run_id: str(t.opener?.run_id), from_session: str(t.opener?.from), child_session: who.key === "subagent" ? t.agent?.session_id : undefined }),
    turn: clean({
      origin: who.key, queued: who.queued || who.key === "queued" ? (true as const) : undefined, outcome, reason: t.end?.reason, model: t.start.model,
      steps: t.steps, requests: t.requests, failed_requests: t.failed_requests || undefined, tools: t.tools, failed_tools: t.failed_tools, denied_tools: t.denied_tools || undefined, compactions: t.compactions || undefined, branch: t.branch === "other" || t.branch === "unknown" ? t.branch : undefined,
      input: u?.input, output: u?.output, cache_read: u?.cache_read, cost: u?.cost ?? undefined,
    }),
  });
}

// The marks a session's events leave besides its turns. A turn's end makes no
// row of its own: the turn's row says how it ended (cut by a restart included).
export type Mark = { id: string; ts: number; kind: string; data: Record<string, any> | null };
const short = (model: unknown) => String(model ?? "").split(":").pop() || "another model";
const tokens = (n: unknown) => (typeof n === "number" && n > 0 ? `, from ${n < 1000 ? n : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`} tokens` : "");
// The kinds of note that make a row: the timeline's index holds these notes
// and no other, so a kind told here is named here (a test holds the two together).
export const NOTE_MARKS = ["model_told", "fallback", "restart", "compaction_failed", "rewind", "fork", "cache_plan"] as const;
// A cache plan's row (src/engine/cache-plans.ts): what the wait did with the prompt cache, and what it cost against a rewrite.
const usd = (x: unknown) => { const n = Number(x) || 0; return n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`; };
function cacheLine(d: Record<string, any>): string {
  const n = Number(d.pings) || 0, long = dur(Number(d.waited_ms) || 0);
  const reqs = `${n} ${n === 1 ? "request" : "requests"}`;
  // (A note from before the next request was checked has no next_read_tokens: it says what it said then.)
  const warm = `${n} warm ${n === 1 ? "request" : "requests"}`, tok = (x: unknown) => (Number(x) || 0).toLocaleString("en-US");
  if (d.outcome === "warm" && d.next_read_tokens !== undefined) return `Kept the prompt cache warm through a wait of ${long}: ${warm} for ${usd(d.spent_usd)}, and the next request read it, where writing the context again would cost ${usd(d.lapse_usd)}`;
  if (d.outcome === "warm") return `Kept the prompt cache warm through a wait of ${long}: ${reqs} for ${usd(d.spent_usd)}, where writing the context again would cost ${usd(d.lapse_usd)}`;
  if (d.outcome === "warm_missed") return `The warm requests did not keep the prompt cache through a wait of ${long}: ${warm} for ${usd(d.spent_usd)}, and the next request read ${tok(d.next_read_tokens)} of ${tok(d.tokens)} tokens and wrote the rest again for about ${usd(d.lapse_usd)}`;
  if (d.outcome === "warm_unchecked") return `Sent ${warm} for ${usd(d.spent_usd)} through a wait of ${long}; no request read the cache while it lived after them, so whether they kept it is not known`;
  if (d.outcome === "summary") return `Prepared the summary while the cache was warm, for a wait of ${long}; writing the whole context again would cost ${usd(d.lapse_usd)}`;
  if (d.outcome === "lapsed" && d.before_wait) return `The prompt cache had lapsed before this wait began, ${dur(Number(d.idle_ms) || 0)} after the request that last read it: nothing could keep it, and the next request writes the context again for about ${usd(d.lapse_usd)}`;
  if (d.outcome === "lapsed") return `The prompt cache lapsed during a wait of ${long}${n ? ` after ${reqs} for ${usd(d.spent_usd)}` : ""}: writing the context again costs about ${usd(d.lapse_usd)}`;
  return `The wait of ${long} ended before the cache lapsed`;
}
export function markRow(e: Mark, turn?: string): TimelineRow | null {
  const d = e.data ?? {};
  const row = (kind: TimelineKind, sub: string, text: string, tone: Tone = "plain"): TimelineRow => clean({ id: e.id, ts: e.ts, kind, sub, tone, text, turn_event: turn });
  if (e.kind === "compaction") {
    const text = d.mode === "clear" ? "Context cleared" : d.trigger === "model" ? "The model started a fresh context" : d.capsule ? "Context replaced by a capsule of the agent's work for its follow-up" : d.trigger === "follow_up" ? "Context summarized for the agent's follow-up" : d.auto ? "Context compacted by itself" : "Context compacted by the owner";
    const kept = probeWords(d.probe);
    return row("compaction", String(d.mode ?? "summary"), `${text}${tokens(d.tokens_before)}${kept ? `; ${kept}` : ""}`);
  }
  if (e.kind !== "note") return null;
  switch (d.kind) {
    case "model_told": return row("model", "switch", `Model changed from ${short(d.from)} to ${short(d.to)}`);
    case "fallback": return row("model", "fallback", d.overloaded ? "The model stayed overloaded: the turn went on with the fallback model" : "The model declined: the turn went on with the fallback model");
    case "restart": return row("restart", "held", "Not resumed after the daemon restart: it waits for the owner", "owner");
    case "compaction_failed": return row("compaction", "failed", "The context could not be compacted", "failed");
    // Written when files are put back from a checkpoint: the conversation is as it was.
    case "rewind": return row("files", "restored", "Files were restored to an earlier state");
    case "fork": return row("model", "fork", "Forked from another session");
    // What a wait did with the prompt cache, and its cost (src/engine/cache-plans.ts).
    case "cache_plan": return row("cache", String(d.outcome ?? "plan"), cacheLine(d), d.outcome === "lapsed" || d.outcome === "warm_missed" ? "failed" : "plain");
    default: return null;
  }
}

// What the activity list recorded, with the records its ids name.
export type ActivityIn = { id: string; ts: number; kind: string; sub: string; text: string; data?: Record<string, any> | null; turn_event?: string | null };
export type Lookups = {
  agent?(id: string): { session_id?: string; title?: string; type?: string; status?: string; created?: number; ended?: number | null; stopped_by?: string | null; end_reason?: string | null } | undefined;
  wait?(id: string): { kind?: string; status?: string; created?: number; deadline?: number; ended?: number | null } | undefined;
  loop?(id: string): { name?: string } | undefined;
  // `from`: where the owner's answer was given ("the phone (Pixel)"), when the card kept it.
  approval?(id: string): { tool?: string; risk?: string; state?: string; choice?: string; created?: number; resolved?: number; from?: string } | undefined;
};
export { waitWords };
const STOPPED: Record<string, string> = {
  owner: "the owner stopped it", parent: "its parent stopped it", ancestor: "an agent above it was stopped", parent_turn: "it stopped with its parent's turn",
  time_limit: "its time limit passed", parent_archived: "its parent session was archived",
};
const AGENT_END: Record<string, string> = { refusal: "the model declined", max_tokens: "it hit the output limit", max_steps: "it ran out of its step budget", budget: "it ran out of its budget" };
const CHOICE: Record<string, string> = { once: " once", session: " for the session", always: " from now on" };
const toolOf = (text: string) => { const t = text.split(":")[0] ?? ""; return /^[\w.-]{1,80}$/.test(t) ? t : "a tool"; };

// `own`: the row is read for the agent's own session (its happenings are
// stored under its parent): it is that session's row, in that session's turn.
export function activityRow(a: ActivityIn, look: Lookups = {}, own = false): TimelineRow | null {
  const d = a.data ?? {};
  // A subagent's happening is listed under its parent: the row says whose it is.
  const inChild = !own && d.child_session && a.kind !== "agent" ? `, in agent ${title(d.child_title, "of this session")}` : "";
  const row = (kind: TimelineKind, text: string, o: Partial<TimelineRow> = {}, r: Refs = {}): TimelineRow => clean({
    id: a.id, ts: a.ts, kind, sub: a.sub, tone: "plain" as Tone, text: `${text}${inChild}`, turn_event: (own ? str(d.child_turn) : a.turn_event) ?? undefined, ...o,
    ...refs(own ? r : { child_session: str(d.child_session), child_turn: str(d.child_turn), ...r }),
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
      // Every agent slot worked: it was made and waits to start, or its wake waits for a slot.
      case "queued": return row("agent", `${name} waits for a free agent slot to start`, {}, r);
      case "slot_wait": return row("agent", `${name} was woken and waits for a free agent slot`, {}, r);
      // A message continued it after it reported: where its new work started.
      // It started with lessons of its repository in its task (src/automation/lessons.ts).
      case "lessons": {
        const n = Array.isArray(d.lessons) ? d.lessons.length : 0;
        return row("agent", `${name} started with ${n === 1 ? "a lesson" : `${n} lessons`} of ${str(d.repo) ?? "its repository"}${typeof d.tokens === "number" ? `, about ${d.tokens} tokens` : ""}`, {}, r);
      }
      case "follow_up": return row("agent", `${name} took up new work: ${d.why ? String(d.why).replace(/^./, (c) => c.toLowerCase()) : String(d.way ?? "")}`, {}, r);
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
      case "fired": return row("wait", `Wait on ${on} fired${took}${typeof d.late === "string" ? `, ${d.late}` : ""}`, { ms }, r);
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
    // (A card closed by a grant, a mode change or a stop has no answer of the owner's to place.)
    const from = p?.from && a.sub !== "cancelled" ? ` from ${p.from}` : "";
    return row("approval", `Approval for ${tool} ${said}${from}${ms !== undefined && ms >= 0 ? ` after ${dur(ms)}` : ""}`, { ms }, { approval_id: d.approval_id });
  }
  if (a.kind === "alert") {
    if (a.sub === "approval") {
      const p = d.approval_id ? look.approval?.(d.approval_id) : undefined;
      const pending = p?.state === "pending";
      return row("approval", `Approval asked${p?.tool ? ` for ${p.tool}` : ""}${p?.risk === "high" ? " (high risk)" : ""}`, pending ? { tone: "owner", open: true, sub: "asked" } : { sub: "asked" }, { approval_id: str(d.approval_id) });
    }
    if (a.sub === "question") return row("question", "Asked the owner a question", { sub: "asked" }, { call_id: str(d.call_id) });
    // Which limit, and when it lifts when the provider said (a rate limit is not a usage limit).
    if (a.sub === "limit") return row("limit", d.cls ? `${limitWord(d.cls)}${typeof d.until === "number" ? `: wait until ${localTime(d.until).slice(0, 5)}` : ""}` : "A usage limit is close", { sub: "close" });
    return null;
  }
  // A standing ruling (src/automation/rulings.ts): kept from an answer here, used for a question asked here, revoked.
  if (a.kind === "ruling") {
    const id = str(d.ruling_id)?.slice(-8);
    const where = d.scope === "everywhere" ? "everywhere" : d.scope === "repo" ? "for its repository" : "for its tree of agents";
    if (a.sub === "used") return row("question", `Answered a question from standing ruling ${id ?? ""} (kept ${where}), with no card`, {}, { call_id: str(d.call_id) });
    if (a.sub === "kept") return row("question", `The owner kept an answer as standing ruling ${id ?? ""}, ${where}`, {}, { call_id: str(d.call_id) });
    if (a.sub === "revoked") return row("question", `The owner revoked standing ruling ${id ?? ""}`);
    return null;
  }
  if (a.kind === "turn" && a.sub === "goal") {
    const m = /^Goal (set|cleared|paused)|^Goal (check|verification): ([a-z ]+)\./.exec(a.text);
    if (!m) return null;
    return row("goal", m[1] ? `Goal ${m[1]}` : `Goal ${m[2]}: ${m[3]}`, { sub: m[1] ?? m[2]! });
  }
  return null;
}

const SOURCE: Record<string, string> = { provider: "Model request", tool: "Tool", server: "Daemon", client: "Page" };
// (The vocabulary's one word a class, src/core/state-words.ts: the timeline, the digest and a session's row say the same.)
export const CLASS: Record<string, string> = FAIL_WORD;
// A run of one of the repository's checks (src/checks): its name, how it
// ended, its counts and the tree it ran on. The name is the repository's word
// for it, never the command as the model wrote it.
export type CheckIn = { id: number; ts: number; name: string; result: string; pass: number | null; fail: number | null; tree: string; started: number; by: string; call_id: string | null };
const CHECK_SAID: Record<string, string> = { pass: "passed", fail: "failed", stopped: "was stopped", unknown: "ended, its status not known", answered: "answered from the ledger: it passed on these files before" };
export function checkRow(c: CheckIn): TimelineRow {
  const counts = [c.pass !== null ? `${c.pass} pass` : "", c.fail !== null ? `${c.fail} fail` : ""].filter(Boolean).join(", ");
  const name = c.name.replace(/[^\w.:-]/g, "").slice(0, 40) || "?";
  return clean({
    id: `c:${c.id}`, ts: c.ts, kind: "check" as const, sub: c.result, tone: (c.result === "fail" ? "failed" : "plain") as Tone,
    text: `Check ${name} ${CHECK_SAID[c.result] ?? c.result}${counts && c.result !== "answered" ? ` (${counts})` : ""}${c.by === "owner" ? ", run by the owner" : ""}, ${c.tree ? `on tree ${c.tree.slice(0, 9)}` : "with no tree kept (its files were too large to read)"}`,
    ms: c.result === "answered" ? undefined : Math.max(0, c.ts - c.started), ...refs({ call_id: c.call_id ?? undefined }),
  });
}

// A kind of failure that last happened in this session. The errors table folds
// repeats across every session, so its count is said as that; the message
// stays in the Errors panel.
export function errorRow(e: Pick<ErrorRecord, "id" | "ts" | "source" | "message" | "count" | "turn_event" | "span_id" | "resolved_ts" | "recovered_ts">): TimelineRow {
  const cls = e.source === "provider" ? errorClass({ message: e.message }) : null;
  const n = e.count ?? 1;
  // A hook of the owner's that failed is the hook's, in its own words: the tool it ran for did not fail.
  const hook = e.source === "tool" && /^Hook (timed out|failed on) /.test(e.message) ? e.message.split("\n")[0]!.slice(0, 200) : undefined;
  return clean({
    id: e.id, ts: e.ts, kind: "error" as const, sub: e.source, tone: (e.resolved_ts || e.recovered_ts ? "plain" : "failed") as Tone,
    text: `${hook ?? `${SOURCE[e.source] ?? "Other"} error${cls && CLASS[cls] ? ` (${CLASS[cls]})` : ""}`}${n > 1 ? `, ${n} times in all sessions` : ""}${e.resolved_ts ? ", marked fixed" : e.recovered_ts ? ", recovered" : ""}`,
    turn_event: e.turn_event, ...refs({ error_id: e.id, span_id: e.span_id }),
  });
}

// A cause of failed model requests in this session's own record (one row per
// cause, with the session's count and its agents'): the count is this
// session's, whatever happened elsewhere. `link`: the Errors row of the same
// class that last happened here, when there is one.
export type FailureIn = { fp: string; cls: string; count: number; last_ts: number; refs?: { id: string; n: number }[] };
export function failureRow(g: FailureIn, link?: Pick<ErrorRecord, "id" | "turn_event" | "span_id" | "resolved_ts">): TimelineRow {
  const inAgents = (g.refs ?? []).filter((r) => r.id !== "self").reduce((n, r) => n + r.n, 0);
  return clean({
    id: `f:${g.fp}`, ts: g.last_ts, kind: "error" as const, sub: "provider", tone: (link?.resolved_ts ? "plain" : "failed") as Tone,
    text: `Model request failed${CLASS[g.cls] ? ` (${CLASS[g.cls]})` : ""}${g.count > 1 ? `, ${g.count} times` : ""}${inAgents ? `, ${inAgents === g.count ? "all" : inAgents} in its agents` : ""}${link?.resolved_ts ? ", marked fixed" : ""}`,
    turn_event: link?.turn_event, ...refs({ error_id: link?.id, span_id: link?.span_id }),
  });
}

// What the session is doing and waiting on now, most pressing first.
export type NowInput = {
  ts: number;
  // `output`: when the reply being streamed last gave output (absent between requests).
  // `failed_tools`: the calls of this turn that failed up to now.
  turn?: { id: string; ts: number; opener?: Opener; steps: number; status: TurnStatus; output?: number; failed_tools?: number } | null;
  starting?: boolean; // a turn is being set up: nothing of it is stored yet
  approvals: { id: string; call_id?: string; tool?: string; risk?: string; created?: number; child_session?: string; child_title?: string }[];
  questions: { call_id: string; child_session?: string; child_title?: string }[];
  plans?: { id: string; created?: number; child_session?: string; child_title?: string }[]; // plans presented for approval
  secrets?: { id: string; created?: number; child_session?: string; child_title?: string }[]; // secrets asked for and not given yet
  resumes?: { at: number; since?: number } | null; // the failed turn resumes by itself then (the provider asked for the wait)
  jobs?: { id: string; started: number }[]; // commands left running in the background
  // The session's one state (src/core/watch.ts), when the caller has it: the word of "now" follows it.
  watch?: string;
  held?: { since?: number; note_id?: string } | null; // a cut turn that was not continued
  waits: { id: string; kind: string; created: number; deadline: number }[];
  // `wait`: what an agent that waits is waiting on, and for a timer when it is due.
  // `since`: when what it does now began (its running turn, or its wait): the time it shows counts from there, not from its start.
  agents: { id: string; session_id: string; title: string; status: string; created: number; since?: number; wait?: { kind: string; until?: number; id?: string; since?: number } }[];
  queue: { queued: number; steers: number; held: boolean; owed: boolean };
  loops: { id: string; name: string; next_ms: number }[];
  last?: { ts: number; outcome: string } | null;
};
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const DOING = (s: TurnStatus, now: number, output?: number): string => {
  switch (s.kind) {
    // A stream that gave output and then stopped says so, with how long it has been silent.
    case "model": return s.quiet ? `the model is answering, no output for ${dur(now - s.quiet)}` : s.connected ? "the model is answering" : "waiting for the model";
    case "tool": return `running ${s.names.slice(0, 3).join(", ")}${s.names.length > 3 ? ` and ${s.names.length - 3} more` : ""}`;
    // A provider that cannot be reached is waited for, not retried by count; a counted retry names its cause.
    case "retry": { if (s.unreachable) return `${STATE_WORD.wait.toLowerCase()}: ${lower(unreachableSince(localTime(s.unreachable).slice(0, 5)))}`; const why = failWord(classOfText(s.message)); return `retrying the model request (${attemptWords(s.attempt, s.max)}${why ? `: ${why}` : ""})`; }
    case "compacting": return "compacting the context";
    default: return output ? "the model is answering" : "between steps";
  }
};
const TIMER_SLACK_MS = 60_000;
const NOW_STATE: Record<string, TimelineNow["state"]> = { need: "owner", work: "working", wait: "waiting", fail: "failed", declined: "declined", stop: "stopped", resume: "resume", done: "done" };
// How the last turn ended, as a state, where the daemon's own word is not at hand.
const LAST_STATE: Record<string, TimelineNow["state"]> = { ok: "done", error: "failed", refusal: "declined", stopped_by_owner: "stopped", stopped_by_parent: "stopped", stopped: "stopped", cut: "stopped", budget: "stopped" };
const ENDED: Record<string, string> = {
  ok: "finished", error: "failed", refusal: "was declined by the model", stopped_by_owner: "was stopped by the owner",
  stopped_by_parent: "was stopped by its parent", stopped: "was stopped", cut: "was cut by a daemon restart", budget: "ended at its budget",
};
const AGENTS_SHOWN = 4;
export function nowLines(n: NowInput): TimelineNow {
  const lines: TimelineRow[] = [];
  const add = (id: string, kind: TimelineKind, tone: Tone, text: string, o: Partial<TimelineRow> = {}, r: Refs = {}) =>
    void lines.push(clean({ id: `now:${id}`, ts: o.ts ?? n.ts, kind, sub: "now", tone, text, ...o, ...refs(r) }));
  const inChild = (c: { child_session?: string; child_title?: string }) => (c.child_session ? `, in agent ${title(c.child_title, "of this session")}` : "");
  for (const a of n.approvals) {
    add(`approval:${a.id}`, "approval", "owner", `${STATE_WORD.need}: ${NEEDS.approval} for ${a.tool ?? "a tool"}${a.risk === "high" ? " (high risk)" : ""}${inChild(a)}`, { ts: a.created, open: true }, { approval_id: a.id, call_id: a.call_id, child_session: a.child_session });
  }
  for (const q of n.questions) add(`question:${q.call_id}`, "question", "owner", `${STATE_WORD.need}: ${NEEDS.question}${inChild(q)}`, { open: true }, { call_id: q.call_id, child_session: q.child_session });
  for (const c of n.secrets ?? []) add(`secret:${c.id}`, "question", "owner", `${STATE_WORD.need}: ${NEEDS.secret}${inChild(c)}`, { ...(c.created ? { ts: c.created } : {}), open: true }, { call_id: c.id, child_session: c.child_session });
  if (n.resumes) add("resumes", "limit", "plain", "Resumes by itself when the wait the provider asked for is over", { ...(n.resumes.since ? { ts: n.resumes.since } : {}), until: n.resumes.at, open: true });
  for (const p of n.plans ?? []) add(`plan:${p.id}`, "question", "owner", `${STATE_WORD.need}: ${NEEDS.plan}${inChild(p)}`, { ...(p.created ? { ts: p.created } : {}), open: true }, { child_session: p.child_session });
  if (n.held) add("held", "restart", "owner", `${STATE_WORD.need}: ${NEEDS.resume}, cut by a daemon restart`, { ts: n.held.since }, { note_id: n.held.note_id });
  if (n.turn) {
    const who = originOf(n.turn.opener);
    const head = who.key === "restart" ? "Running a turn resumed after a daemon restart" : `Running a turn started by ${who.words}`;
    // A call of this session's own turn whose card is open has not started: the turn waits on the answer.
    const asking = n.turn.status.kind === "tool" && n.approvals.some((a) => !a.child_session);
    // What failed in it up to now is said here: a running turn is not a row, so nothing else would say it.
    const bad = n.turn.failed_tools ? plural(n.turn.failed_tools, "failed tool") : undefined;
    add("turn", "turn", "live", `${head}: step ${n.turn.steps + (n.turn.status.kind === "model" || n.turn.status.kind === "retry" ? 1 : 0) || 1}, ${bad ? `${bad} so far, ` : ""}${asking ? `${STATE_WORD.need.toLowerCase()}: ${NEEDS.approval}` : DOING(n.turn.status, n.ts, n.turn.output)}`, { ts: n.turn.ts, open: true, turn_event: n.turn.id, ...(bad ? { bad } : {}) });
  } else if (n.starting) add("turn", "turn", "live", "Starting a turn", { open: true });
  for (const a of n.agents.slice(0, AGENTS_SHOWN)) {
    // A parked agent says what it waits for; a timer's wake time makes the line say when it is due.
    // A command it left running is named by its id, as its parent stops or reads it.
    const on = !a.wait ? "a wake of its own" : a.wait.kind === "command" && a.wait.id ? `command ${a.wait.id}` : waitWords(a.wait.kind);
    const parked = a.status === "waiting" ? `is ${STATE_WORD.wait.toLowerCase()} for ${on}` : "is working";
    // Counted from what it does now: a turn resumed after a restart does not count the time the daemon was down.
    const since = a.status === "waiting" ? a.wait?.since : a.since;
    add(`agent:${a.id}`, "agent", "live", `Agent ${title(a.title, "(untitled)")} ${parked}`, { ts: Math.max(a.created, since ?? a.created), open: true, ...(a.status === "waiting" && a.wait?.until ? { until: a.wait.until } : {}) }, { agent_id: a.id, child_session: a.session_id });
  }
  if (n.agents.length > AGENTS_SHOWN) add("agents", "agent", "live", `${n.agents.length - AGENTS_SHOWN} more agents are working`, { open: true });
  // A timer is due at its wake time (its deadline is a minute later: it fires, it does not time out).
  for (const w of n.waits) add(`wait:${w.id}`, "wait", "plain", `${STATE_WORD.wait} for ${waitWords(w.kind)}`, { ts: w.created, until: w.kind === "timer" ? w.deadline - TIMER_SLACK_MS : w.deadline, open: true }, { wait_id: w.id });
  // A command left running after the turn is work that goes on, not a wait (the session's state says Working).
  for (const j of n.jobs ?? []) add(`job:${j.id}`, "wait", "plain", "A command runs in the background", { ts: j.started, open: true });
  const q = n.queue;
  if (q.queued || q.steers) {
    const parts = [q.queued ? plural(q.queued, "queued prompt") : "", q.steers ? plural(q.steers, "steer") : ""].filter(Boolean).join(" and ");
    add("queue", "queue", q.held ? "owner" : "plain", `${parts} ${q.queued + q.steers === 1 ? "waits" : "wait"}${q.held ? ": the queue is held until the owner resumes it" : n.turn ? " for the turn" : ""}`);
  } else if (q.held && !n.turn) add("queue", "queue", "plain", "The queue is held: nothing starts by itself until the owner sends or resumes");
  if (q.owed) add("owed", "queue", "plain", "A report or a wake waits for the turn to end");
  for (const l of n.loops.slice(0, 2)) add(`loop:${l.id}`, "loop", "plain", `Loop ${title(l.name, "(unnamed)")} runs next`, { until: l.next_ms }, { loop_id: l.id });
  // The word is the session's one state: the lines below it say what is going on and what waits,
  // and never a different word. A loop's next run and a held queue are lines, not a state.
  // Without the state (a store read with no daemon) the word is read off the lines.
  const own: TimelineNow["state"] = n.approvals.length || n.questions.length || n.plans?.length || n.secrets?.length || n.held ? "owner" : n.turn || n.starting || n.agents.length || n.jobs?.length ? "working" : n.waits.length ? "waiting" : n.last ? LAST_STATE[n.last.outcome] ?? "done" : "idle";
  const state: TimelineNow["state"] = n.watch === undefined ? own : NOW_STATE[n.watch] ?? "idle";
  if (!lines.length) add("idle", "idle", "plain", n.last ? `Nothing is running or waited on. The last turn ${ENDED[n.last.outcome] ?? "ended"}.` : "Nothing has run in this session yet.", n.last ? { ts: n.last.ts } : {});
  return { state, lines };
}

// The same story as text, for a model: one line per row, newest first, the ids
// that open a row's detail or that a coordinator acts on at the end of its
// line (`ids: false` leaves them out). Times are the machine's own zone, the
// one alerts and the page use, and the first line says which.
const STATE: Record<TimelineNow["state"], string> = { working: "working", owner: STATE_WORD.need.toLowerCase(), waiting: "waiting", failed: "failed", declined: "declined by the model", stopped: "stopped", resume: "waiting to resume", done: "done", idle: "not started" };
const stamp = (ts: number) => localStamp(ts).slice(5);
// What is new to a reader that last read at `mark`: a row that began since, or a turn that ended since
// (it was running then, told under "now", and had no row).
export const newSince = (r: TimelineRow, mark: number) => r.ts > mark || (r.kind === "turn" && r.ms !== undefined && r.ts + r.ms > mark);
// `fresh`: the reader asked only for what is new since it last read (`since`: when that was; null: no
// earlier read of it is kept, so every row is new to it). With nothing new the answer is one line.
export function timelineText(p: TimelinePage, opts: { title?: string; ids?: boolean; fresh?: { since: number | null } } = {}): string {
  const at = p.as_of;
  const last = opts.fresh?.since;
  if (last != null && !p.rows.length && !p.next) return `Nothing new in session ${title(opts.title, p.session_id)} since you last read it at ${localTime(last)} (${dur(at - last)} ago).${p.now ? ` Now: ${STATE[p.now.state]}.` : ""}`;
  const what = !opts.fresh ? "newest first" : last == null ? `newest first (no earlier read of yours is kept: ${p.next ? "the newest rows; the next read with new goes from this one" : "every row"})` : `new since you last read it at ${localTime(last)}, newest first`;
  const out: string[] = [`Timeline of session ${title(opts.title, p.session_id)} (${p.session_id}), ${what}. ${zoneNote(at)}; read at ${localStamp(at)}.`];
  if (p.now) {
    out.push(`Now: ${STATE[p.now.state]}.`);
    for (const l of p.now.lines) {
      // A line that already says how long (a silent stream) is not given the turn's time after it.
      const since = l.open && l.ts < at && !/ for \d+ (ms|s|min|h|d)\b[^,]*$/.test(l.text) ? `, for ${dur(at - l.ts)}` : "";
      const due = l.until ? (l.until > at ? `, due in ${dur(l.until - at)}` : ", due now") : "";
      out.push(`  ${l.text}${since}${due}${opts.ids === false ? "" : idsOf(l)}`);
    }
  }
  if (!p.rows.length) out.push(p.next && p.scanned ? `None in the newest ${p.scanned} rows.` : "No rows.");
  for (const r of p.rows) {
    const took = r.ms !== undefined && r.kind === "turn" ? `, ${dur(r.ms)}` : "";
    const cost = r.turn?.cost ? `, $${r.turn.cost < 0.01 ? r.turn.cost.toFixed(4) : r.turn.cost.toFixed(2)}` : "";
    out.push(`${stamp(r.ts)} ${r.tone === "failed" ? "!" : r.tone === "owner" ? "?" : " "} ${r.text}${took}${cost}${opts.ids === false ? "" : idsOf(r)}`);
  }
  if (p.next) out.push(`Older rows: before=${p.next}`);
  // Said plainly, so a row without "on a branch not shown" is not taken for a row on the branch.
  if (p.partial) out.push(`${p.rows.filter((r) => r.turn?.branch === "unknown").length} of these turns are not placed on a branch yet (marked "branch not placed yet"): this session is long and the read stopped part way. The same read again goes on.`);
  return out.join("\n");
}
function idsOf(r: TimelineRow): string {
  const now = r.sub === "now";
  const ids = [
    r.kind === "turn" && r.turn_event ? `turn=${r.turn_event}` : "",
    r.refs?.error_id ? `error=${r.refs.error_id}` : "",
    r.kind === "agent" && r.refs?.child_session ? `session=${r.refs.child_session}` : "",
    // What a coordinator acts on: the wait to cancel, the card to answer (in the agent's session when it is an agent's).
    now && r.refs?.wait_id ? `wait=${r.refs.wait_id}` : "",
    now && r.refs?.approval_id ? `approval=${r.refs.approval_id}` : "",
    now && r.kind !== "agent" && r.refs?.child_session ? `session=${r.refs.child_session}` : "",
  ].filter(Boolean);
  return ids.length ? `  [${ids.join(" ")}]` : "";
}

// How a row counts for the "failures" filter: it failed, or something in it did.
export const isFailure = (r: TimelineRow) => r.tone === "failed" || !!r.bad;
