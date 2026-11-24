// PR Steward's joins to the daemon (src/steward/watch.ts): the owner turns a
// watch on a session's own pull request on and off, the page reads its state,
// a turn the watch starts goes to the session (or its agent), and the gate is
// told which branch that turn may push to (src/steward/guard.ts).
import { join } from "node:path";
import * as agents from "../../automation/agents.ts";
import { alertHook, deliver, isPending } from "../../automation/core.ts";
import { runMode } from "../../core/runmode.ts";
import { joinPulse } from "../../core/pulse.ts";
import { stewards } from "../../steward/guard.ts";
import { Steward } from "../../steward/watch.ts";
import { Worktrees } from "../../worktree/manager.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const guard = async (f: () => Promise<Response>) => {
  try { return await f(); } catch (e) {
    const status = (e as any)?.status;
    if (typeof status === "number") return bad((e as Error).message, status);
    return bad((e as Error).message, 502);
  }
};

const g = globalThis as { __keelStewardLeave?: () => void; __keelStewardOff?: () => void };

export const stewardRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, errors } = deps;
  const wts = new Worktrees(store, join(store.stateDir, "worktrees"));
  const st = new Steward(store, bus, {
    worktree: (id) => { const w = wts.get(id); return w ? { path: w.path, branch: w.branch, state: w.state } : undefined; },
    send: async (id, text, meta, sent) => {
      const s = store.session(id);
      if (!s || s.archived) return "gone";
      // The owner's own Stop holds the session: nothing but the owner starts it again.
      if (engine.isHeld(id)) return "held";
      const a = agents.byChild(id);
      if (a) {
        // The turn that ends after this point is the one that reads it.
        sent();
        const r = await agents.send(a.id, text, false, `steward:${meta.repo}#${meta.number}:${Date.now()}`, undefined, undefined, "steward");
        return r.held ? "held" : "sent";
      }
      return deliver(id, text, meta, { onSent: (e) => sent(e.seq) }) ? "sent" : "gone";
    },
    inbox: (id, title, body) => alertHook.raise?.("failed", id, title, body, { open_session: id }),
    running: (id) => engine.isRunning(id),
    pending: (id) => isPending(id, (m) => m.kind === "steward"),
    error: (e, at) => void errors.capture("server", e, { at }),
  });
  stewards.of = (id) => st.guards.get(id);
  g.__keelStewardOff?.();
  g.__keelStewardOff = bus.on((f) => {
    try {
      if (f.t === "event") st.onEvent(f.event);
      else if (f.t === "session" && (f.deleted || f.session.archived)) {
        st.guards.delete(f.session.id);
        if (!f.deleted) st.stop(f.session.id, "stopped", "The session was archived.");
      }
    } catch (e) { errors.capture("server", e, { at: "pr steward frame" }); }
  });
  g.__keelStewardLeave?.();
  if (!runMode.client) {
    st.recover();
    g.__keelStewardLeave = joinPulse("steward", () => st.tick(), { every: 1_000, due: () => st.due() });
  }

  return {
    "/api/sessions/:id/steward": {
      GET: (req: any) => (store.session(req.params.id) ? json(st.view(req.params.id)) : bad("no such session", 404)),
      POST: (req: any) => guard(async () => {
        const b = (await req.json().catch(() => ({}))) ?? {};
        await st.start(req.params.id, { stay: b.stay === true, bots: Array.isArray(b.bots) ? b.bots.filter((x: unknown) => typeof x === "string") : [] });
        return json(st.view(req.params.id), 201);
      }),
      DELETE: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        st.stop(req.params.id);
        return json(st.view(req.params.id));
      },
    },
  };
};
