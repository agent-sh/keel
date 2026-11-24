// The debug bundle: one Markdown page an agent (or the owner) reads to find
// why something failed. The failure, where it happened, the turn's trace with
// the failing request's shape and wire facts, the transcript around it, the
// daemon's log at the time, and where to look further. Keys, tokens and the
// home folder are redacted. Built for one error, or for a session's turn.
import { homedir } from "node:os";
import { zoned, zoneNote } from "../core/clock.ts";
import type { Store } from "../core/store.ts";
import { leafOf, lineage } from "../core/tree.ts";
import { attemptWords } from "../core/state-words.ts";
import type { ErrorRecord, StoredEvent, TurnStatus } from "../core/types.ts";
import { redact } from "../server/routes/admin.ts";
import { logDir, type LogLine, logLines } from "./logs.ts";
import { type Span, SPAN_DAYS, traceIdOf, type Tracer } from "./trace.ts";

const LOG_WINDOW_MS = 2 * 60_000;
const LOG_LINES = 80;
const TAIL = 14;
const CLIP = 600;

const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s);
// Every time in a bundle is the machine's own zone (the one alerts and the
// page use); the first line says which. The log files it points at are in UTC.
// A time on the other side of a clock change says its own offset (clock.ts).
const Z = () => zoned();
const iso = (ts: number) => Z().stamp(ts);
const dur = (ms: number | null) => (ms === null ? "still running" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const fence = (s: string, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "` ` `") + "\n```";

// `own`: the bundle is read by a session about itself or an agent it started (the timeline tool), not by
// the owner: it holds that session only. No other session's open errors, no daemon log line that
// does not name the session, no path of the daemon's, and no way to send a request again.
export type BundleOpts = { error?: ErrorRecord; session_id?: string; turn_event?: string; span_id?: string; daemon: Record<string, unknown>; version?: string; own?: boolean; live?: (sessionId: string) => { running: boolean; status: TurnStatus } };

// The log lines a bundle shows. The owner's holds every line of the window. A
// session's own (`own`) holds the lines written in its turns, and the
// daemon's own lines (written in no session's turn) that name it; a line
// written in another session's turn is never in it, whatever it names.
export function logFor(lines: LogLine[], sid: string | undefined, own: boolean): LogLine[] {
  return own ? lines.filter((l) => !!sid && (l.session ? l.session === sid : l.text.includes(sid))) : lines;
}

export function buildBundle(store: Store, tracer: Tracer, o: BundleOpts): { markdown: string; title: string; trace_id?: string } {
  const e = o.error;
  // The span the bundle was asked from (the one picked in a trace): the bundle
  // is about that span, its turn and the branch that turn ran on.
  const asked = o.span_id ? tracer.span(o.span_id) : undefined;
  // What was asked for wins over where the row last happened: a bundle asked
  // from a span of an earlier turn is about that turn, in that session.
  const sid = o.session_id ?? asked?.session_id ?? e?.session_id;
  const s = sid ? store.session(sid) : undefined;
  const all = s ? store.events(s.id) : [];
  // The row's last occurrence, when it was in this session. Its turn is the one
  // it names, or none (a side request ran in no turn): the trace is then its
  // span's own. Only a bundle asked for a session alone is about that
  // session's newest turn.
  const last = e && e.session_id === sid && !o.span_id ? e : undefined;
  const named = asked ?? (last?.span_id ? tracer.span(last.span_id) : undefined);
  // A span that was asked for, or that the row names, and is no longer kept:
  // said as it is, with no other span shown in its place.
  const spanGone = o.span_id && !asked ? o.span_id : last?.span_id && !named ? last.span_id : undefined;
  const head = s ? lineage(all, s.head) : [];
  const turnEvent = (asked ? (asked.attrs.turn_event as string | undefined) : o.turn_event ?? last?.turn_event) ?? (e || o.span_id ? undefined : head.findLast((x) => x.kind === "turn_start")?.id);
  const traceId = asked?.trace_id ?? (turnEvent ? traceIdOf(turnEvent) : named?.trace_id);
  const spans = traceId ? tracer.trace(traceId) : [];
  // One trace a bundle: the span the row names is its failing span only when it
  // is in the trace shown. A row that moved on since leaves that trace's own failure.
  const own = named && (!spans.length || spans.some((x) => x.span_id === named.span_id)) ? named : undefined;
  // A turn's span has no request of its own: its failure is its last failed child's.
  const failing = asked
    ? asked.kind === "turn" ? spans.findLast((x) => x.parent_id === asked.span_id && x.status === "error") ?? asked : asked
    : spanGone ? undefined : own ?? spans.findLast((x) => x.status === "error" && x.kind !== "turn");
  const elsewhere = !!e && !asked && (!last || (!!named && !own));
  // The transcript is the branch the turn ran on. A session that went back and
  // took another branch since still has it; the present branch is another
  // conversation and is never shown in its place.
  const turnAt = turnEvent ? all.find((x) => x.id === turnEvent) : undefined;
  const left = !!turnAt && !head.some((x) => x.id === turnEvent);
  const turnGone = !!s && !!turnEvent && !turnAt;
  const events = left ? lineage(all, leafOf(all, turnEvent!)) : turnGone ? [] : head;
  // The moment the bundle is about. A span that is gone leaves its turn's end
  // on that branch (the error row may have happened again later, elsewhere).
  const turnEnd = turnAt ? events.slice(events.findIndex((x) => x.id === turnEvent) + 1).find((x) => x.kind === "turn_end") : undefined;
  const at = asked ? failing?.end_ms ?? asked.end_ms ?? Date.now()
    : spanGone && turnAt ? turnEnd?.ts ?? Date.now()
    : (elsewhere ? failing?.end_ms : undefined) ?? e?.ts ?? failing?.end_ms ?? Date.now();
  const out: string[] = [];

  const title = e ? `${e.source}: ${clip(e.message, 120)}` : `turn in ${s?.title || sid}`;
  out.push(`# Keel debug bundle`, "");
  if (o.own) out.push(`Made ${iso(Date.now())}. ${zoneNote()}.`, "Read top to bottom: the failure, where it happened, the trace of its turn, then the transcript before it. Secrets are redacted; text is clipped where marked.", "");
  else {
    out.push(`Made ${iso(Date.now())}. ${zoneNote()}. Keel ${o.version ?? "dev"}, Bun ${Bun.version}, ${process.platform} ${process.arch}, daemon pid ${process.pid}, state ${o.daemon.state_dir}.`);
    out.push("Read top to bottom: the failure, where it happened, the trace of its turn, the transcript before it, then the daemon log around it. Secrets are redacted; text is clipped where marked.", "");
  }

  if (e) {
    out.push("## Failure", "");
    out.push(`- Source: ${e.source}; error id \`${e.id}\``);
    // The kind's own count and times; then this session's, when the kind happened elsewhere too.
    const n = e.count ?? 1;
    out.push(`- Seen ${n} ${n === 1 ? "time" : "times"} in all: first ${iso(e.first_ts ?? e.ts)}, last ${iso(e.kind_ts ?? e.ts)}${e.resolved_ts ? `, marked resolved ${iso(e.resolved_ts)}` : ""}`);
    const here = e.sites?.find((x) => x.session_id === sid);
    if (here && here.count < n) out.push(`- In this session: ${here.count} ${here.count === 1 ? "time" : "times"}, last ${iso(here.ts)}`);
    // Every session the kind happened in, each with its own count: the bundle is of one of them.
    // A session's own bundle names no other session.
    if (e.recovered_ts) out.push(`- Recovered: each time, a retry of the request passed (last ${iso(e.recovered_ts)}).`);
    if (!o.own && (e.sites?.length ?? 0) > 1) {
      out.push(`- Happened in ${e.sites!.length} sessions; this bundle is of ${s ? `"${s.title || s.id}"` : "the last one"}:`);
      for (const x of e.sites!.slice(0, 12)) out.push(`  - ${x.count}x in "${x.title || x.session_id}" (\`${x.session_id}\`), last ${iso(x.ts)}${x.healed >= x.count ? ", healed by a retry" : x.healed ? `, ${x.healed} healed by a retry` : ""}`);
      if (e.sites!.length > 12) out.push(`  - and ${e.sites!.length - 12} more sessions`);
    }
    out.push("", fence(clip(e.message, 4000)));
    if (e.context) out.push("", "Context when captured:", "", fence(clip(JSON.stringify(e.context, null, 2), 3000), "json"));
    if (e.stack) out.push("", "Stack:", "", fence(e.stack.split("\n").slice(0, 40).join("\n")));
    out.push("");
  }

  out.push("## Where", "");
  if (s) {
    out.push(`- Session \`${s.id}\` "${s.title}"; model \`${s.model}\`; folder ${s.workspace}; phase ${s.phase}${s.parent_id ? `; a subagent of \`${s.parent_id}\`` : ""}`);
    const now = o.live?.(s.id);
    if (now?.running) {
      const st = now.status;
      const since = (t: number) => `for ${dur(Date.now() - t)}`;
      out.push(`- Now: a turn is running; ${st.kind === "tool" ? `waiting on the tool${st.names.length > 1 ? "s" : ""} ${st.names.join(", ")} ${since(st.since)}` : st.kind === "model" && st.quiet ? `${st.model} is answering, no output ${since(st.quiet)}` : st.kind === "model" ? `waiting on ${st.model} ${since(st.since)}${st.connected ? `, connected ${since(st.connected)} with no output yet` : ", not connected yet"}` : st.kind === "retry" && st.unreachable ? `waiting for a provider that cannot be reached since ${iso(st.unreachable)} (${st.message})` : st.kind === "retry" ? `${attemptWords(st.attempt, st.max, "retry")} at ${iso(st.at)} after: ${clip(st.message, 300)}` : st.kind === "compacting" ? "compacting the context" : "between steps"}`);
    }
    if (turnEvent) {
      out.push(`- Turn \`${turnEvent}\` started ${turnAt ? iso(turnAt.ts) : "(event gone)"}; trace id \`${traceId}\``);
      if (left) out.push("- The session went back and took another branch since: this turn is on the branch it left, and the transcript below is that branch's.");
      if (turnGone) out.push("- The turn's events are no longer in the session. No transcript is shown: the session's present branch is another conversation.");
    } else if (e) out.push(`- In no turn${traceId ? `: a request of its own, trace id \`${traceId}\`` : ""}`);
  } else if (sid) out.push(`- Session \`${sid}\` (deleted since)`);
  else out.push("- Not tied to a session (a daemon or page failure).");
  if (asked) out.push(`- Asked from the span \`${asked.span_id}\` (\`${asked.name}\`, ${asked.status}).`);
  if (spanGone) out.push(`- The span ${o.span_id ? "this bundle was asked from" : "this error names"}, \`${spanGone}\`, is no longer kept (spans are kept ${SPAN_DAYS} days). No other span is shown in its place.`);
  if (e?.context?.url) out.push(`- Page: ${e.context.url}`);
  out.push("");

  if (spans.length) {
    out.push(turnEvent ? "## Trace of the turn" : "## Trace of the request", "");
    out.push(`Offsets from the ${turnEvent ? "turn" : "request"}'s start; \`!\` marks a failed span.`, "");
    const t0 = spans[0]!.start_ms;
    const lines = spans.map((x) => {
      const mark = x.status === "error" ? "!" : x.status === "running" ? "~" : " ";
      const indent = x.parent_id ? "  " : "";
      const a = x.attrs;
      const extra = x.kind === "request"
        ? [a.route, `attempt ${a.attempt}`, a.ttft_ms !== undefined ? `first token ${dur(a.ttft_ms)}` : "", a.wire?.status ? `HTTP ${a.wire.status}` : "", a.result ? `${a.result.stop}, in ${a.result.usage?.input ?? 0}+${a.result.usage?.cache_read ?? 0} cached, out ${a.result.usage?.output ?? 0}` : ""]
        : x.kind === "tool" ? [`call ${a.call_id}`, `${a.result_bytes} bytes out`]
        // A wait: what the turn waited on (a retry's wait, an approval card, a compaction, the queue).
        : x.kind === "wait" ? [a.tool ? `for ${a.tool}` : "", a.answer ? `answer: ${a.answer}` : "", a.attempt ? `retry ${a.attempt} of ${a.max}` : ""]
        : [a.reason ? `ended: ${a.reason}` : ""];
      return `${mark} +${((x.start_ms - t0) / 1000).toFixed(2).padStart(7)}s ${indent}${x.name.padEnd(28)} ${dur(x.end_ms === null ? null : x.end_ms - x.start_ms).padStart(9)}  ${x.status}${x.error_type ? ` (${x.error_type})` : ""}  ${extra.filter(Boolean).join(", ")}  [span ${x.span_id}]`;
    });
    out.push(fence(lines.join("\n")), "");
  }

  if (failing) out.push(...failingSection(failing));

  if (events.length) {
    out.push(`## Transcript before the failure (last ${TAIL} events of the branch${left ? " the turn ran on" : ""})`, "");
    const upto = events.filter((x) => x.ts <= at + 1000);
    for (const ev of upto.slice(-TAIL)) out.push(...eventLines(ev));
    out.push("");
  }

  // The daemon's log is every session's: a session reading about itself gets
  // the lines written in its own turns, and the daemon's own lines that name
  // it; never a line written in another session's turn.
  const logs = logFor(logLines({ since: at - LOG_WINDOW_MS, until: at + 30_000 }), sid, !!o.own).slice(-LOG_LINES);
  if (!o.own || logs.length) {
    out.push(`## Daemon log around it (${iso(at - LOG_WINDOW_MS)} to ${iso(at + 30_000)}, ${logs.length} lines)`, "");
    // Whose line it is: this turn's, this session's, another session's, or the daemon's own (nothing said).
    const whose = (l: { session?: string; turn?: string }) => (!l.session ? "" : l.session !== sid ? `(session ${l.session}) ` : turnEvent && l.turn === turnEvent ? "(this turn) " : "(this session) ");
    out.push(logs.length ? fence(logs.map((l) => `${Z().time(l.ts, true)} ${l.level.toUpperCase().padEnd(5)} ${whose(l)}${clip(l.text, 800)}`).join("\n")) : "No lines in that window.", "");
  }

  // Where to look further is the daemon's own words and ids, added after the
  // redaction: a route with a trace id in it is a long run of letters, digits
  // and slashes, which reads as a key and was blanked ("GET /[redacted]").
  // A session reading about itself gets none of it: no other session's
  // errors, no path of the daemon's, no way to send a request again.
  const more: string[] = [];
  if (!o.own) {
    const others = store.errors(20, { resolved: false }).filter((x) => x.id !== e?.id).slice(0, 6);
    if (others.length) {
      out.push("## Other open errors", "");
      for (const x of others) out.push(`- ${x.source}, ${x.count ?? 1}x, last ${iso(x.ts)}: ${clip(x.message.split("\n")[0]!, 200)} (\`${x.id}\`)`);
      out.push("");
    }

    more.push("## Looking further", "");
    more.push(`- Daemon log files: ${logDir() ?? "(not installed)"} (one per UTC day, \`keel-YYYY-MM-DD.log\`; their times are UTC, with a Z)`);
    more.push(`- Database: ${o.daemon.state_dir}/keel.db (SQLite). Tables: \`errors\`, \`spans\` (trace_id, kind, attrs JSON), \`events\` (session_id, kind, data JSON), \`telemetry_calls\`.`);
    if (traceId) more.push(`- This trace as JSON: \`GET /api/debug/traces/${traceId}\``);
    if (failing?.replayable) more.push(`- Send the failed request again: \`POST /api/debug/spans/${failing.span_id}/replay\` with \`{"route": "provider:model"}\` to try another model`);
    if (s) more.push(`- The full session: \`GET /api/sessions/${s.id}/events\``);
    more.push("- Keel's source is a Bun and TypeScript daemon: provider HTTP in `src/providers/http.ts`, the turn loop in `src/engine/turn.ts`, error capture in `src/core/errors.ts`, routes in `src/server/routes/`, the UI in `ui/src/`.");
  }

  const md = `${String(redact(out.join("\n")))}${more.length ? `\n${more.join("\n")}` : ""}`.split(homedir()).join("~");
  return { markdown: md + "\n", title, trace_id: traceId };
}

function failingSection(f: Span): string[] {
  const a = f.attrs;
  const out = [f.status === "error" ? "## The failing span" : "## The span", ""];
  out.push(`- \`${f.name}\` (${f.kind}), ${f.status}${f.error_type ? `, class ${f.error_type}` : ""}, ${dur(f.end_ms === null ? null : f.end_ms - f.start_ms)}; span \`${f.span_id}\``);
  if (f.error) out.push("", fence(clip(f.error, 3000)));
  if (a.shape) {
    const sh = a.shape;
    out.push("", `Request shape: ${sh.purpose}; system ${sh.system_chars} chars; ${sh.messages} messages; blocks ${Object.entries(sh.blocks ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}; ${sh.message_bytes} bytes of messages; ${sh.tools} tools; effort ${sh.effort ?? "default"}; max tokens ${sh.max_tokens ?? "default"}.`);
  }
  if (a.wire) {
    const w = a.wire;
    out.push("", `Wire: ${w.method ?? ""} ${w.url ?? "(no HTTP: the driver speaks another transport)"} -> ${w.status ?? "no answer"}${w.headers_ms !== undefined ? ` after ${w.headers_ms} ms` : ""}; provider request id ${w.request_id ? `\`${w.request_id}\`` : "none"}; ${w.body_bytes ?? "?"} bytes sent, ${w.bytes_in ?? 0} received in ${w.events ?? 0} events${w.last_event ? `, the last \`${w.last_event}\`` : ""}${w.resent_after_auth ? "; resent after a renewed sign-in" : ""}.`);
    if (w.res_headers && Object.keys(w.res_headers).length) out.push("", "Answer headers:", "", fence(JSON.stringify(w.res_headers, null, 2), "json"));
    if (w.req_headers) out.push("", "Request headers (credentials shown by length only):", "", fence(JSON.stringify(w.req_headers, null, 2), "json"));
    if (w.error_body) out.push("", "Answer body:", "", fence(w.error_body));
  } else if (f.kind === "request") out.push("", "Wire: no HTTP record (a scripted, plugin or WebSocket driver, or the call failed before it was sent).");
  if (a.input_keys) out.push("", `Tool input keys: ${a.input_keys.join(", ") || "none"}; ${a.input_bytes} bytes in, ${a.result_bytes} out.`);
  out.push("");
  return out;
}

function eventLines(ev: StoredEvent): string[] {
  const d = ev.data ?? {};
  const t = Z().time(ev.ts);
  switch (ev.kind) {
    case "user": return [`- ${t} **user**${d.origin ? ` (${d.origin})` : ""}: ${clip(String(d.text ?? ""))}`];
    case "assistant": {
      const parts = (d.blocks ?? []).map((b: any) => (b.type === "text" ? clip(b.text ?? "") : b.type === "tool_use" ? `[${b.name} ${clip(JSON.stringify(b.input ?? {}), 400)}] (call ${b.id})` : b.type === "thinking" ? "[thinking]" : `[${b.type}]`));
      return [`- ${t} **assistant** (${d.model ?? "?"}, stop ${d.stop ?? "?"}): ${parts.join(" ")}`];
    }
    case "tool_result":
      return (d.results ?? []).map((r: any) => `- ${t} **tool result**${r.is_error ? " (error)" : ""} for ${r.tool_use_id}: ${clip(typeof r.content === "string" ? r.content : JSON.stringify(r.content), 500)}`);
    case "error": return [`- ${t} **error**: ${clip(String(d.message ?? ""))}${d.error_id ? ` (error id \`${d.error_id}\`)` : ""}`];
    case "turn_start": return [`- ${t} turn starts on ${d.model}`];
    case "turn_end": return [`- ${t} turn ends: ${d.reason}${d.ms ? ` after ${dur(d.ms)}` : ""}`];
    case "note": return [`- ${t} note: ${clip(String(d.text ?? ""), 300)}`];
    case "compaction": return [`- ${t} compaction (${d.mode})`];
    default: return [`- ${t} ${ev.kind}`];
  }
}
