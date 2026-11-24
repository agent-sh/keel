// Daemon administration: settings, storage and cleanup, backups, drain and
// restart, keep-awake, status, and the problem report.
//
// GET   /api/bootstrap                     build id, pid, draining, folders, settings
// GET   /api/settings                      { settings }
// PATCH /api/settings                      a JSON merge patch -> { settings }; 400 leaves nothing changed,
//                                          409 while settings.json cannot be read (its bytes are kept)
// POST  /api/settings/reset                moves an unreadable settings.json aside -> { moved_to, settings }
// GET   /api/storage?refresh=1             sizes by kind and by session
// POST  /api/storage/cleanup               { older_than_days, sessions? } | { leftovers: true }
// GET   /api/storage/retention             { settings, due, proposed? }: spilled output and usage records past the owner's
//                                          retention; while none is set, what the proposed one would list
// POST  /api/storage/retention             { spill_before_ms?, usage_before_ms?, egress_before_ms?, sessions? } from a listing -> { removed, due }
// POST  /api/storage/retention/removed     { session_id, paths } -> { removed }: which of them the retention removed
// GET   /api/backups                       { backups, settings, owed }
// POST  /api/backups                       a backup now -> { backup }
// GET   /api/daemon                        status: pid, uptime, running turns, draining, restart_failed
// POST  /api/drain                         { timeout_seconds?, restart? } -> { ok, running, restart }
// GET   /api/awake | POST { until_ms }     keep-awake state, a timed hold
// POST  /api/report                        { session_id?, note?, dry_run? } -> { includes, path?, summary }
import { checkpointerOf } from "../../core/checkpoint.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Awake } from "../../admin/awake.ts";
import { Daemon } from "../../admin/daemon.ts";
import { restarts } from "../../admin/life.ts";
import { say, settingsChanges, settingsLine } from "../../admin/daemon-log.ts";
import { restartNeedsEye, restartSummary, restartTurnLine, type Restart } from "../../admin/life-rows.ts";
import { logOwn } from "../../admin/logs.ts";
import * as activity from "../../automation/activity.ts";
import { tellCutAgents, tellEarlier } from "../../automation/restart-told.ts";
import { loadSettings, onSettings, patchSettings, resetSettings, settings, settingsUnreadable } from "../../admin/settings.ts";
import { Storage } from "../../admin/storage.ts";
import { PROPOSED, Retention, retentionOf } from "../../admin/retention.ts";
import { configDir } from "../../providers/config.ts";
import type { Tracer } from "../../admin/trace.ts";
import { tracer } from "./observe.ts";
import type { RouteModule } from "../app.ts";
import { resources } from "./resources.ts";
import { runMode } from "../../core/runmode.ts";
import { buildId } from "../../core/build.ts";
import { homeDir } from "../../core/paths";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const body = async (req: Request) => (await req.json().catch(() => undefined)) as any;
const DRAIN_DEFAULT_S = 120;

// Hot reload runs this module again in the same process: one of each.
const G = globalThis as any;

// Keys, tokens and the home folder out of anything a report carries.
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|\b[A-Za-z0-9+/]{40,}={0,2})/g;
// Keel's own placeholder ([secret:1a2b3c4d]) holds no value: it stays, with the text after it.
const KEYED = /((?:api[_-]?key|token|secret|password|passwd|authorization|bearer|cookie)["']?\s*[:=]\s*["']?)(?![0-9a-f]{8}\])[^\s"',}]{6,}/gi;
export function redact(v: unknown): unknown {
  const home = homeDir();
  const walk = (x: any): any => {
    if (typeof x === "string") return x.replace(KEYED, "$1[redacted]").replace(SECRET, "[redacted]").split(home).join("~");
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, /key|token|secret|password|credential|cookie|authorization/i.test(k) ? "[redacted]" : walk(v)]));
    return x;
  };
  return walk(v);
}

export { buildId };

export const adminRoutes: RouteModule = (deps) => {
  const { store, errors, bus, providers } = deps;
  loadSettings(store.stateDir, (e) => errors.capture("server", e, { at: "settings" }));
  const prev = G.__keelAdmin;
  prev?.awake.stopAll();
  prev?.retention?.stop();
  prev?.storage?.stopChecks();
  clearInterval(prev?.daily);
  clearInterval(prev?.hourly);
  const daemon = new Daemon(deps);
  // A command's own short-lived daemon answers nobody else: only a served one is watched.
  if (!runMode.client) daemon.watchStalls({ state: store.stateDir, config: configDir() }, (context, what, id) => tracer?.stall(context as Parameters<Tracer["stall"]>[0], what, id));
  const storage = new Storage(store, deps.engine, bus, errors, configDir());
  const awake = new Awake(bus, (e, ctx) => errors.capture("server", e, ctx));
  const retention = new Retention(store, deps.engine, errors);
  daemon.onExit(() => awake.stopAll());
  // The checkpoint thread's connections close before the process ends: the daemon's is then the last, and its close empties the log.
  daemon.onExit(() => checkpointerOf(store)?.close());
  // A check of the backups that runs does not outlive the daemon.
  daemon.onExit(() => storage.stopChecks());
  // The backup before a restart is made once the running turns had their
  // time and before the rest are parked (a backup that fails calls the
  // restart off with no turn cut). So it does not hold what a turn the
  // restart parks wrote after it: the results of its cut calls and its end.
  // Restored, that turn is found open, as after a crash: the start closes
  // it as cut and continues it.
  // It is made in a worker and the restart waits for it: the daemon answers
  // meanwhile (it is draining, so nothing new starts).
  // A check of earlier backups that runs then is ended for it (Storage.backup).
  daemon.onRestart(async () => {
    if (!settings().backup.before_restart) return;
    // The changes since the last full backup are waited for; a full backup is owed to the daemon that starts next (Storage.backupQuick).
    try { const b = await storage.backupQuick("before a restart"); return "owed" in b ? { owed: b.owed } : b.name; } catch (e) { throw new Error(`The backup before the restart failed: ${(e as Error).message}`, { cause: e }); }
    // Where the restart does not come after all, the backup is still read back.
    finally { storage.checkLater(); }
  });
  // The check that follows a backup. A delta made before a restart is read
  // back whole by the daemon that starts after it: a start that finds
  // backups left unchecked checks them twenty seconds later, when the turns
  // it continued have their first requests out.
  if (!runMode.client) storage.checkLeft();
  onSettings(() => awake.update());
  const policy = () => storage.applyPolicy().catch((e) => errors.capture("server", e, { at: "archive policy" }));
  const daily = setInterval(policy, 86_400_000);
  (daily as any).unref?.();
  // What is past the owner's retention goes once a day, at the time the page
  // names (Retention.next): looked at on start and every hour, since a daemon
  // that restarts several times a day never reaches a daily timer.
  const keep = () => retention.tick().then((r) => { if (r) storage.stale(); }, (e) => errors.capture("server", e, { at: "retention" }));
  const hourly = setInterval(keep, 3_600_000);
  (hourly as any).unref?.();
  G.__keelAdmin = { awake, daily, hourly, daemon, retention, storage };
  // The record of this start (src/admin/life.ts): the page follows it as the
  // cut turns are decided, and when it is whole it is the log's account of the
  // restart, and one Activity row when the owner has something to look at (the
  // daemon did not choose to go down, or a turn was not continued).
  const starts = restarts();
  if (starts) {
    // Each change is a cut turn found or decided: a session with a cut agent that is decided is told of it
    // with its next request, and of the others as they are decided; what an earlier start still owed is
    // told once this start's record is whole (src/automation/restart-told.ts).
    const tell = (r: Restart, whole = false) => { try { tellCutAgents(r); if (whole) tellEarlier(r); } catch (e) { errors.capture("server", e, { at: "restart told to parents" }); } };
    // (After the step that changed it: a start finds every cut turn before it decides the first.)
    starts.changed = () => { daemon.emit(); queueMicrotask(() => tell(starts.last())); };
    // The log has a line a turn already, under the turn's own name (observe.ts).
    starts.whole = (r) => {
      if (r.before || r.turns.length) logOwn(`[daemon] ${restartSummary(r)}`);
      if (restartNeedsEye(r)) activity.record("daemon", r.before?.how ?? "unknown", null, [restartSummary(r), ...r.turns.map(restartTurnLine)].join(" "), { restart: r });
      tell(r, true);
    };
  }

  // Once per process start: the archive policy. (SIGINT and SIGTERM drain in main.ts.)
  if (!prev && !runMode.client) queueMicrotask(() => { policy(); keep(); });
  // A stop by signal drains in main.ts; new work is turned away meanwhile.
  if (!G.__keelAdminSignals) {
    G.__keelAdminSignals = true;
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
      if (G.__keelAdmin) G.__keelAdmin.awake.signalled = true; // the keep-awake lock ends with the signal: not a refusal
      G.__keelAdmin?.daemon.refuseWork();
      G.__keelAdmin?.storage?.stopChecks(); // a check's process ends with the daemon
    });
  }
  bus.on((f) => {
    if (f.t === "feature" && f.name === "daemon") awake.draining = !!f.data.draining;
  });

  return {
    // What a page needs first about this daemon. `build_id` changes with every
    // new binary (or script): a page that saw another one offers a reload.
    "/api/bootstrap": {
      GET: () => json({
        server_name: "keel",
        build_id: buildId(),
        pid: process.pid,
        started_ms: daemon.started,
        draining: daemon.draining,
        // The sessions with a turn running: what a drain waits for, said with it.
        running: daemon.runningSessions().length,
        // The store's disk does not answer (src/core/checkpoint.ts): the page says so across its top.
        store: daemon.status().store,
        home: homeDir(),
        default_cwd: deps.workspace,
        recent_cwds: store.db.query<{ workspace: string }, []>("SELECT workspace FROM sessions WHERE parent_id IS NULL GROUP BY workspace ORDER BY MAX(updated) DESC LIMIT 20").all().map((r) => r.workspace),
        settings: settings(),
      }),
    },

    "/api/settings": {
      GET: () => json({ settings: settings(), ...(settingsUnreadable() !== undefined ? { unreadable: settingsUnreadable() } : {}) }),
      PATCH: async (req: Request) => {
        const before = settings();
        const r = patchSettings(await body(req));
        // The log says what changed, by name; never a value that could be a secret (daemon-log.ts).
        if (r.ok) { const changes = settingsChanges(before, r.settings); if (changes.length) say(settingsLine(changes)); }
        return r.ok ? json({ settings: r.settings }) : json({ error: r.error }, r.status ?? 400);
      },
    },
    "/api/settings/reset": {
      POST: () => json({ ...resetSettings(), settings: settings() }),
    },

    "/api/storage": {
      GET: async (req: Request) => json(await storage.report(new URL(req.url).searchParams.has("refresh"))),
    },
    "/api/storage/cleanup": {
      POST: async (req: Request) => {
        const b = await body(req);
        if (b?.leftovers === true) return json(storage.removeLeftovers());
        const days = b?.older_than_days;
        if (!Number.isInteger(days) || days < 1) return json({ error: "older_than_days is a whole number of at least 1" }, 400);
        if (b.sessions === undefined) {
          const list = storage.candidates(days);
          return json({ sessions: list, bytes: list.reduce((n, s) => n + s.bytes, 0), deleted: [], skipped: [] });
        }
        if (!Array.isArray(b.sessions) || b.sessions.some((s: any) => typeof s?.id !== "string" || typeof s?.updated_ms !== "number" || (s.family_updated_ms !== undefined && typeof s.family_updated_ms !== "number"))) {
          return json({ error: "sessions is a list of { id, updated_ms, family_updated_ms } from the listing" }, 400);
        }
        const r = await storage.cleanup(days, b.sessions);
        return json({ sessions: storage.candidates(days), ...r });
      },
    },

    // What is past the retention the owner set, counted (GET), and removed up
    // to the instants a listing named (POST): never anything younger than the
    // settings allow.
    "/api/storage/retention": {
      GET: async () => {
        // As it is acted on: a value in settings.json that is not a retention is never, and named.
        const { invalid, ...now } = retentionOf();
        // Nothing set yet: nothing is removed, and the page shows what the proposed retention would list.
        const unset = !now.spill_days && !now.usage_days;
        return json({ settings: now, ...(invalid.length ? { invalid } : {}), due: await retention.due(), ...(unset ? { proposed: { ...PROPOSED, due: await retention.due(Date.now(), PROPOSED) } } : {}) });
      },
      POST: async (req: Request) => {
        const b = (await body(req)) ?? {};
        const ms = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
        if (typeof b !== "object" || !ms(b.spill_before_ms) || !ms(b.usage_before_ms) || !ms(b.egress_before_ms) || (b.sessions !== undefined && (!Array.isArray(b.sessions) || b.sessions.some((x: unknown) => typeof x !== "string")))) {
          return json({ error: "the body is { spill_before_ms?, usage_before_ms?, egress_before_ms?, sessions? } from the listing" }, 400);
        }
        // Spilled output goes only from the sessions the listing named.
        if (typeof b.spill_before_ms === "number" && b.sessions === undefined) return json({ error: "sessions is the list of session ids the listing named (due.spill.session_ids)" }, 400);
        const removed = await retention.remove({ spill_before_ms: b.spill_before_ms, usage_before_ms: b.usage_before_ms, egress_before_ms: b.egress_before_ms, sessions: b.sessions });
        storage.stale();
        return json({ removed, due: await retention.due() });
      },
    },
    "/api/storage/retention/removed": {
      POST: async (req: Request) => {
        const b = (await body(req)) ?? {};
        if (typeof b.session_id !== "string" || !/^[\w-]+$/.test(b.session_id) || !Array.isArray(b.paths)) return json({ error: "the body is { session_id, paths }" }, 400);
        return json({ removed: retention.removedOf(b.session_id, b.paths.slice(0, 50)) });
      },
    },

    // { sessions?: ids, archived?: true }: drops those sessions' checkpoints (a
    // rewind to their turns is no longer possible) and those of deleted sessions.
    "/api/storage/checkpoints": {
      POST: async (req: Request) => {
        const b = (await body(req)) ?? {};
        if ((b.sessions !== undefined && (!Array.isArray(b.sessions) || b.sessions.some((x: unknown) => typeof x !== "string"))) || (b.archived !== undefined && typeof b.archived !== "boolean")) {
          return json({ error: "the body is { sessions?: string[], archived?: boolean }" }, 400);
        }
        const ids: string[] = [...(b.sessions ?? [])];
        if (b.archived) ids.push(...store.sessions({ archived: true }).map((s) => s.id));
        for (const id of ids) if (!store.session(id)) return json({ error: `no such session ${id}` }, 404);
        return json(await storage.removeCheckpoints(ids));
      },
    },

    "/api/backups": {
      // `owed`: the backup the last restart did not wait for, until this daemon has made it.
      GET: () => json({ backups: storage.backups(), settings: settings().backup, owed: storage.owed() ?? null }),
      POST: async () => {
        const backup = await storage.backup("asked for");
        // Read back whole after the answer (a delta is checked for its pages before it has its name).
        storage.checkLater(0);
        return json({ backup }, 201);
      },
    },

    "/api/daemon": { GET: () => json(daemon.status()) },

    "/api/drain": {
      POST: async (req: Request) => {
        const b = (await body(req)) ?? {};
        if (typeof b !== "object" || (b.timeout_seconds !== undefined && !(Number(b.timeout_seconds) >= 0)) || (b.restart !== undefined && typeof b.restart !== "boolean")) {
          return json({ error: "the body is { timeout_seconds?: number, restart?: boolean, reason?: string }" }, 400);
        }
        const running = daemon.runningSessions();
        // `reason`: why it was asked, a few words for the log (keel restart and the page say who asked).
        const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.replace(/\s+/g, " ").trim().slice(0, 120) : undefined;
        daemon.drain({ timeoutMs: (b.timeout_seconds ?? DRAIN_DEFAULT_S) * 1000, restart: !!b.restart, reason });
        // (`notes`: what this stop or restart does not do, known as it begins: no backup when the store's disk does not answer.)
        const notes = daemon.draining?.notes;
        return json({ ok: true, running, restart: !!b.restart, ...(notes?.length ? { notes } : {}) });
      },
    },

    "/api/awake": {
      GET: () => json(awake.state()),
      POST: async (req: Request) => {
        const b = await body(req);
        const until = b?.until_ms;
        if (until !== null && !(typeof until === "number" && until > Date.now())) return json({ error: "until_ms is a time in the future, or null" }, 400);
        if (!awake.available && until !== null) return json({ error: "this machine has no logind on a system bus to ask" }, 409);
        awake.hold(until);
        return json(awake.state());
      },
    },

    "/api/report": {
      POST: async (req: Request) => {
        const b = (await body(req)) ?? {};
        const s = b.session_id ? store.session(b.session_id) : undefined;
        if (b.session_id && !s) return json({ error: "no such session" }, 404);
        const includes = ["daemon", "providers", "errors", "settings", "resources", "storage", ...(s ? ["session"] : []), ...(b.note ? ["note"] : [])];
        let lastTurn: unknown;
        if (s) {
          const ev = store.events(s.id);
          const start = ev.findLastIndex((e) => e.kind === "turn_start");
          const from = Math.max(0, ev.slice(0, Math.max(0, start)).findLastIndex((e) => e.kind === "user"));
          lastTurn = ev.slice(from).map((e) => ({ seq: e.seq, kind: e.kind, ts: e.ts, data: JSON.parse(JSON.stringify(e.data, (_k, v) => (typeof v === "string" && v.length > 4000 ? `${v.slice(0, 4000)}... (${v.length} chars)` : v))) }));
        }
        const bundle = redact({
          created_ms: Date.now(),
          note: b.note,
          daemon: daemon.status(),
          providers: providers.statuses(),
          errors: store.errors(500).filter((e) => e.ts >= daemon.started),
          settings: settings(),
          resources: resources?.report({ historyMin: 15 }),
          storage: await storage.report(),
          session: s ? { id: s.id, title: s.title, model: s.model, phase: s.phase, usage: s.usage, last_turn: lastTurn } : undefined,
        }) as any;
        const summary = `${bundle.errors.length} errors since the daemon started, ${bundle.providers.filter((p: any) => p.available).length} providers available${s ? `, session ${s.title || s.id}` : ""}`;
        if (b.dry_run) return json({ includes, summary, bundle });
        const dir = join(store.stateDir, "reports");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        writeFileSync(path, JSON.stringify(bundle, null, 2), { mode: 0o600 });
        return json({ includes, path, summary }, 201);
      },
    },
  };
};
