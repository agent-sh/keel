// The owner's own tools Keel works with: tacit (memory hooks) and momentum
// (the supervisor's report and control socket).
import { registerSessionPatch, type RouteModule } from "../app.ts";
import { draftPresent } from "./drafts.ts";
import { deliver } from "../../automation/core.ts";
import { momentumReport, momentumSocketPath, startMomentumSocket } from "../../integrations/momentum.ts";
import { memoryMeter } from "../../integrations/memory-meter.ts";
import { isWriter, MemoryStore, memoryWriter as writer } from "../../integrations/memory-store.ts";
import { readsOf } from "../reads.ts";
import { memoryRoutes } from "./memory.ts";
import { findBin, Tacit } from "../../integrations/tacit.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

const bad = (error: string, status = 400) => json({ error }, status);

export const integrationRoutes: RouteModule = (deps) => {
  const { store, engine, errors } = deps;
  const tacit = new Tacit(store, deps.bus, errors);
  tacit.install();

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

  return {
    ...memoryRoutes(deps, new MemoryStore(() => tacit.bin, store.stateDir, writer), memoryMeter(store)),
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
