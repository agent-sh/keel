// The overlap forecast's joins to the daemon (src/worktree/overlap-scan.ts):
// a tool call that moved a branch tip or the base schedules a pass of its
// repository, a turn's model request carries what its session is owed as a
// note for the model, and the page reads a session's repository: its live
// branches and the pairs that conflict.
import { registerHooks } from "../../engine/hooks.ts";
import { toMessages } from "../../engine/turn.ts";
import { keepMark, lastMark, markOf, Overlaps, sameMark, type Mark } from "../../worktree/overlap-scan.ts";
import type { Deps, RouteModule } from "../app.ts";

// The forecast of this daemon: the landing queue orders and warns by it (src/server/routes/landing.ts).
export let overlaps: Overlaps | undefined;
// Told at the end of each pass of a repository (the pair checks follow it: src/landing/together.ts).
export const overlapPassed: { tell?: (repo: string) => void } = {};

export const overlapRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const ov = new Overlaps(store, {
    changed: (ids) => { for (const id of ids) bus.emit({ t: "feature", name: "overlap", session_id: id, data: { changed: true } }); },
    failed: (e, at) => void errors.capture("server", e, { at }),
    passed: (repo) => overlapPassed.tell?.(repo),
  });
  overlaps = ov;

  // The last mark each session's calls left (kept in the store, read once a
  // session): a call after which its branch's tip, or the base's, is not what
  // it was moved it (a commit, a rebase, a reset, a fetch of the base).
  const last = new Map<string, Mark | null>();
  const seen = (s: Parameters<typeof markOf>[0]) => {
    try {
      const now = markOf(s, (repo) => ov.baseKnown(repo));
      if (!now) return;
      if (!last.has(s.id)) last.set(s.id, lastMark(store, s.id) ?? null);
      const was = last.get(s.id) ?? undefined;
      if (sameMark(was, now)) return;
      last.set(s.id, now);
      if (last.size > 4096) last.delete(last.keys().next().value!);
      keepMark(store, s.id, now);
      if (was && (was.tip !== now.tip || was.base !== now.base)) ov.moved(now.repo, s.id);
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
    turnStart: (s) => seen(s),
    // What the session is owed goes into its turn's next model request, as a
    // stored note for the model: appended after the history (the cache prefix
    // stays), and never a turn or a queued input of its own.
    beforeRequest: (s, req) => {
      if (req.purpose !== "turn") return req;
      try {
        const n = ov.noteFor(s.id);
        if (!n) return req;
        store.atomic(s.id, () => {
          const ev = store.append(s.id, "note", { kind: "overlap", model: true, text: n.text, short: n.short, pairs: n.pairs });
          n.settle();
          bus.emit({ t: "event", event: ev });
        });
        return { ...req, messages: toMessages(store.lineage(s.id)) };
      } catch (e) {
        errors.capture("server", e, { at: "overlap note", session: s.id });
        return req;
      }
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
