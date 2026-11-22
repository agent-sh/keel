// Two turns of one session side by side, the slowest requests across
// sessions, and spend ranked by session or by agent tree: the questions
// "why was this turn dearer or slower than that one", "which request was
// slow" and "where did the money go" answered from the ledger
// (telemetry_calls, telemetry_tools, telemetry_turns). The SQL is here as
// text and the words as pure functions; the routes run the reads on the read
// thread (src/server/reads.ts). No imports, so the page can load this file
// for the words.

export type TurnZones = { tools: number; system: number; history: number; tail: number };
// One turn, as the ledger holds it. `n`: its place among the session's turns, from 1.
// `request_ms`, `tool_ms`: the time in model requests and in tool runs; `wait_ms`: the rest of the turn
// (approvals, questions, retries' waits, the daemon). `cache_ms`: how old the provider's cache was when
// it started (null: not known). `zones`: the prompt tokens of its requests by zone (null: not measured).
export type TurnFacts = {
  turn_event: string; n: number; ts: number; ms: number | null; outcome: string; reason: string; model: string | null;
  cost: number | null; requests: number; failed_attempts: number; tool_calls: number; tool_errors: number;
  input: number; output: number; cache_read: number; cache_write: number;
  zones: TurnZones | null; request_ms: number; tool_ms: number; wait_ms: number | null; ttft_ms: number | null;
  cache_ms: number | null; compacted: boolean; prompt: string;
};
export type TurnPick = Pick<TurnFacts, "turn_event" | "n" | "ts" | "ms" | "cost" | "requests" | "failed_attempts" | "outcome" | "prompt">;
export type SlowRequest = {
  id: number; session_id: string; title: string | null; ts: number; model: string; latency_ms: number; ttft_ms: number | null; outcome: string;
  error_class: string | null; turn_event: string | null; purpose: string; attempt: number | null; output: number;
};

// --- the reads (each is one statement; `?` in the order of the arguments named beside it)
const PROMPT = "(SELECT substr(COALESCE(json_extract(u.data, '$.text'), ''), 1, 140) FROM events u WHERE u.session_id = t.session_id AND u.kind = 'user' AND u.seq < e.seq ORDER BY u.seq DESC LIMIT 1)";
// (session_id, limit): the session's turns, newest first.
// A turn's place (`n`) is given by the caller from the session's count (COUNTS_SQL): the newest is the last.
export const TURNS_SQL = `SELECT t.turn_event, t.ts, t.ms, t.cost, t.requests, t.failed_attempts, t.outcome, ${PROMPT} AS prompt
  FROM telemetry_turns t JOIN events e ON e.id = t.turn_event WHERE t.session_id = ? ORDER BY t.ts DESC, t.id DESC LIMIT ?`;
// (session_id, session_id): the session's ledger in three counts: its turns, every request attempt it made
// (the turns' and the ones beside them), and the attempts that failed.
export const COUNTS_SQL = `SELECT (SELECT COUNT(*) FROM telemetry_turns WHERE session_id = ?) AS turns, COUNT(*) AS requests, COALESCE(SUM(outcome = 'error'), 0) AS failed FROM telemetry_calls WHERE session_id = ?`;
export type LedgerCounts = { turns: number; requests: number; failed: number };
// "1,468 requests, 25 of them failed attempts": what a session's panel says of its ledger.
export const requestsWords = (requests: number, failed: number) =>
  `${requests.toLocaleString("en-US")} request${requests === 1 ? "" : "s"}${failed ? `, ${failed.toLocaleString("en-US")} of them ${failed === 1 ? "a failed attempt" : "failed attempts"}` : ""}`;
// (turn_event): one turn with the sums of its requests and tool runs.
export const TURN_SQL = `SELECT t.turn_event, t.ts, t.ms, t.outcome, t.reason, t.model, t.cost, t.requests, t.failed_attempts, t.tool_calls, t.tool_errors,
  t.input, t.output, t.cache_read, t.cache_write, t.cache_ms, t.compacted_in_turn, t.compaction_event, ${PROMPT} AS prompt,
  (SELECT COUNT(*) FROM telemetry_turns o WHERE o.session_id = t.session_id AND (o.ts < t.ts OR (o.ts = t.ts AND o.id <= t.id))) AS n,
  c.z_tools, c.z_system, c.z_history, c.z_tail, c.measured, COALESCE(c.request_ms, 0) AS request_ms, c.ttft_ms,
  COALESCE((SELECT SUM(ms) FROM telemetry_tools x WHERE x.turn_event = t.turn_event), 0) AS tool_ms
  FROM telemetry_turns t JOIN events e ON e.id = t.turn_event
  LEFT JOIN (SELECT turn_event, SUM(z_tools) AS z_tools, SUM(z_system) AS z_system, SUM(z_history) AS z_history, SUM(z_tail) AS z_tail, COUNT(z_tools) AS measured,
    SUM(latency_ms) AS request_ms, MIN(CASE WHEN COALESCE(attempt, 1) = 1 THEN ttft_ms END) AS ttft_ms
    FROM telemetry_calls WHERE turn_event = ?1 AND COALESCE(purpose, 'turn') != 'side') c ON c.turn_event = t.turn_event
  WHERE t.turn_event = ?1`;
// (since, until, limit): the requests that took longest, across sessions.
export const SLOWEST_SQL = `SELECT c.id, c.session_id, s.title, c.ts, c.model, c.latency_ms, c.ttft_ms, c.outcome, c.error_class, c.turn_event, COALESCE(c.purpose, 'turn') AS purpose, c.attempt, c.output
  FROM telemetry_calls c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.ts >= ? AND c.ts < ? AND c.latency_ms IS NOT NULL ORDER BY c.latency_ms DESC, c.id DESC LIMIT ?`;

export function turnFacts(r: any): TurnFacts {
  const request_ms = Number(r.request_ms) || 0, tool_ms = Number(r.tool_ms) || 0;
  return {
    turn_event: r.turn_event, n: r.n, ts: r.ts, ms: r.ms ?? null, outcome: r.outcome, reason: r.reason, model: r.model ?? null,
    // A turn that made no request cost nothing (a turn cut before its first one).
    cost: r.cost ?? (r.requests === 0 ? 0 : null), requests: r.requests, failed_attempts: r.failed_attempts, tool_calls: r.tool_calls, tool_errors: r.tool_errors,
    input: r.input, output: r.output, cache_read: r.cache_read, cache_write: r.cache_write,
    zones: r.measured ? { tools: r.z_tools ?? 0, system: r.z_system ?? 0, history: r.z_history ?? 0, tail: r.z_tail ?? 0 } : null,
    request_ms, tool_ms, wait_ms: r.ms == null ? null : Math.max(0, r.ms - request_ms - tool_ms), ttft_ms: r.ttft_ms ?? null,
    cache_ms: r.cache_ms ?? null, compacted: !!r.compacted_in_turn || !!r.compaction_event, prompt: String(r.prompt ?? ""),
  };
}

// --- the words
const num = (n: number) => Math.round(n).toLocaleString("en-US");
export function span(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}
const usd = (c: number) => `$${Math.abs(c) > 0 && Math.abs(c) < 0.01 ? Math.abs(c).toFixed(4) : Math.abs(c).toFixed(2)}`;
export const promptTokens = (t: Pick<TurnFacts, "input" | "cache_read" | "cache_write">) => t.input + t.cache_read + t.cache_write;
export const cacheShare = (t: Pick<TurnFacts, "input" | "cache_read" | "cache_write">) => { const p = promptTokens(t); return p ? t.cache_read / p : null; };
const pct = (v: number | null) => (v === null ? "none" : `${Math.round(v * 100)}%`);

// Why turn `a` was dearer and slower (or cheaper and faster) than turn `b`:
// a sentence for the cost and one for the time, each naming the largest
// differences first, then what else differed. Facts only: no price is
// assumed, so a cost difference is explained by what was sent, cached and
// written, not by a sum per kind.
export function turnDiff(a: TurnFacts, b: TurnFacts): { cost: string; time: string; also: string[] } {
  const A = `Turn ${a.n}`, B = `turn ${b.n}`;
  // --- cost
  const parts: { d: number; text: string }[] = [];
  const more = (d: number, what: string) => { if (d) parts.push({ d: Math.abs(d), text: `${num(Math.abs(d))} ${d > 0 ? "more" : "fewer"} ${what}` }); };
  const dPrompt = promptTokens(a) - promptTokens(b);
  if (a.zones && b.zones) {
    const zones = (["history", "tail", "system", "tools"] as const).map((z) => ({ z, d: a.zones![z] - b.zones![z] })).filter((x) => x.d).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const named = zones.slice(0, 2).map((x) => `${x.z === "tail" ? "new messages" : x.z === "tools" ? "tool schemas" : x.z === "system" ? "system prompt" : "history"} ${x.d > 0 ? "+" : "-"}${num(Math.abs(x.d))}`);
    if (dPrompt) parts.push({ d: Math.abs(dPrompt), text: `${num(Math.abs(dPrompt))} ${dPrompt > 0 ? "more" : "fewer"} prompt tokens sent${named.length ? ` (${named.join(", ")})` : ""}` });
  } else more(dPrompt, "prompt tokens sent");
  more(a.input - b.input, "input tokens paid in full (not read from cache)");
  more(a.cache_write - b.cache_write, "tokens written to the cache");
  more(a.output - b.output, "output tokens");
  parts.sort((x, y) => y.d - x.d);
  const said = parts.slice(0, 3).map((p) => p.text);
  let cost: string;
  if (a.cost === null || b.cost === null) cost = `${A}'s cost against ${B}'s is not known (a request without a price)${said.length ? `; ${said.join(", ")}` : ""}.`;
  else if (Math.abs(a.cost - b.cost) < 0.00005) cost = `${A} cost the same as ${B} (${usd(a.cost)})${said.length ? `: ${said.join(", ")}` : ""}.`;
  else cost = `${A} cost ${usd(a.cost - b.cost)} ${a.cost > b.cost ? "more" : "less"} than ${B} (${usd(a.cost)} against ${usd(b.cost)})${said.length ? `: ${said.join(", ")}` : ""}.`;
  // --- time
  let time: string;
  if (a.ms === null || b.ms === null) time = `How long ${A} took against ${B} is not known.`;
  else {
    const d = a.ms - b.ms;
    const where = [
      { d: a.request_ms - b.request_ms, what: "in model requests" }, { d: a.tool_ms - b.tool_ms, what: "in tools" },
      { d: (a.wait_ms ?? 0) - (b.wait_ms ?? 0), what: "waiting (approvals, questions, retries, the daemon)" },
    ].filter((x) => Math.abs(x.d) >= 50).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).map((x) => `${span(Math.abs(x.d))} ${x.d > 0 ? "more" : "less"} ${x.what}`);
    time = Math.abs(d) < 50 ? `${A} took as long as ${B} (${span(a.ms)}).`
      : `${A} took ${span(Math.abs(d))} ${d > 0 ? "longer" : "less"} than ${B} (${span(a.ms)} against ${span(b.ms)})${where.length ? `: ${where.join(", ")}` : ""}.`;
  }
  // --- what else differed
  const also: string[] = [];
  const ca = cacheShare(a), cb = cacheShare(b);
  if (ca !== null && cb !== null && Math.abs(ca - cb) >= 0.05) also.push(`${A} read ${pct(ca)} of its prompt from the cache, ${B} ${pct(cb)}.`);
  if (a.requests !== b.requests || a.failed_attempts !== b.failed_attempts) {
    const side = (t: TurnFacts) => `${t.requests} request${t.requests === 1 ? "" : "s"}${t.failed_attempts ? `, ${t.failed_attempts} of them failed attempt${t.failed_attempts === 1 ? "" : "s"}` : ""}`;
    also.push(`${A} made ${side(a)}; ${B} ${side(b)}.`);
  }
  if (a.tool_calls !== b.tool_calls) also.push(`${A} ran ${a.tool_calls} tool call${a.tool_calls === 1 ? "" : "s"}${a.tool_errors ? ` (${a.tool_errors} failed)` : ""}; ${B} ${b.tool_calls}${b.tool_errors ? ` (${b.tool_errors} failed)` : ""}.`);
  if (a.compacted !== b.compacted) also.push(`${a.compacted ? A : `Turn ${b.n}`} ran with a compaction; the other did not.`);
  if (a.model !== b.model && a.model && b.model) also.push(`${A} ran on ${a.model.slice(a.model.indexOf(":") + 1)}; ${B} on ${b.model.slice(b.model.indexOf(":") + 1)}.`);
  if (a.outcome !== b.outcome) also.push(`${A} ended ${a.outcome}; ${B} ${b.outcome}.`);
  return { cost, time, also };
}

// --- spend ranked by agent tree
export type SpendRow = { key: string; priced_cost_usd: number; unpriced_calls: number; calls: number; total_tokens: number; first?: number };
export type TreeRow = SpendRow & { own_cost_usd: number; agents: number; agents_cost_usd: number };
// Each session's spend summed under the session at the top of its tree (an
// agent's parent, and that one's). A session whose parent is not known (it
// was removed) is its own top. Dearest first, then by tokens.
export function rankTrees(rows: SpendRow[], parentOf: (id: string) => string | null | undefined): TreeRow[] {
  const top = (id: string) => {
    const seen = new Set<string>();
    for (let at = id; ; ) {
      const p = parentOf(at);
      if (!p || seen.has(p)) return at;
      seen.add(at);
      at = p;
    }
  };
  const out = new Map<string, TreeRow>();
  for (const r of rows) {
    const root = top(r.key);
    const t = out.get(root) ?? out.set(root, { key: root, priced_cost_usd: 0, unpriced_calls: 0, calls: 0, total_tokens: 0, own_cost_usd: 0, agents: 0, agents_cost_usd: 0 }).get(root)!;
    t.priced_cost_usd += r.priced_cost_usd;
    t.unpriced_calls += r.unpriced_calls;
    t.calls += r.calls;
    t.total_tokens += r.total_tokens;
    if (r.key === root) t.own_cost_usd += r.priced_cost_usd;
    else { t.agents++; t.agents_cost_usd += r.priced_cost_usd; }
  }
  return [...out.values()].sort((a, b) => b.priced_cost_usd - a.priced_cost_usd || b.total_tokens - a.total_tokens);
}

// The ranked rows as text lines (keel usage): the cost, the requests, the name.
export function rankLines(rows: (SpendRow & Partial<TreeRow>)[], titleOf: (id: string) => string | undefined, max = 10): string[] {
  const shown = rows.slice(0, max);
  const out = shown.map((r, i) => {
    const cost = `${usd(r.priced_cost_usd)}${r.unpriced_calls ? "+" : ""}`;
    const agents = r.agents ? `, ${usd(r.agents_cost_usd ?? 0)} of it in ${r.agents} agent${r.agents === 1 ? "" : "s"}` : "";
    return `  ${String(i + 1).padStart(2)}. ${cost.padStart(9)}  ${String(r.calls).padStart(6)} ${r.calls === 1 ? "request " : "requests"}  ${(titleOf(r.key) ?? "a removed session").replace(/\s+/g, " ").slice(0, 60)}${agents}  [session=${r.key.slice(-12)}]`;
  });
  if (rows.length > shown.length) {
    const rest = rows.slice(max);
    out.push(`      ${rest.length} more: ${usd(rest.reduce((n, r) => n + r.priced_cost_usd, 0))} in all`);
  }
  return out;
}
