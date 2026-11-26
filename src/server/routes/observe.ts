// Observability built for fixing: traces per turn, the daemon log, a debug
// bundle an agent can read, "fix this", replaying a failed request, and OTLP
// export of the traces.
//
// GET  /api/debug/bundle?error_id= | ?session_id=&turn_event=   the bundle, text/markdown
// POST /api/debug/fix { error_id | session_id, model?, workspace?, task?, repo? }
//        task: the instruction for the agent, in place of the stock one (the helper's look writes one for a bug of
//        Keel's); repo "keel": the agent works in Keel's own source folder (from the checkout the daemon runs from, else helper.keel_repo, else the folder the binary was built from; 409 saying which is missing)
//        writes the bundle under the state folder and starts a session that is
//        asked to find the cause and fix it -> 201 { session, path }. One fix a cause: while the session started for the
//        failure's cause (its error group, else its span or turn) is there and not archived, a press opens it
//        -> 200 { session, existing: true }; two presses at once start one session.
// GET  /api/debug/fixes?error_ids=a,b            { fixes: { <error id>: <session id> } }: the open fix of each one's cause
// GET  /api/debug/traces?session_id=&limit=     a session's traces (their root spans), newest first
//                                               (limit: a whole number from 1, 50 by default, at most 200)
// GET  /api/debug/traces/:id                    { spans } of one trace, in start order
// GET  /api/debug/turns/:id/receipt             metadata only, keyed by the turn_start event id
// GET  /api/debug/spans/:id                     { span }
// POST /api/debug/spans/:id/replay { route? }   sends a failed request again (to its own route or another)
//                                               -> { span, ok, error?, text?, stop? }; a refusal is ok: false with stop "refusal"
// GET  /api/debug/export                        the OTLP exporter's state (traces), with `metrics` and `events` for the other two signals
// POST /api/debug/export/flush                  sends what waits now, the measurements of the open window included -> the same state
// GET  /api/logs?since_ms=&level=&q=&limit=     the daemon's kept log lines -> { lines, dir }
// GET  /api/logs/stream?level=                  the same, live, as server-sent events
import { resourceOf } from "../../admin/otlp-resource.ts";
import { crossing } from "../../safety/content-routes.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildBundle } from "../../admin/bundle.ts";
import { detached } from "../../core/errors.ts";
import { atSession } from "../../core/error-sites.ts";
import { gitSync } from "../../core/git.ts";
import { causeOf } from "../../helper/error-look.ts";
import { keelRepo } from "../../core/keel-source.ts";
import type { Session } from "../../core/types.ts";
import { cutWhere } from "../../admin/life-rows.ts";
import { agentLine, say, sayAt, stopLine } from "../../admin/daemon-log.ts";
import { bindStory } from "../../admin/story.ts";
import { installLogs, LEVELS, logAt, logDir, logLines, onLog } from "../../admin/logs.ts";
import { newestTurn } from "../../admin/marks.ts";
import { measured, registerHooks } from "../../engine/hooks.ts";
import { turnReceipt } from "../../admin/receipt.ts";
import { endpointOf, headerRefError, headerSourceOf, OtlpExporter, providerName } from "../../admin/otlp.ts";
import { onLedgerCost } from "../../admin/telemetry.ts";
import { type LogEvent, Meter, metricInterval, type Point, promptEvent, signalEndpoint, signalOn, spanEvent, spanMetrics, toOtlpLogs, toOtlpMetrics } from "../../admin/otlp-signals.ts";
import { key } from "../../providers/creds.ts";
import { onSettings, registerSettings, settings } from "../../admin/settings.ts";
import { TRACE_LIST, TRACE_LIST_MAX, traceparent, Tracer } from "../../admin/trace.ts";
import { registerEnv } from "../../tools/jobs.ts";
import { errorClass } from "../../admin/classes.ts";
import { errorText } from "../../engine/retry.ts";
import { reportedUsage } from "../../providers/reported.ts";
import { type Wire, wireOf, wireScope } from "../../providers/wiretap.ts";
import type { ProviderRequest, ProviderResult } from "../../providers/types.ts";
import type { RouteModule } from "../app.ts";
import { buildId } from "./admin.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const G = globalThis as any;

// otlp_metrics, otlp_events: whether those signals go out beside the traces
// (null: as the OpenTelemetry selectors in the daemon's environment say).
registerSettings("observe", { otlp_endpoint: null, otlp_headers: null, otlp_metrics: null, otlp_events: null }, (v) =>
  ![v.otlp_metrics, v.otlp_events].every((x) => x === null || typeof x === "boolean") ? "otlp_metrics and otlp_events are true, false or null"
    : v.otlp_endpoint === null || (typeof v.otlp_endpoint === "string" && /^https?:\/\/\S+$/.test(v.otlp_endpoint)) ? headerRefError(v.otlp_headers) : "otlp_endpoint is an http(s) URL, or null",
);

// Keel's source folder, when the daemon runs from a checkout (not the one binary), and its commit.
function source(): { dir: string; commit?: string } | undefined {
  const dir = resolve(dirname(import.meta.dir), "..", "..");
  if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "src", "engine", "turn.ts"))) return undefined;
  const r = gitSync(dir, ["rev-parse", "--short", "HEAD"], { read: true, timeout: 3000 });
  return { dir, commit: r.code === 0 ? r.out.trim() : undefined };
}

export let tracer: Tracer | undefined;

// The top frame of a stack, as a place in the code: its function and file, without the folder, line or column
// (a rebuild moves those). Undefined: no stack, or no frame in it.
export function topFrame(stack: string | null | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n")) {
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?)(?::\d+){0,2}\)?\s*$/.exec(line);
    if (!m) continue;
    const file = (m[2] ?? "").split(/[\\/]/).pop()?.replace(/\?.*$/, "") ?? "";
    return `${m[1] ?? ""}@${file}`;
  }
  return undefined;
}

// The key a fix is kept under: an error's cause (the helper's grouping, src/helper/error-look.ts) with where it
// came from, so two failures that read alike are one fix only from one place: the top frame of a server or
// client error's stack, else the folder of the session it failed in. Else the span or turn the press names.
export const fixKey = (b: { error_id?: string; session_id?: string; turn_event?: string; span_id?: string }, err?: { source: string; message: string; stack?: string | null; session_id?: string | null }, folderOf: (id: string) => string | undefined = () => undefined) => {
  if (!err) return b.span_id ? `span:${b.span_id}` : b.session_id ? `turn:${b.session_id}:${b.turn_event ?? ""}` : undefined;
  const frame = err.source === "server" || err.source === "client" ? topFrame(err.stack) : undefined;
  const place = frame ? `frame:${frame}` : err.session_id ? `folder:${folderOf(err.session_id) ?? err.session_id}` : "";
  return `cause:${causeOf(err)}${place ? `:${Bun.hash(place).toString(36)}` : ""}`;
};

export const observeRoutes: RouteModule = ({ store, bus, engine, providers, errors, workspace }) => {
  installLogs(store.stateDir);
  store.migrate("CREATE TABLE IF NOT EXISTS debug_fixes (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL)");
  // The fix session kept for a key while it is there and not archived (an archived or deleted one frees the key).
  const openFix = (key: string) => {
    const r = store.db.query<{ session_id: string }, [string]>("SELECT session_id FROM debug_fixes WHERE key = ?").get(key);
    const s = r ? store.session(r.session_id) : undefined;
    return s && !s.archived ? s : undefined;
  };
  const folderOf = (id: string) => store.session(id)?.workspace || undefined;
  // A fix being started now, by key: a second press waits for it and opens the same session.
  type StartedFix = { session: Session; path: string };
  const starting = new Map<string, Promise<StartedFix | Response>>();
  const reopen = (session: Session) => json({ session, existing: true });
  const t = (tracer = new Tracer(store, bus, (id) => engine.isRunning(id)));
  // An error that names a span is filed under that span's session and turn.
  errors.spanOf = (id) => t.span(id);
  const src = (G.__keelSource ??= { v: source() }).v as ReturnType<typeof source>;
  const version = `${buildId()}${src?.commit ? ` (source ${src.commit})` : ""}`;

  // One exporter per process; hot reload re-points it.
  G.__keelOtlp?.stop();
  const { resource } = resourceOf(process.env, { "service.name": "keel", "service.version": version, "process.pid": process.pid, "telemetry.sdk.name": "keel", "telemetry.sdk.language": "javascript" });
  const fail = (e: Error) => errors.capture("server", e, { at: "otlp export" });
  const exporter = new OtlpExporter(resource, key, fail);
  G.__keelOtlp = exporter;
  // The other two signals, each to its own address at the same collector (otlp-signals.ts).
  G.__keelOtlpMore?.();
  const metricsOut = new OtlpExporter<Point>(resource, key, fail, toOtlpMetrics, "OTLP metrics export");
  const eventsOut = new OtlpExporter<LogEvent>(resource, key, fail, toOtlpLogs, "OTLP events export");
  const meter = new Meter();
  let window: ReturnType<typeof setTimeout> | undefined;
  // A window of measurements goes out one interval after its first one: an idle daemon sends nothing.
  const collect = () => {
    clearTimeout(window);
    window = undefined;
    for (const p of meter.collect()) metricsOut.push(p);
  };
  meter.onFirst = () => { window ??= setTimeout(() => detached(collect), metricInterval(process.env)); };
  const point = () => {
    const o = settings().observe ?? {};
    exporter.configure(endpointOf(o.otlp_endpoint, process.env), headerSourceOf(o.otlp_headers, process.env));
    metricsOut.configure(signalOn("metrics", o.otlp_metrics, process.env) ? signalEndpoint("metrics", o.otlp_endpoint, process.env) : null, headerSourceOf(o.otlp_headers, process.env, "METRICS"));
    eventsOut.configure(signalOn("logs", o.otlp_events, process.env) ? signalEndpoint("logs", o.otlp_endpoint, process.env) : null, headerSourceOf(o.otlp_headers, process.env, "LOGS"));
    if (!metricsOut.state.endpoint) { clearTimeout(window); window = undefined; meter.collect(); }
  };
  point();
  G.__keelOtlpOff?.();
  G.__keelOtlpOff = onSettings(point);
  // The export is the daemon's own work: its timers and what they fail with belong to no turn.
  t.onEnd((s) => detached(() => {
    exporter.push(s);
    if (metricsOut.state.endpoint) spanMetrics(meter, s);
    const e = eventsOut.state.endpoint ? spanEvent(s) : null;
    if (e) eventsOut.push(e);
  }), () => !!(exporter.state.endpoint || metricsOut.state.endpoint || eventsOut.state.endpoint));
  // The spans a kill cut: the daemon before this one exported their children as they ended and went down
  // before these ended. They go out now, closed as interrupted, so no exported span lacks its parent.
  // They stay owed in the store until the collector answers a batch that holds them: a daemon that
  // goes down again first hands them out again at its next start.
  exporter.onSent = (batch) => t.exported(batch.map((s) => s.span_id));
  const owed = t.owedAtStart();
  if (owed.length) detached(() => {
    const first = owed.filter((o) => o.first).length, again = owed.length - first;
    if (!exporter.state.endpoint) {
      t.forget();
      if (first) say(`[daemon] ${first} span${first === 1 ? "" : "s"} the last daemon left running ${first === 1 ? "was" : "were"} closed as interrupted`);
      return;
    }
    for (const { span, first: fresh } of owed) {
      exporter.push(span);
      // Counted once: a span handed out again was measured the first time.
      if (!fresh) continue;
      if (metricsOut.state.endpoint) spanMetrics(meter, span);
      const e = eventsOut.state.endpoint ? spanEvent(span) : null;
      if (e) eventsOut.push(e);
    }
    say(`[daemon] ${first ? `${first} span${first === 1 ? "" : "s"} the last daemon left running ${first === 1 ? "was" : "were"} closed as interrupted` : "no span was left running by the last daemon"}${again ? `; ${again} from an earlier start ${again === 1 ? "was" : "were"} still owed to the collector` : ""}; ${owed.length} queued for the collector`);
  });
  // What no span holds: a prompt arriving, and what a turn cost.
  const offBus = bus.on((f) => {
    if (f.t !== "event" || (!metricsOut.state.endpoint && !eventsOut.state.endpoint)) return;
    const e = f.event;
    if (e.kind === "user" && eventsOut.state.endpoint) detached(() => eventsOut.push(promptEvent(e)));
  });
  // What a request cost, from the ledger rows (every purpose, a failed or stopped attempt at what its stream reported): the sum the ledger shows.
  const offCost = onLedgerCost((c) => {
    if (!metricsOut.state.endpoint) return;
    meter.add("keel.cost.usage", "USD", { "gen_ai.request.model": c.route.slice(c.route.indexOf(":") + 1), "gen_ai.provider.name": providerName(c.route) }, c.cost);
  });
  G.__keelOtlpMore = () => { clearTimeout(window); metricsOut.stop(); eventsOut.stop(); offBus(); offCost(); };
  // A command a turn runs joins the turn's trace (W3C trace context), as Claude Code's shells do, when traces go out.
  registerEnv((sid): Record<string, string> => {
    if (!exporter.state.endpoint || !engine.isRunning(sid)) return {};
    const c = t.context(sid);
    return c ? { TRACEPARENT: traceparent(c.trace, c.span) } : {};
  });
  clearInterval(G.__keelSpanPrune);
  G.__keelSpanPrune = setInterval(() => t.prune(), 6 * 3600_000);

  // The log's account of what a restart and the context did to a turn, each
  // line under the session and turn it is about: cut (a stop parked it, or the
  // daemon went down under it), what became of it, and compacted.
  registerHooks({
    turnCut: (s, cut) => logAt({ session: s.id, turn: cut.turn_event }, `[turn] cut ${cutWhere(cut)} in ${s.title ? `"${s.title.replace(/\s+/g, " ").slice(0, 48)}"` : "an untitled session"}${s.parent_id ? " (an agent)" : ""}: ${cut.crashed ? "the daemon went down" : "a daemon stop parked it"}`, cut.crashed ? "warn" : "info"),
    turnCutSettled: (s, cut, state, why) => logAt({ session: s.id, turn: cut.turn_event },
      state === "continued" ? "[turn] continued after the restart" : state === "held" ? `[turn] not continued after the restart: ${why ?? "held for the owner"}` : `[turn] ${why ?? "went on by other means"} after the restart`, state === "held" ? "warn" : "info"),
  });
  bus.on((f) => {
    if (f.t !== "event") return;
    const e = f.event;
    const at = () => ({ session: e.session_id, turn: engine.turnOf(e.session_id) ?? newestTurn(store, e.session_id)?.id });
    if (e.kind === "turn_end" && e.data?.reason === "restart" && !e.data.crashed) logAt(at(), "[turn] parked for a daemon stop");
    // (A hook's stop is said by the hook's own line, with its reason: src/server/routes/hooks.ts.)
    else if (e.kind === "turn_end" && e.data?.reason === "interrupted" && e.data.stopped_by !== "hook") sayAt(at(), stopLine(e.data.stopped_by));
    else if (e.kind === "compaction") {
      const n = e.data?.tokens_before;
      logAt({ session: e.session_id, turn: engine.turnOf(e.session_id) }, `[turn] context ${e.data?.mode === "clear" ? "cleared" : e.data?.trigger === "model" ? "started fresh by the model" : e.data?.auto ? "compacted by itself" : "compacted by the owner"}${typeof n === "number" && n > 0 ? `, from ${n} tokens` : ""}`);
    }
  });

  // Approvals, the judge, failed turns, messages and retries, one line each (src/admin/story.ts).
  const SG = globalThis as { __keelStoryOff?: () => void };
  SG.__keelStoryOff?.();
  SG.__keelStoryOff = bindStory({ store, bus });

  // An agent's start and end, each once, on its parent's session (the line names the agent).
  const agentState = (G.__keelAgentStates ??= new Map<string, string>()) as Map<string, string>;
  bus.on((f) => {
    if (f.t !== "feature" || f.name !== "automation" || f.data?.kind !== "agent" || !f.data.data?.id) return;
    const a = f.data.data;
    const line = agentLine(a, agentState.get(a.id), Math.floor(performance.timeOrigin));
    // Kept after its end too (a later frame of an ended agent says nothing again); the oldest go past a bound.
    agentState.delete(a.id);
    agentState.set(a.id, a.status);
    if (agentState.size > 2000) agentState.delete(agentState.keys().next().value!);
    if (line) sayAt({ session: a.parent_id }, `${line} [agent session ${String(a.session_id).slice(-12)}]`, a.status === "failed" ? "warn" : "info");
  });

  const bundleFor = (q: { error_id?: string | null; session_id?: string | null; turn_event?: string | null; span_id?: string | null }) => {
    const kind = q.error_id ? errors.find(q.error_id) : undefined;
    if (q.error_id && !kind) return { status: 404, error: "no such error" } as const;
    // Asked from a session: the bundle is of that session's own occurrence
    // (its turn and span), not of wherever the kind happened last.
    // A kind that happened in sessions, asked from one it never happened in (nor in its agents): there is no failure of that session to bundle.
    if (kind && q.session_id && kind.sites?.length && !kind.sites.some((x) => x.session_id === q.session_id || store.session(x.session_id)?.parent_id === q.session_id)) {
      return { status: 404, error: `that error did not happen in this session; it happened in ${kind.sites.slice(0, 4).map((x) => `"${x.title || x.session_id}"`).join(", ")}${kind.sites.length > 4 ? ` and ${kind.sites.length - 4} more` : ""}` } as const;
    }
    const error = kind && atSession(kind, q.session_id ?? undefined);
    if (!error && !q.session_id && !q.span_id) return { status: 400, error: "error_id, session_id or span_id" } as const;
    if (q.session_id && !store.session(q.session_id)) return { status: 404, error: "no such session" } as const;
    // A span alone names its own session: one that is not kept leaves nothing to bundle.
    if (q.span_id && !error && !q.session_id && !t.span(q.span_id)) return { status: 404, error: "no such span" } as const;
    return buildBundle(store, t, { error, session_id: q.session_id ?? undefined, turn_event: q.turn_event ?? undefined, span_id: q.span_id ?? undefined, daemon: { state_dir: store.stateDir }, version, live: (id) => ({ running: engine.isRunning(id), status: engine.statusOf(id) }) });
  };

  // A new fix session for the failure the body names, kept under its key.
  async function startFix(body: any, key: string | undefined): Promise<StartedFix | Response> {
    const b = bundleFor({ error_id: body.error_id, session_id: body.session_id, turn_event: body.turn_event, span_id: body.span_id });
    if ("status" in b) return json({ error: b.error }, b.status);
    const dir = join(store.stateDir, "debug");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    writeFileSync(path, b.markdown, { mode: 0o600 });
    const kind = body.error_id ? errors.get(body.error_id) : undefined;
    const err = kind && atSession(kind, body.session_id ?? undefined);
    const from = err?.session_id ? store.session(err.session_id) : body.session_id ? store.session(body.session_id) : undefined;
    // Keel's own failures are fixed in Keel's source when the daemon runs from it; others where they happened.
    const own = err && (err.source === "server" || err.source === "client");
    if (body.task !== undefined && (typeof body.task !== "string" || !body.task.trim() || body.task.length > 6000)) return json({ error: "task is the agent's instruction, up to 6000 characters" }, 400);
    const keel = keelRepo();
    if (body.repo === "keel" && !body.workspace && "problem" in keel) return json({ error: `Keel's source folder is not known: ${keel.problem}` }, 409);
    const keelDir = "repo" in keel ? keel.repo.dir : undefined;
    const ws = resolve(body.workspace || (body.repo === "keel" ? keelDir! : own && keelDir ? keelDir : from?.workspace ?? keelDir ?? workspace));
    const model = body.model || (await providers.defaultModel());
    if (!model) return json({ error: "no model is available: no provider has credentials" }, 409);
    await providers.resolve(model);
    const s = store.createSession({ model, workspace: ws, title: `Fix: ${err ? err.message.split("\n")[0] : b.title}`.slice(0, 90) });
    bus.emit({ t: "session", session: store.session(s.id)! });
    const text = [
      `Something failed in Keel${from ? ` (session "${from.title}")` : ""}: ${b.title}`,
      "",
      `The debug bundle is ${path}. Read it first: it has the failure, the trace of its turn with the failing request's shape and wire facts, the transcript before it and the daemon log around it.`,
      ...(body.task
        ? ["", body.task.trim()]
        : ["Find the cause. If it is a bug in code you can change here, fix it and say how you checked the fix. If it is not a code problem (a key, a quota, the network, a provider outage), say what it is and what the owner should do."]),
    ].join("\n");
    if (key) store.db.query("INSERT INTO debug_fixes (key, session_id, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id = excluded.session_id, ts = excluded.ts").run(key, s.id, Date.now());
    // Keel's words, written for the owner's press: `via` keeps them from being marked as his typing (personTyped).
    // The first line quotes a captured failure, which can carry a page's words: `quoted` names it, and the
    // provenance book reads it as outside content.
    engine.send(s.id, text, { meta: { via: "debug_fix", quoted: text.split("\n")[0] } });
    return { session: store.session(s.id)!, path };
  }

  return {
    "/api/debug/bundle": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const b = bundleFor({ error_id: q.get("error_id"), session_id: q.get("session_id"), turn_event: q.get("turn_event"), span_id: q.get("span_id") });
        if ("status" in b) return json({ error: b.error }, b.status);
        return new Response(b.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
      },
    },

    "/api/debug/fixes": {
      GET: (req: Request) => {
        const ids = (new URL(req.url).searchParams.get("error_ids") ?? "").split(",").filter(Boolean).slice(0, 200);
        const fixes: Record<string, string> = {};
        for (const id of ids) {
          const e = errors.find(id);
          const key = e ? fixKey({ error_id: id }, e, folderOf) : undefined;
          const s = key ? openFix(key) : undefined;
          if (s) fixes[id] = s.id;
        }
        return json({ fixes });
      },
    },

    "/api/debug/fix": {
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as any;
        const at = body.error_id ? errors.find(body.error_id) : undefined;
        const key = fixKey(body, at, folderOf);
        if (key) {
          const open = openFix(key);
          if (open) return reopen(open);
          const going = starting.get(key);
          if (going) {
            const fix = await going;
            return fix instanceof Response ? fix.clone() : reopen(fix.session);
          }
        }
        const run = startFix(body, key);
        if (key) { starting.set(key, run); const clear = () => void starting.delete(key); run.then(clear, clear); }
        const fix = await run;
        return fix instanceof Response ? fix.clone() : json(fix, 201);
      },
    },

    "/api/debug/traces": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const sid = q.get("session_id");
        if (!sid) return json({ error: "session_id" }, 400);
        if (!store.session(sid)) return json({ error: "no such session" }, 404);
        // A whole number from 1 up: SQLite reads a negative LIMIT as no limit at all.
        const limit = q.get("limit");
        if (limit !== null && !/^[1-9]\d*$/.test(limit)) return json({ error: `limit is a whole number of traces from 1 up (${TRACE_LIST} by default, at most ${TRACE_LIST_MAX})` }, 400);
        return json({ traces: t.traces(sid, limit === null ? TRACE_LIST : Number(limit)) });
      },
    },
    "/api/debug/traces/:id": {
      GET: (req: Request & { params: { id: string } }) => {
        const spans = t.trace(req.params.id);
        return spans.length ? json({ spans }) : json({ error: "no such trace" }, 404);
      },
    },
    "/api/debug/turns/:id/receipt": {
      GET: (req: Request & { params: { id: string } }) => {
        const receipt = turnReceipt(store, t, req.params.id);
        return Response.json(receipt ?? { error: "no such turn" }, {
          status: receipt ? 200 : 404,
          headers: { "cache-control": "no-store" },
        });
      },
    },
    "/api/debug/spans/:id": {
      GET: (req: Request & { params: { id: string } }) => {
        const s = t.span(req.params.id);
        return s ? json({ span: s }) : json({ error: "no such span" }, 404);
      },
    },

    // The request is sent outside any session's history: nothing is appended
    // and no turn runs, but the ledger books it with its session. The answer's text comes back clipped.
    "/api/debug/spans/:id/replay": {
      POST: async (req: Request & { params: { id: string } }) => {
        const of = t.span(req.params.id);
        if (!of) return json({ error: "no such span" }, 404);
        const sent = t.request(of.span_id);
        if (!sent) return json({ error: of.attrs.request_in ? "the request this retry sent is no longer kept: the attempt that held it aged out" : "this span kept no request (only failed model requests do)" }, 409);
        const body = (await req.json().catch(() => ({}))) as any;
        const route = String(body.route || sent.route || of.attrs.route);
        let resolved;
        try { resolved = await providers.resolve(route); } catch (e) { return json({ error: errorText(e) }, 400); }
        // The request holds the session's content: only to a provider its folder allows (src/safety/content-routes.ts).
        const cross = of.session_id ? crossing(store, of.session_id, "side", resolved.info.id, resolved.provider.id) : undefined;
        if (cross) return json({ error: `provider ${cross.provider} is not allowed for this session's folder (allowed: ${cross.allowed.join(", ") || "none"})` }, 403);
        // It is paid for: sent as a request of the span's session, through the measuring hooks, so the ledger
        // books it (purpose side, what its stream reported and its cost) with the usage and the budgets, and
        // its span is the one those hooks make, marked as the replay of this one.
        const owner = store.session(of.session_id);
        if (!owner) return json({ error: "the session this request belonged to is gone, so a replay has nothing to be booked to" }, 409);
        const tap: Wire = {};
        const out: ProviderRequest = { ...sent, model: resolved.info.model, route: resolved.info.id, signal: AbortSignal.timeout(300_000), purpose: "side" };
        wireOf.set(out, tap);
        t.replaying(out, of);
        let text = "";
        const spanOf = () => { store.side.flush(); return t.spanOf(out)!; };
        try {
          const res: ProviderResult = await wireScope.run(tap, () => measured(owner, out, (d) => resolved.provider.stream(out, (x) => { d(x); if (x.kind === "text") text += x.text; })));
          // A stream that ends in a refusal did not answer: the same error class a turn's request gets.
          const refused = res.stop === "refusal";
          store.addUsage(owner.id, res.usage, { keepPlace: true });
          return json({ span: spanOf(), ok: !refused, ...(refused ? { error: res.stop_details?.explanation ?? "refusal" } : {}), text: text.slice(0, 2000), stop: res.stop });
        } catch (e) {
          // A request cut or broken mid-stream was billed for what its stream reported.
          const spent = reportedUsage(e);
          if (spent) store.addUsage(owner.id, spent, { keepPlace: true });
          return json({ span: spanOf(), ok: false, error: errorText(e) });
        }
      },
    },

    "/api/debug/export": { GET: () => json({ ...exporter.state, metrics: metricsOut.state, events: eventsOut.state }) },
    "/api/debug/export/flush": {
      POST: async () => {
        collect();
        await Promise.all([exporter.flush(), metricsOut.flush(), eventsOut.flush()]);
        return json({ ...exporter.state, metrics: metricsOut.state, events: eventsOut.state });
      },
    },

    "/api/logs": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const level = q.get("level") ?? undefined;
        if (level && !(LEVELS as readonly string[]).includes(level)) return json({ error: `level is one of ${LEVELS.join(", ")}` }, 400);
        const since = q.get("since_ms") ? Number(q.get("since_ms")) : undefined;
        // `session`: only the lines written in that session's turns.
        return json({ lines: logLines({ since, level, q: q.get("q") ?? undefined, session: q.get("session") ?? undefined, limit: Math.min(2000, Number(q.get("limit")) || 500) }), dir: logDir() });
      },
    },
    "/api/logs/stream": {
      GET: (req: Request) => {
        const min = LEVELS.indexOf((new URL(req.url).searchParams.get("level") ?? "debug") as any);
        let off = () => {};
        let ping: Timer | undefined;
        const stop = () => { off(); clearInterval(ping); };
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            const put = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { stop(); } };
            put(": keel log\n\n");
            off = onLog((l) => { if (LEVELS.indexOf(l.level) >= min) put(`data: ${JSON.stringify(l)}\n\n`); });
            // Under the server's idle timeout, so a quiet log keeps its stream.
            ping = setInterval(() => put(": ping\n\n"), 5000);
            req.signal.addEventListener("abort", () => { stop(); try { c.close(); } catch {} }, { once: true });
          },
          cancel: stop,
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      },
    },
  };
};
