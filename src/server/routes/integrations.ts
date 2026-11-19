// The owner's own tools Keel works with: tacit (memory hooks) and momentum
// (the supervisor's report and control socket).
import { registerSessionPatch, type RouteModule } from "../app.ts";
import { momentumReport, momentumSocketPath, startMomentumSocket } from "../../integrations/momentum.ts";
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
    g.__keelMomentum = startMomentumSocket(momentumSocketPath(store.stateDir), { store, engine, transcript: (s) => tacit.transcriptPath(s) });
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
      if (b.use_memory !== undefined && b.use_memory !== tacit.flags(s.id).use_memory && store.events(s.id).some((e) => e.kind === "user"))
        throw Object.assign(new Error("memory use is fixed once the first message is sent"), { status: 409 });
    },
    apply(s, b) {
      const patch: any = {};
      for (const k of ["use_memory", "feed_memory"]) if (typeof b[k] === "boolean") patch[k] = b[k];
      tacit.setFlags(s.id, patch);
    },
  });

  return {
    "/api/integrations": {
      GET: () => json({ tacit: { available: !!tacit.bin, bin: tacit.bin }, momentum: { available: !!findBin("MOMENTUM_BIN", "momentum"), socket } }),
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
