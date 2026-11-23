// The overlap forecast's joins to the daemon (src/worktree/overlap-scan.ts):
// a tool call that moved a branch tip or the base schedules a pass of its
// repository, a turn's start tells the session what it is owed, and the page
// reads a session's repository: its live branches and the pairs that conflict.
import { registerHooks } from "../../engine/hooks.ts";
import { markOf, Overlaps, type Mark } from "../../worktree/overlap-scan.ts";
import type { Deps, RouteModule } from "../app.ts";

export const overlapRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, errors } = deps;
  const ov = new Overlaps(store, {
    running: (id) => engine.isRunning(id),
    // Only into a turn that runs: a note of this kind never starts one.
    steer: (id, text, meta) => engine.isRunning(id) && !!engine.send(id, text, { mode: "steer", meta }).queued,
    changed: (ids) => { for (const id of ids) bus.emit({ t: "feature", name: "overlap", session_id: id, data: { changed: true } }); },
    failed: (e, at) => void errors.capture("server", e, { at }),
  });

  // The last mark each session's calls left: a call after which its branch's
  // tip, or the base's, is not what it was moved it (a commit, a rebase, a
  // reset, a fetch of the base).
  const last = new Map<string, Mark>();
  const seen = (s: Parameters<typeof markOf>[0]) => {
    try {
      const now = markOf(s, (repo) => ov.baseKnown(repo));
      if (!now) return;
      const was = last.get(s.id);
      last.set(s.id, now);
      if (last.size > 4096) last.delete(last.keys().next().value!);
      if (was && was.repo === now.repo && was.branch === now.branch && was.tip === now.tip && was.base === now.base) return;
      const base = ov.baseKnown(now.repo)?.replace(/^refs\/heads\//, "");
      // Its branch moved under this session's call: the session committed to it.
      if (was && was.repo === now.repo && now.branch && was.branch === now.branch && was.tip !== now.tip && now.branch !== base) ov.committed(now.repo, now.branch, s.id);
      ov.schedule(now.repo);
    } catch (e) {
      errors.capture("server", e, { at: "overlap mark", session: s.id });
    }
  };
  registerHooks({
    afterTool: (s) => seen(s),
    toolFailed: (s) => seen(s),
    // Owed notes join the turn as a steer, once the turn runs (the hook runs just before).
    turnStart: (s) => {
      seen(s);
      queueMicrotask(() => { try { ov.tell(s.id); } catch (e) { errors.capture("server", e, { at: "overlap tell", session: s.id }); } });
    },
  });

  // A start checks every repository with live branches once, after the daemon is up.
  const boot = setTimeout(() => { for (const repo of ov.repos()) ov.schedule(repo, 0); }, 3_000);
  boot.unref?.();

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  return {
    "/api/sessions/:id/overlap": {
      GET: (req: any) => (store.session(req.params.id) ? json(ov.view(req.params.id)) : json({ error: "no such session" }, 404)),
    },
    // The owner's refresh: a pass now, answered when it is done.
    "/api/sessions/:id/overlap/check": {
      POST: async (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const at = ov.whereOf(req.params.id);
        if (at) {
          // The session's own branch counts from now when it has commits of its own.
          if (at.branch && !ov.owners(at.repo).has(at.branch)) {
            const base = (await ov.baseOf(at.repo))?.replace(/^refs\/heads\//, "");
            if (at.branch !== base) ov.committed(at.repo, at.branch, req.params.id);
          }
          await ov.scan(at.repo);
        }
        return json(ov.view(req.params.id));
      },
    },
  };
};
