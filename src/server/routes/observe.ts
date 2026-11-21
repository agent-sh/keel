// Observability built for fixing: traces per turn, the daemon log, a debug
// bundle an agent can read, "fix this", replaying a failed request, and OTLP
// export of the traces.
//
// GET  /api/debug/bundle?error_id= | ?session_id=&turn_event=   the bundle, text/markdown
// POST /api/debug/fix { error_id | session_id, model?, workspace? }
//        writes the bundle under the state folder and starts a session that is
//        asked to find the cause and fix it -> { session, path }
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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildBundle } from "../../admin/bundle.ts";
import { detached } from "../../core/errors.ts";
import { gitSync } from "../../core/git.ts";
import { cutWhere } from "../../admin/life-rows.ts";
import { installLogs, LEVELS, logAt, logDir, logLines, onLog } from "../../admin/logs.ts";
import { newestTurn } from "../../admin/marks.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { turnReceipt } from "../../admin/receipt.ts";
import { endpointOf, headerRefError, headerSourceOf, OtlpExporter, providerName } from "../../admin/otlp.ts";
import { type LogEvent, Meter, metricInterval, type Point, promptEvent, signalEndpoint, signalOn, spanEvent, spanMetrics, toOtlpLogs, toOtlpMetrics } from "../../admin/otlp-signals.ts";
import { key } from "../../providers/creds.ts";
import { onSettings, registerSettings, settings } from "../../admin/settings.ts";
import { TRACE_LIST, TRACE_LIST_MAX, traceparent, Tracer } from "../../admin/trace.ts";
import { registerEnv } from "../../tools/jobs.ts";
import { errorClass } from "../../admin/classes.ts";
import { errorText } from "../../engine/retry.ts";
import { type Wire, wireScope } from "../../providers/wiretap.ts";
import type { ProviderResult } from "../../providers/types.ts";
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

export const observeRoutes: RouteModule = ({ store, bus, engine, providers, errors, workspace }) => {
  installLogs(store.stateDir);
  const t = (tracer = new Tracer(store, bus, (id) => engine.isRunning(id)));
  // An error that names a span is filed under that span's session and turn.
  errors.spanOf = (id) => t.span(id);
  const src = (G.__keelSource ??= { v: source() }).v as ReturnType<typeof source>;
  const version = `${buildId()}${src?.commit ? ` (source ${src.commit})` : ""}`;

  // One exporter per process; hot reload re-points it.
  G.__keelOtlp?.stop();
  const resource = { "service.name": "keel", "service.version": version, "process.pid": process.pid, "telemetry.sdk.name": "keel", "telemetry.sdk.language": "javascript" };
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
  }));
  // What no span holds: a prompt arriving, and what a turn cost.
  const offBus = bus.on((f) => {
    if (f.t !== "event" || (!metricsOut.state.endpoint && !eventsOut.state.endpoint)) return;
    const e = f.event;
    if (e.kind === "user" && eventsOut.state.endpoint) detached(() => eventsOut.push(promptEvent(e)));
    else if (e.kind === "turn_end" && metricsOut.state.endpoint && e.data?.usage?.cost > 0) {
      const route = store.session(e.session_id)?.model ?? "";
      meter.add("keel.cost.usage", "USD", { "gen_ai.request.model": route.slice(route.indexOf(":") + 1), "gen_ai.provider.name": providerName(route) }, e.data.usage.cost);
    }
  });
  G.__keelOtlpMore = () => { clearTimeout(window); metricsOut.stop(); eventsOut.stop(); offBus(); };
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
    turnCut: (s, cut) => logAt({ session: s.id, turn: cut.turn_event }, `[turn] cut ${cutWhere(cut)}: ${cut.crashed ? "the daemon went down" : "a daemon stop parked it"}`, cut.crashed ? "warn" : "info"),
    turnCutSettled: (s, cut, state, why) => logAt({ session: s.id, turn: cut.turn_event },
      state === "continued" ? "[turn] continued after the restart" : state === "held" ? `[turn] not continued after the restart: ${why ?? "held for the owner"}` : "[turn] went on by other means after the restart", state === "held" ? "warn" : "info"),
  });
  bus.on((f) => {
    if (f.t !== "event") return;
    const e = f.event;
    const at = () => ({ session: e.session_id, turn: engine.turnOf(e.session_id) ?? newestTurn(store, e.session_id)?.id });
    if (e.kind === "turn_end" && e.data?.reason === "restart" && !e.data.crashed) logAt(at(), "[turn] parked for a daemon stop");
    else if (e.kind === "compaction") {
      const n = e.data?.tokens_before;
      logAt({ session: e.session_id, turn: engine.turnOf(e.session_id) }, `[turn] context ${e.data?.mode === "clear" ? "cleared" : e.data?.trigger === "model" ? "started fresh by the model" : e.data?.auto ? "compacted by itself" : "compacted by the owner"}${typeof n === "number" && n > 0 ? `, from ${n} tokens` : ""}`);
    }
  });

  const bundleFor = (q: { error_id?: string | null; session_id?: string | null; turn_event?: string | null; span_id?: string | null }) => {
    const error = q.error_id ? store.error(q.error_id) : undefined;
    if (q.error_id && !error) return { status: 404, error: "no such error" } as const;
    if (!error && !q.session_id && !q.span_id) return { status: 400, error: "error_id, session_id or span_id" } as const;
    if (q.session_id && !store.session(q.session_id)) return { status: 404, error: "no such session" } as const;
    // A span alone names its own session: one that is not kept leaves nothing to bundle.
    if (q.span_id && !error && !q.session_id && !t.span(q.span_id)) return { status: 404, error: "no such span" } as const;
    return buildBundle(store, t, { error, session_id: q.session_id ?? undefined, turn_event: q.turn_event ?? undefined, span_id: q.span_id ?? undefined, daemon: { state_dir: store.stateDir }, version, live: (id) => ({ running: engine.isRunning(id), status: engine.statusOf(id) }) });
  };

  return {
    "/api/debug/bundle": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const b = bundleFor({ error_id: q.get("error_id"), session_id: q.get("session_id"), turn_event: q.get("turn_event"), span_id: q.get("span_id") });
        if ("status" in b) return json({ error: b.error }, b.status);
        return new Response(b.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
      },
    },

    "/api/debug/fix": {
      POST: async (req: Request) => {
        const body = (await req.json().catch(() => ({}))) as any;
        const b = bundleFor({ error_id: body.error_id, session_id: body.session_id, turn_event: body.turn_event, span_id: body.span_id });
        if ("status" in b) return json({ error: b.error }, b.status);
        const dir = join(store.stateDir, "debug");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
        writeFileSync(path, b.markdown, { mode: 0o600 });
        const err = body.error_id ? store.error(body.error_id) : undefined;
        const from = err?.session_id ? store.session(err.session_id) : body.session_id ? store.session(body.session_id) : undefined;
        // Keel's own failures are fixed in Keel's source when the daemon runs from it; others where they happened.
        const own = err && (err.source === "server" || err.source === "client");
        const ws = resolve(body.workspace || (own && src ? src.dir : from?.workspace ?? src?.dir ?? workspace));
        const model = body.model || (await providers.defaultModel());
        if (!model) return json({ error: "no model is available: no provider has credentials" }, 409);
        await providers.resolve(model);
        const s = store.createSession({ model, workspace: ws, title: `Fix: ${err ? err.message.split("\n")[0] : b.title}`.slice(0, 90) });
        bus.emit({ t: "session", session: store.session(s.id)! });
        const text = [
          `Something failed in Keel${from ? ` (session "${from.title}")` : ""}: ${b.title}`,
          "",
          `The debug bundle is ${path}. Read it first: it has the failure, the trace of its turn with the failing request's shape and wire facts, the transcript before it and the daemon log around it.`,
          "Find the cause. If it is a bug in code you can change here, fix it and say how you checked the fix. If it is not a code problem (a key, a quota, the network, a provider outage), say what it is and what the owner should do.",
        ].join("\n");
        engine.send(s.id, text);
        return json({ session: store.session(s.id), path }, 201);
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
    // and no turn runs. The answer's text comes back clipped.
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
        const t0 = Date.now();
        const tap: Wire = {};
        let first: number | undefined;
        let text = "";
        try {
          const res: ProviderResult = await wireScope.run(tap, () => resolved.provider.stream(
            { ...sent, model: resolved.info.model, route: resolved.info.id, signal: AbortSignal.timeout(300_000), purpose: "side" },
            (d) => { first ??= Date.now(); if (d.kind === "text") text += d.text; },
          ));
          // A stream that ends in a refusal did not answer: the same error class a turn's request gets.
          const refused = res.stop === "refusal";
          const error = refused ? res.stop_details?.explanation ?? "refusal" : undefined;
          const span = t.recordReplay(of, resolved.info.id, t0, { ok: !refused, ...(refused ? { error, error_type: "refusal" } : {}), result: res, wire: tap, ttft: first ? first - t0 : undefined });
          return json({ span, ok: !refused, ...(refused ? { error } : {}), text: text.slice(0, 2000), stop: res.stop });
        } catch (e) {
          const span = t.recordReplay(of, resolved.info.id, t0, { ok: false, error: errorText(e).slice(0, 4000), error_type: errorClass(e) ?? (e as any)?.kind ?? "error", wire: tap });
          return json({ span, ok: false, error: errorText(e) });
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
