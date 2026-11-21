// keel debug: what an agent (or the owner) asked to fix a failure reads from
// a terminal.
//   keel debug [ERROR_ID]            the debug bundle (Markdown) of an error, the newest open one by default
//   keel debug --session ID [--turn EVENT]   the bundle of a session's turn (its last by default)
//   keel debug errors [--all]        the open errors (every one with --all), newest first
//   keel debug trace TRACE_ID        one trace's spans as a waterfall
//   keel debug timeline SESSION      what happened in a session and what it is doing now, a line a row
//   SESSION is a session's id, a prefix of it, or an agent's id or a prefix of that.
//   keel debug log [-f] [--level L] [--grep TEXT] [--lines N] [--session ID]   the daemon's log; -f follows it
import { parseArgs } from "node:util";
import { zonedStamp } from "../core/clock.ts";
import { formatLine, type LogLine } from "../admin/logs.ts";
import { type Gap, type SpanLite, turnGaps, waitLabel } from "../admin/trace-rows.ts";
import { chunks } from "../core/proc.ts";
import { authHeaders, findDaemon, refusal } from "./client.ts";

const USAGE = `keel debug [ERROR_ID] | --session ID [--turn EVENT]   the debug bundle, as Markdown
                                                      (an id that names no error is read as a session: its last turn)
keel debug errors [--all] [--json]                    the open errors, newest first
keel debug trace TRACE_ID [--json]                    one trace's spans
keel debug timeline SESSION [--since 1h] [--only failures|turns|agents] [--limit N] [--before CURSOR] [--no-ids] [--json]
                                                      what happened in a session, newest first, and what it does now
                                                      (--no-ids leaves the ids off the lines: fewer tokens for a model that only reads)
keel debug log [-f] [--level debug|info|warn|error] [--grep TEXT] [--lines N] [--session ID]
  SESSION and --session ID take a session's id, a prefix of it that names one session, or an
  agent's id or a prefix of that (the agent's session).
  Every form takes --url URL (else KEEL_URL, else the daemon of the state folder).`;

async function get(url: string, path: string): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(url + path, { headers: authHeaders() });
  } catch {
    throw new Error(`no daemon answers at ${url} (pass --url or set KEEL_URL)`);
  }
  if (!r.ok) throw new Error(await refusal(url, r, await r.json().catch(() => ({}))));
  return r;
}
const getJson = async (url: string, path: string) => (await get(url, path)).json() as Promise<any>;
// The terminal's own zone, said on the line: a line is read alone.
const time = zonedStamp;
const ms = (x: number) => (x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(2)} s`);

export async function debug(argv: string[]): Promise<number> {
  const { values: v, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" }, session: { type: "string" }, turn: { type: "string" },
      all: { type: "boolean" }, follow: { type: "boolean", short: "f" }, level: { type: "string" }, grep: { type: "string" }, lines: { type: "string" },
      since: { type: "string" }, only: { type: "string" }, limit: { type: "string" }, before: { type: "string" }, "no-ids": { type: "boolean" },
    },
  });
  if (v.help) return (console.log(USAGE), 0);
  const url = findDaemon({ url: v.url }).url;
  try {
    if (pos[0] === "errors") {
      const { errors } = await getJson(url, `/api/errors${v.all ? "" : "?resolved=0"}`);
      if (v.json) return (console.log(JSON.stringify(errors, null, 2)), 0);
      if (!errors.length) console.log("No open errors.");
      for (const e of errors) console.log(`${e.id}  ${time(e.ts)}  ${e.source.padEnd(8)} ${String(e.count ?? 1).padStart(4)}x  ${e.message.split("\n")[0].slice(0, 140)}`);
      return 0;
    }
    if (pos[0] === "trace") {
      if (!pos[1]) throw new Error("name the trace: keel debug trace TRACE_ID");
      const { spans } = await getJson(url, `/api/debug/traces/${pos[1]}`);
      if (v.json) return (console.log(JSON.stringify(spans, null, 2)), 0);
      // Spans and the gaps of each turn (time no span covers, said as what it most likely was), in time order.
      const t0 = Math.min(...spans.map((s: SpanLite) => s.start_ms), Infinity);
      const gaps: Gap[] = spans.filter((s: SpanLite) => s.kind === "turn").flatMap((s: SpanLite) => turnGaps(spans, s.span_id));
      const rows = [...spans.map((s: any) => ({ at: s.start_ms, s })), ...gaps.map((g) => ({ at: g.start_ms, g }))].sort((a, b) => a.at - b.at);
      const at = (t: number) => `+${((t - t0) / 1000).toFixed(2).padStart(7)}s`;
      for (const r of rows) {
        if ("g" in r) { console.log(`  ${at(r.g.start_ms)}   ${`(${r.g.label})`.padEnd(30)} ${ms(r.g.end_ms - r.g.start_ms).padStart(9)}  gap`); continue; }
        const s = r.s;
        const d = (s.end_ms ?? Date.now()) - s.start_ms;
        const name = s.kind === "wait" ? waitLabel(s) : s.name;
        console.log(`${s.status === "error" ? "!" : " "} ${at(s.start_ms)} ${s.parent_id ? "  " : ""}${name.padEnd(30)} ${ms(d).padStart(9)}  ${s.status}${s.error_type ? ` (${s.error_type})` : ""}  ${s.span_id}${s.error ? `\n      ${s.error.split("\n")[0].slice(0, 200)}` : ""}`);
      }
      return 0;
    }
    if (pos[0] === "timeline") {
      const id = pos[1] ?? v.session;
      if (!id) throw new Error("name the session: keel debug timeline SESSION");
      const q = new URLSearchParams(Object.entries({ since: v.since, only: v.only, limit: v.limit, before: v.before, format: v.json ? undefined : "text", ids: v["no-ids"] && !v.json ? "0" : undefined }).filter(([, x]) => x) as [string, string][]);
      const r = await get(url, `/api/sessions/${encodeURIComponent(id)}/timeline?${q}`);
      process.stdout.write(v.json ? JSON.stringify(await r.json(), null, 2) + "\n" : await r.text());
      return 0;
    }
    if (pos[0] === "log") return await log(url, v);
    let q: string;
    if (v.session) {
      const { session } = await getJson(url, `/api/cli/resolve?id=${encodeURIComponent(v.session)}`);
      q = `session_id=${encodeURIComponent(session.id)}${v.turn ? `&turn_event=${encodeURIComponent(v.turn)}` : ""}`;
    }
    else {
      const id = pos[0] ?? (await getJson(url, "/api/errors?resolved=0")).errors[0]?.id;
      if (!id) return (console.log("No open errors; name one (keel debug errors --all) or a session (--session ID)."), 0);
      q = `error_id=${encodeURIComponent(id)}`;
      // An id that names no error may name a session (the short id a report's row ends with): its last turn's bundle.
      if (pos[0] && !(await fetch(`${url}/api/debug/bundle?${q}`, { headers: authHeaders() }).then((r) => r.ok, () => true))) {
        const found = await fetch(`${url}/api/cli/resolve?id=${encodeURIComponent(id)}`, { headers: authHeaders() }).then((r) => (r.ok ? (r.json() as Promise<any>) : null), () => null);
        if (found?.session?.id) q = `session_id=${encodeURIComponent(found.session.id)}`;
      }
    }
    process.stdout.write(await (await get(url, `/api/debug/bundle?${q}`)).text());
    return 0;
  } catch (e) {
    console.error(`keel: ${(e as Error).message}`);
    return 1;
  }
}

async function log(url: string, v: { follow?: boolean; level?: string; grep?: string; lines?: string; json?: boolean; session?: string }) {
  // --session takes what every form takes: an id, a prefix, or an agent's id.
  const session: string | undefined = v.session ? (await getJson(url, `/api/cli/resolve?id=${encodeURIComponent(v.session)}`)).session.id : undefined;
  const print = (l: LogLine) => {
    if (v.grep && !l.text.toLowerCase().includes(v.grep.toLowerCase())) return;
    if (session && l.session !== session) return;
    console.log(v.json ? JSON.stringify(l) : formatLine(l));
  };
  const level = v.level ? `&level=${encodeURIComponent(v.level)}` : "";
  const { lines, dir } = await getJson(url, `/api/logs?limit=${Number(v.lines) || 200}${level}${v.grep ? `&q=${encodeURIComponent(v.grep)}` : ""}${session ? `&session=${encodeURIComponent(session)}` : ""}`);
  for (const l of lines) print(l);
  if (!v.follow) {
    if (!v.json) console.error(`(the daemon's log files: ${dir})`);
    return 0;
  }
  const r = await get(url, `/api/logs/stream?${level.slice(1)}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks(r.body!)) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = ev.split("\n").filter((x) => x.startsWith("data: ")).map((x) => x.slice(6)).join("\n");
      if (data) print(JSON.parse(data));
    }
  }
  return 0;
}
