// A content-free join over existing trace spans and the event tree. Unlike a
// debug bundle, the receipt never returns event data or span attrs wholesale.
import type { Store } from "../core/store.ts";
import type { StoredEvent } from "../core/types.ts";
import { traceIdOf, turnSpanId, type SpanStatus, type Tracer } from "./trace.ts";

const origins = new Set(["owner", "queued", "steer", "harness", "restart", "voice", "hook", "momentum",
  "wait", "subagent", "loop", "goal", "task", "parent", "peer"]);
const reasons = new Set(["end_turn", "error", "interrupted", "restart", "max_steps", "max_tokens",
  "refusal", "stop_sequence", "tool_use", "pause_turn", "model_context_window_exceeded"]);
const label = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "other";
const id = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
const input = (e: StoredEvent) => {
  const d = e.data;
  return { event_id: e.id, origin: label(d?.origin ?? d?.kind ?? "owner", origins), queue_id: id(d?.queue_id) };
};

type ToolReceipt = { result_event_id: string | null; span_id: string | null; status: SpanStatus };

export function turnReceipt(store: Store, tracer: Tracer, turnEvent: string) {
  const start = store.event(turnEvent);
  if (start?.kind !== "turn_start") return null;
  const sid = start.session_id;

  // The current head can be on another branch. Find the first end descended
  // from this start without crossing a newer turn, then walk that exact path.
  const path = new Map([[start.id, start]]);
  let tip = start;
  for (const e of store.events(sid, start.seq)) {
    if (!e.parent || !path.has(e.parent) || e.kind === "turn_start") continue;
    path.set(e.id, e);
    tip = e;
    if (e.kind === "turn_end") break;
  }
  const inside: StoredEvent[] = [];
  for (let e: StoredEvent | undefined = tip; e && e !== start; e = e.parent ? path.get(e.parent) : undefined) inside.push(e);
  inside.reverse();

  // A prelude note is not a prompt. Do not reach into a prior turn for one.
  let opener = start.parent ? store.event(start.parent) : undefined;
  while (opener?.session_id === sid && (opener.kind === "note" || opener.kind === "compaction")) {
    opener = opener.parent ? store.event(opener.parent) : undefined;
  }
  const inputs = inside.filter((e) => e.kind === "user").map(input);
  if (opener?.session_id === sid && opener.kind === "user") inputs.unshift(input(opener));

  const root = tracer.span(turnSpanId(traceIdOf(start.id)));
  const turn = root?.kind === "turn" && root.session_id === sid && root.attrs.turn_event === start.id ? root : undefined;
  // A subagent's first turn shares its parent's trace, not its receipt.
  const children = turn ? tracer.trace(turn.trace_id).filter((s) => s.parent_id === turn.span_id && s.session_id === sid && s.attrs.turn_event === start.id) : [];
  const requests = children.filter((s) => s.kind === "request").map((s) => ({
    span_id: s.span_id, attempt: typeof s.attrs.attempt === "number" ? s.attrs.attempt : null, status: s.status, error_id: s.error_id,
  }));
  const dispatched = new Map(children.filter((s) => s.kind === "tool").map((s) => [s.attrs.call_id, s]));
  const tools: ToolReceipt[] = [];
  for (const e of inside) {
    if (e.kind !== "tool_result" || !Array.isArray(e.data?.results)) continue;
    for (const r of e.data.results) {
      const span = dispatched.get(r?.tool_use_id);
      dispatched.delete(r?.tool_use_id);
      tools.push({ result_event_id: e.id, span_id: span?.span_id ?? null, status: span?.status ?? (r?.is_error === true ? "error" : "ok") });
    }
  }
  // Nested tools and parked calls can have a span but no result event.
  for (const span of dispatched.values()) tools.push({ result_event_id: null, span_id: span.span_id, status: span.status });
  return {
    session_id: sid, turn_event: start.id, start_ms: start.ts,
    trace_id: turn?.trace_id ?? null, span_id: turn?.span_id ?? null,
    inputs, requests, tools,
    end: tip.kind === "turn_end" ? { event_id: tip.id, reason: label(tip.data?.reason, reasons), end_ms: tip.ts } : null,
  };
}
