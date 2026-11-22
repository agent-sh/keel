// A content-free join over existing trace spans and the event tree. Unlike a
// debug bundle, the receipt never returns event data or span attrs wholesale.
import type { Store } from "../core/store.ts";
import type { StoredEvent } from "../core/types.ts";
import { isNoSuchTool, isStopResult } from "../engine/turn.ts";
import { exitOf } from "./reason.ts";
import { traceIdOf, turnSpanId, type SpanStatus, type Tracer } from "./trace.ts";

const origins = new Set(["owner", "queued", "steer", "harness", "restart", "voice", "hook", "momentum",
  "wait", "subagent", "loop", "goal", "task", "parent", "peer", "failures", "wake"]);
const reasons = new Set(["end_turn", "error", "interrupted", "restart", "max_steps", "max_tokens",
  "refusal", "stop_sequence", "tool_use", "pause_turn", "model_context_window_exceeded"]);
const label = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "other";
const id = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
const purposes = new Set(["turn", "summary", "reader"]);
const input = (e: StoredEvent) => {
  const d = e.data;
  return { event_id: e.id, origin: label(d?.origin ?? d?.kind ?? "owner", origins), queue_id: id(d?.queue_id) };
};

// `name`: the tool the call named (from its span: a call that never ran has
// none). `exit`: the exit code a failed shell result names. `unknown`: the
// call named a tool the session does not have. So a failed call reads "Bash
// (exit 4)" or "Read", not "call 2".
type ToolReceipt = { result_event_id: string | null; span_id: string | null; status: SpanStatus; name: string | null; exit?: number; unknown?: true };
const toolName = (v: unknown) => (typeof v === "string" && v.length <= 120 ? v : null);
// An event's place in the tree, without its data.
type Node = { id: string; parent: string | null; kind: string; seq: number };
// Rows a read: most turns end within one.
const PAGE = 500;

export function turnReceipt(store: Store, tracer: Tracer, turnEvent: string) {
  const start = store.event(turnEvent);
  if (start?.kind !== "turn_start") return null;
  const sid = start.session_id;

  // The current head can be on another branch. Find the first end descended
  // from this start without crossing a newer turn, then walk that exact path.
  // Only the tree's shape is read, a page at a time from the turn's start: a
  // receipt neither parses the session nor reads past the turn's end.
  const page = store.db.query<Node, [string, number]>(`SELECT id, parent, kind, seq FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ${PAGE}`);
  const path = new Map<string, Node>([[start.id, start]]);
  for (let after = start.seq, ended = false; !ended;) {
    const rows = page.all(sid, after);
    for (const e of rows) {
      if (!e.parent || !path.has(e.parent)) continue;
      if (e.kind === "turn_start") {
        // A turn with no end of its own: the next turn's prompt, and the notes
        // before its start, hang from this one. They are that turn's.
        const prelude: string[] = [];
        let p = path.get(e.parent);
        for (; p && (p.kind === "note" || p.kind === "compaction"); p = p.parent ? path.get(p.parent) : undefined) prelude.push(p.id);
        if (p?.kind === "user") for (const gone of [...prelude, p.id]) path.delete(gone);
        continue;
      }
      path.set(e.id, e);
      if (e.kind === "turn_end") { ended = true; break; }
    }
    if (rows.length < PAGE) break;
    after = rows.at(-1)!.seq;
  }
  const tip = [...path.values()].at(-1)!;
  const ofTurn: StoredEvent[] = [];
  for (let n: Node | undefined = tip; n && n.id !== start.id; n = n.parent ? path.get(n.parent) : undefined) {
    // Only these kinds have something the receipt names.
    if (n.kind === "user" || n.kind === "tool_result" || n.kind === "turn_end") ofTurn.push(store.event(n.id)!);
  }
  ofTurn.reverse();
  const end = tip.kind === "turn_end" ? ofTurn.at(-1)! : null;

  // A prelude note is not a prompt. Do not reach into a prior turn for one.
  let opener = start.parent ? store.event(start.parent) : undefined;
  while (opener?.session_id === sid && (opener.kind === "note" || opener.kind === "compaction")) {
    opener = opener.parent ? store.event(opener.parent) : undefined;
  }
  const inputs = ofTurn.filter((e) => e.kind === "user").map(input);
  if (opener?.session_id === sid && opener.kind === "user") inputs.unshift(input(opener));

  const root = tracer.span(turnSpanId(traceIdOf(start.id)));
  const turn = root?.kind === "turn" && root.session_id === sid && root.attrs.turn_event === start.id ? root : undefined;
  // A subagent's first turn shares its parent's trace, not its receipt.
  const children = turn ? tracer.trace(turn.trace_id).filter((s) => s.parent_id === turn.span_id && s.session_id === sid && s.attrs.turn_event === start.id) : [];
  const requests = children.filter((s) => s.kind === "request" && !s.attrs.provider_wait).map((s) => ({
    span_id: s.span_id, purpose: label(s.attrs.shape?.purpose, purposes),
    attempt: typeof s.attrs.attempt === "number" ? s.attrs.attempt : null, status: s.status, error_id: s.error_id,
  }));
  const dispatched = new Map(children.filter((s) => s.kind === "tool").map((s) => [s.attrs.call_id, s]));
  const tools: ToolReceipt[] = [];
  for (const e of ofTurn) {
    if (e.kind !== "tool_result" || !Array.isArray(e.data?.results)) continue;
    for (const r of e.data.results) {
      const span = dispatched.get(r?.tool_use_id);
      dispatched.delete(r?.tool_use_id);
      // A call with no span that the turn's stop or a restart reached was stopped, not failed.
      const status = span?.status ?? (r?.is_error === true ? (isStopResult(r.content) ? "interrupted" : "error") : "ok");
      const exit = status === "error" ? exitOf(r?.content) : undefined;
      tools.push({ result_event_id: e.id, span_id: span?.span_id ?? null, status, name: toolName(span?.attrs.tool), ...(exit !== undefined ? { exit } : {}), ...(status === "error" && isNoSuchTool(r?.content) ? { unknown: true as const } : {}) });
    }
  }
  // Nested tools and parked calls can have a span but no result event.
  for (const span of dispatched.values()) tools.push({ result_event_id: null, span_id: span.span_id, status: span.status, name: toolName(span.attrs.tool) });
  return {
    session_id: sid, turn_event: start.id, start_ms: start.ts,
    trace_id: turn?.trace_id ?? null, span_id: turn?.span_id ?? null,
    inputs, requests, tools,
    end: end ? { event_id: end.id, reason: label(end.data?.reason, reasons), end_ms: end.ts, ...(typeof end.data?.provider_wait_ms === "number" ? { provider_wait_ms: end.data.provider_wait_ms, active_ms: end.data.ms } : {}) } : null,
  };
}
