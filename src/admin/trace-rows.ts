// A turn's trace as a person reads it: what each span is called, and the time
// of the turn that no span covers, said as what it most likely was. Pure, and
// free of the daemon's modules, so the page loads this file too.
export type SpanLite = {
  span_id: string; parent_id: string | null; kind: string; name: string; start_ms: number; end_ms: number | null;
  attrs: Record<string, any>;
};

// "retry wait" -> "Retry wait", with what it waited for when the span says.
export function waitLabel(s: SpanLite): string {
  const name = s.name.charAt(0).toUpperCase() + s.name.slice(1);
  const a = s.attrs;
  if (s.name === "approval wait" && a.tool) return `${name} for ${a.tool}`;
  if (s.name === "retry wait" && a.attempt) return `${name} before attempt ${a.attempt + 1}`;
  if (s.name === "daemon stall") return "Daemon unresponsive";
  if (s.name === "hook") return `Hook ${a.event ?? ""}: ${String(a.hook ?? "").slice(0, 80)}`.replace(/ : /, ": ");
  if (s.name === "slot wait") return "Heavy-command slot wait";
  return name;
}

// A gap worth a row: a quarter of a second, where a person starts to see it.
export const GAP_MS = 250;
export type Gap = { after: string | null; start_ms: number; end_ms: number; label: string };

const toolOf = (s: SpanLite) => String(s.attrs.tool ?? s.name.replace(/^execute_tool /, ""));

// The stretches of a turn between its direct spans (requests, tools, waits)
// that are GAP_MS or longer, oldest first. `after`: the span the gap follows
// (null: the turn's start). What a gap was is read off its neighbours: hooks
// and checks run before and after a tool, and the rest is the daemon's own
// work on the turn (its prompt and tools, the next request being built).
export function turnGaps(spans: SpanLite[], turnSpan: string, now = Date.now()): Gap[] {
  const turn = spans.find((s) => s.span_id === turnSpan);
  if (!turn) return [];
  const kids = spans.filter((s) => s.parent_id === turnSpan).sort((a, b) => a.start_ms - b.start_ms);
  const end = turn.end_ms ?? now;
  const out: Gap[] = [];
  let at = turn.start_ms;
  let prev: SpanLite | null = null;
  const gap = (to: number, next: SpanLite | null) => {
    if (to - at < GAP_MS) return;
    const label = next?.kind === "tool" ? `Before ${toolOf(next)}: hooks and checks`
      : prev?.kind === "tool" ? `After ${toolOf(prev)}: hooks, then ${next || turn.end_ms === null ? "the next request" : "the turn's end"}`
      : !prev ? "Starting the turn: its prompt, system and tools"
      : !next ? (turn.end_ms === null ? "Since then: the next step is being prepared" : "Ending the turn: hooks and what its end sets off")
      : "Between steps: the daemon's own work";
    out.push({ after: prev?.span_id ?? null, start_ms: at, end_ms: to, label });
  };
  for (const k of kids) {
    // A wait from before the turn began (its prompt in the queue) is not inside it.
    if ((k.end_ms ?? now) <= turn.start_ms) continue;
    gap(k.start_ms, k);
    at = Math.max(at, k.end_ms ?? now);
    prev = k;
  }
  if (turn.end_ms !== null || kids.every((k) => k.end_ms !== null)) gap(end, null);
  return out;
}

// Where a turn's time went, by kind: requests, tools, waits, and the rest
// (the gaps, long and short). Spans that overlap (tools run side by side) are
// counted once, to the kind that started first; a wait inside another span
// (a tool call held for a heavy-command slot) is the wait's.
export function turnAccount(spans: SpanLite[], turnSpan: string, now = Date.now()): { total: number; request: number; tool: number; wait: number; other: number } {
  const turn = spans.find((s) => s.span_id === turnSpan);
  const acc = { total: 0, request: 0, tool: 0, wait: 0, other: 0 };
  if (!turn) return acc;
  const end = turn.end_ms ?? now;
  acc.total = Math.max(0, end - turn.start_ms);
  const kids = spans.filter((s) => s.parent_id === turnSpan).map((k) => ({
    from: Math.max(turn.start_ms, k.start_ms), to: Math.min(end, k.end_ms ?? now),
    kind: (k.kind === "request" || k.kind === "tool" || k.kind === "wait" ? k.kind : "other") as "request" | "tool" | "wait" | "other",
    start: k.start_ms,
  })).filter((k) => k.to > k.from);
  const marks = [...new Set(kids.flatMap((k) => [k.from, k.to]))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i]!, b = marks[i + 1]!;
    const on = kids.filter((k) => k.from <= a && k.to >= b);
    if (!on.length) continue;
    const k = on.find((x) => x.kind === "wait") ?? on.reduce((x, y) => (y.start < x.start ? y : x));
    acc[k.kind] += b - a;
  }
  acc.other = Math.max(0, acc.total - acc.request - acc.tool - acc.wait);
  return acc;
}
