// The debug bundle: one Markdown page an agent (or the owner) reads to find
// why something failed. The failure, where it happened, the turn's trace with
// the failing request's shape and wire facts, the transcript around it, the
// daemon's log at the time, and where to look further. Keys, tokens and the
// home folder are redacted. Built for one error, or for a session's turn.
import { homedir } from "node:os";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import type { ErrorRecord, StoredEvent, TurnStatus } from "../core/types.ts";
import { redact } from "../server/routes/admin.ts";
import { logDir, logLines } from "./logs.ts";
import { type Span, traceIdOf, type Tracer } from "./trace.ts";

const LOG_WINDOW_MS = 2 * 60_000;
const LOG_LINES = 80;
const TAIL = 14;
const CLIP = 600;

const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}... (${s.length} chars)` : s);
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
const dur = (ms: number | null) => (ms === null ? "still running" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const fence = (s: string, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "` ` `") + "\n```";

export type BundleOpts = { error?: ErrorRecord; session_id?: string; turn_event?: string; daemon: Record<string, unknown>; version?: string; live?: (sessionId: string) => { running: boolean; status: TurnStatus } };

export function buildBundle(store: Store, tracer: Tracer, o: BundleOpts): { markdown: string; title: string; trace_id?: string } {
  const e = o.error;
  const sid = e?.session_id ?? o.session_id;
  const s = sid ? store.session(sid) : undefined;
  const events = s ? lineage(store.events(s.id), s.head) : [];
  // An error's turn is the one it names, or none (a side request ran in no
  // turn): the trace is then its span's own. Only a bundle asked for a session
  // alone is about that session's newest turn.
  const named = e?.span_id ? tracer.span(e.span_id) : undefined;
  const turnEvent = e?.turn_event ?? o.turn_event ?? (e ? undefined : events.findLast((x) => x.kind === "turn_start")?.id);
  const traceId = turnEvent ? traceIdOf(turnEvent) : named?.trace_id;
  const spans = traceId ? tracer.trace(traceId) : [];
  const failing = named ?? spans.findLast((x) => x.status === "error" && x.kind !== "turn");
  const at = e?.ts ?? failing?.end_ms ?? Date.now();
  const out: string[] = [];

  const title = e ? `${e.source}: ${clip(e.message, 120)}` : `turn in ${s?.title || sid}`;
  out.push(`# Keel debug bundle`, "");
  out.push(`Made ${iso(Date.now())}. Keel ${o.version ?? "dev"}, Bun ${Bun.version}, ${process.platform} ${process.arch}, daemon pid ${process.pid}, state ${o.daemon.state_dir}.`);
  out.push("Read top to bottom: the failure, where it happened, the trace of its turn, the transcript before it, then the daemon log around it. Secrets are redacted; text is clipped where marked.", "");

  if (e) {
    out.push("## Failure", "");
    out.push(`- Source: ${e.source}; error id \`${e.id}\``);
    out.push(`- Seen ${e.count ?? 1} time(s): first ${iso(e.first_ts ?? e.ts)}, last ${iso(e.ts)}${e.resolved_ts ? `, marked resolved ${iso(e.resolved_ts)}` : ""}`);
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
      out.push(`- Now: a turn is running; ${st.kind === "tool" ? `waiting on the tool${st.names.length > 1 ? "s" : ""} ${st.names.join(", ")} ${since(st.since)}` : st.kind === "model" ? `waiting on ${st.model} ${since(st.since)}${st.connected ? `, connected ${since(st.connected)} with no output yet` : ", not connected yet"}` : st.kind === "retry" ? `retry ${st.attempt} of ${st.max} at ${iso(st.at)} after: ${clip(st.message, 300)}` : st.kind === "compacting" ? "compacting the context" : "between steps"}`);
    }
    if (turnEvent) {
      const t = store.event(turnEvent);
      out.push(`- Turn \`${turnEvent}\` started ${t ? iso(t.ts) : "(event gone)"}; trace id \`${traceId}\``);
    } else if (e) out.push(`- In no turn${traceId ? `: a request of its own, trace id \`${traceId}\`` : ""}`);
  } else if (sid) out.push(`- Session \`${sid}\` (deleted since)`);
  else out.push("- Not tied to a session (a daemon or page failure).");
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
        : x.kind === "tool" ? [`call ${a.call_id}`, `${a.result_bytes} bytes out`] : [a.reason ? `ended: ${a.reason}` : ""];
      return `${mark} +${((x.start_ms - t0) / 1000).toFixed(2).padStart(7)}s ${indent}${x.name.padEnd(28)} ${dur(x.end_ms === null ? null : x.end_ms - x.start_ms).padStart(9)}  ${x.status}${x.error_type ? ` (${x.error_type})` : ""}  ${extra.filter(Boolean).join(", ")}  [span ${x.span_id}]`;
    });
    out.push(fence(lines.join("\n")), "");
  }

  if (failing) out.push(...failingSection(failing));

  if (events.length) {
    out.push(`## Transcript before the failure (last ${TAIL} events of the branch)`, "");
    const upto = events.filter((x) => x.ts <= at + 1000);
    for (const ev of upto.slice(-TAIL)) out.push(...eventLines(ev));
    out.push("");
  }

  const logs = logLines({ since: at - LOG_WINDOW_MS, until: at + 30_000 }).slice(-LOG_LINES);
  out.push(`## Daemon log around it (${iso(at - LOG_WINDOW_MS)} to ${iso(at + 30_000)}, ${logs.length} lines)`, "");
  out.push(logs.length ? fence(logs.map((l) => `${new Date(l.ts).toISOString().slice(11, 23)} ${l.level.toUpperCase().padEnd(5)} ${clip(l.text, 800)}`).join("\n")) : "No lines in that window (the memory log keeps the last 2000; older ones are in the files below).", "");

  const others = store.errors(20, { resolved: false }).filter((x) => x.id !== e?.id).slice(0, 6);
  if (others.length) {
    out.push("## Other open errors", "");
    for (const x of others) out.push(`- ${x.source}, ${x.count ?? 1}x, last ${iso(x.ts)}: ${clip(x.message.split("\n")[0]!, 200)} (\`${x.id}\`)`);
    out.push("");
  }

  out.push("## Looking further", "");
  out.push(`- Daemon log files: ${logDir() ?? "(not installed)"} (one per day, \`keel-YYYY-MM-DD.log\`)`);
  out.push(`- Database: ${o.daemon.state_dir}/keel.db (SQLite). Tables: \`errors\`, \`spans\` (trace_id, kind, attrs JSON), \`events\` (session_id, kind, data JSON), \`telemetry_calls\`.`);
  if (traceId) out.push(`- This trace as JSON: \`GET /api/debug/traces/${traceId}\``);
  if (failing?.replayable) out.push(`- Send the failed request again: \`POST /api/debug/spans/${failing.span_id}/replay\` with \`{"route": "provider:model"}\` to try another model`);
  if (s) out.push(`- The full session: \`GET /api/sessions/${s.id}/events\``);
  out.push("- Keel's source is a Bun and TypeScript daemon: provider HTTP in `src/providers/http.ts`, the turn loop in `src/engine/turn.ts`, error capture in `src/core/errors.ts`, routes in `src/server/routes/`, the UI in `ui/src/`.");

  const md = String(redact(out.join("\n"))).split(homedir()).join("~");
  return { markdown: md + "\n", title, trace_id: traceId };
}

function failingSection(f: Span): string[] {
  const a = f.attrs;
  const out = ["## The failing span", ""];
  out.push(`- \`${f.name}\` (${f.kind}), ${f.status}${f.error_type ? `, class ${f.error_type}` : ""}, ${dur(f.end_ms === null ? null : f.end_ms - f.start_ms)}; span \`${f.span_id}\``);
  if (f.error) out.push("", fence(clip(f.error, 3000)));
  if (a.shape) {
    const sh = a.shape;
    out.push("", `Request shape: ${sh.purpose}; system ${sh.system_chars} chars; ${sh.messages} messages (${Object.entries(sh.roles).map(([k, v]) => `${k} ${v}`).join(", ")}); blocks ${Object.entries(sh.blocks).map(([k, v]) => `${k} ${v}`).join(", ")}; ${sh.message_bytes} bytes of messages; ${sh.tools} tools; effort ${sh.effort ?? "default"}; max tokens ${sh.max_tokens ?? "default"}${sh.last_message ? `; last message ${sh.last_message.role} [${sh.last_message.blocks.join(", ")}]` : ""}.`);
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
  const t = new Date(ev.ts).toISOString().slice(11, 19);
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
