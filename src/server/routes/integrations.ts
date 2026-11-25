// The owner's own tools Keel works with: tacit (memory hooks) and momentum
// (the supervisor's report and control socket).
import { registerSessionPatch, type RouteModule } from "../app.ts";
import { draftPresent } from "./drafts.ts";
import { deliver } from "../../automation/core.ts";
import { momentumReport, momentumSocketPath, startMomentumSocket } from "../../integrations/momentum.ts";
import { raise, settleMetric } from "../../automation/alerts.ts";
import { memoryMeter, MEMORY_PATHS } from "../../integrations/memory-meter.ts";
import { watchFell } from "../../integrations/memory-fell.ts";
import { isWriter, MemoryStore, memoryWriter as writer } from "../../integrations/memory-store.ts";
import { readsOf } from "../reads.ts";
import { memoryRoutes } from "./memory.ts";
import { sweepRoutes } from "./sweep.ts";
import { wireNativeLog } from "../../integrations/native-log.ts";
import { findBin, Tacit } from "../../integrations/tacit.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

const bad = (error: string, status = 400) => json({ error }, status);

export const integrationRoutes: RouteModule = (deps) => {
  const { store, engine, errors } = deps;
  const tacit = new Tacit(store, deps.bus, errors);
  tacit.install();
  // The model's own harness's memory is divided with the owner's store where the store is on for the session; each load is noted for the sweep.
  wireNativeLog(store, (s) => !!tacit.bin && tacit.flags(s.id).use_memory);

  // Under `bun --hot` this module runs again: close the old socket first.
  const g = globalThis as { __keelMomentum?: { stop(): void } };
  g.__keelMomentum?.stop();
  let socket: string | null = null;
  try {
    g.__keelMomentum = startMomentumSocket(momentumSocketPath(store.stateDir), { store, engine, transcript: (s) => tacit.transcriptPath(s), draft: (id) => draftPresent(store, id), deliver });
    socket = momentumSocketPath(store.stateDir);
  } catch (e) {
    g.__keelMomentum = undefined;
    errors.capture("server", e, { at: "momentum socket" });
  }

  // A fall of the store's recall is one alert, looked for every ten minutes (a reload replaces the last timer).
  store.migrate("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const meta = (path: string) => `memory_fell:${path}`;
  const looks = () => void watchFell({
    standing: () => memoryMeter(store).standingOn(readsOf(store)),
    open: () => new Set(MEMORY_PATHS.filter((p) => store.db.query("SELECT 1 FROM admin_meta WHERE key = ?").get(meta(p)))),
    mark: (path, on) => void (on ? store.db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES (?, ?)").run(meta(path), String(Date.now())) : store.db.query("DELETE FROM admin_meta WHERE key = ?").run(meta(path))),
    raise: (f, t) => void raise("regression", null, t.title, t.body, { metric: "memory_recall", path: f.path, recent: f.recent, day: f.day }),
    settle: (path) => settleMetric("memory_recall", path),
  }).catch((e) => errors.capture("server", e, { at: "memory recall check" }));
  const fl = globalThis as { __keelFellTimer?: ReturnType<typeof setInterval>; __keelFellFirst?: ReturnType<typeof setTimeout> };
  clearInterval(fl.__keelFellTimer); clearTimeout(fl.__keelFellFirst);
  fl.__keelFellTimer = setInterval(looks, 600_000);
  fl.__keelFellFirst = setTimeout(looks, 60_000);
  fl.__keelFellTimer.unref?.(); fl.__keelFellFirst.unref?.();

  // The memory switches are fields of the session too (PATCH /api/sessions/:id).
  registerSessionPatch({
    id: "memory",
    fields: ["use_memory", "feed_memory"],
    check(s, b) {
      for (const k of ["use_memory", "feed_memory"]) if (b[k] !== undefined && typeof b[k] !== "boolean") throw Object.assign(new Error(`${k} is true or false`), { status: 400 });
      if (b.use_memory !== undefined && b.use_memory !== tacit.flags(s.id).use_memory && store.hasKind(s.id, "user"))
        throw Object.assign(new Error("memory use is fixed once the first message is sent"), { status: 409 });
    },
    apply(s, b) {
      const patch: any = {};
      for (const k of ["use_memory", "feed_memory"]) if (typeof b[k] === "boolean") patch[k] = b[k];
      tacit.setFlags(s.id, patch);
    },
  });

  const mem = new MemoryStore(() => tacit.bin, store.stateDir, writer);
  return {
    ...memoryRoutes(deps, mem, memoryMeter(store)),
    ...sweepRoutes(deps, mem, { on: () => !!tacit.bin }, { on: () => !!findBin("MOMENTUM_BIN", "momentum") }),
    "/api/integrations": {
      GET: () => json({ tacit: { available: !!tacit.bin, bin: tacit.bin, writer: writer(), writer_from: isWriter(process.env.TACIT_HARNESS?.trim()) ? "TACIT_HARNESS" : "settings" }, momentum: { available: !!findBin("MOMENTUM_BIN", "momentum"), socket } }),
    },
    "/api/integrations/tacit/stats": {
      GET: () => Response.json(tacit.stats(), { headers: { "cache-control": "no-store" } }),
    },
    // GET /api/telemetry/memory?since_ms=&until_ms=&session_id=: what memory added to
    // the turns and whether they used it, per recall path and in total. Counts,
    // tokens and times only: no fact, name or prompt is kept or returned.
    // Summed on the read thread: the table has a row per prompt and tool call.
    "/api/telemetry/memory": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        const since = num("since_ms"), until = num("until_ms");
        if ([since, until].some((v) => v !== undefined && !Number.isFinite(v))) return bad("a bound is not a number");
        const session = q.get("session_id") || undefined;
        if (session && !store.session(session)) return bad("no such session", 404);
        // `store`: how the memory store answers right now (the kinds of call that are out, or often
        // late), and the kinds of tool call it has long had nothing for, asked only now and then
        // (`quiet`; `passed`: calls of theirs not asked since the daemon started).
        const { out, degraded, quiet, tools } = tacit.stats();
        // `fell`: the paths whose recall in the last two hours is half of their day's or less
        // (memory-meter.ts recallFell), always against now, whatever range the panel shows.
        const meter = memoryMeter(store), reads = readsOf(store);
        const [report, fell] = await Promise.all([meter.reportOn(reads, { since, until, session }), session ? [] : meter.fellOn(reads)]);
        return Response.json({ ...report, fell, store: { out, degraded, quiet, passed: tools.quiet_skipped } }, { headers: { "cache-control": "no-store" } });
      },
    },
    "/api/momentum": { GET: async () => json(await momentumReport()) },
    "/api/sessions/:id/memory": {
      GET: (req: any) => (store.session(req.params.id) ? json({ available: !!tacit.bin, ...tacit.flags(req.params.id) }) : bad("no such session", 404)),
      PATCH: async (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        const patch: any = {};
        for (const k of ["use_memory", "feed_memory"]) if (typeof b[k] === "boolean") patch[k] = b[k];
        const r = tacit.setFlags(req.params.id, patch);
        return "error" in r ? bad(r.error, 409) : json({ available: !!tacit.bin, ...r });
      },
    },
  };
};
