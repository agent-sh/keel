// Before and after pictures of a branch that changes the page (src/pictures/run.ts): its table, its
// runs' joins to the agents that end with such a branch, and its routes.
//
// GET  /api/pictures/:id                     -> { run } with every pair
// GET  /api/pictures/:id/:side/:name         -> the PNG of one side of a pair (before or after)
// GET  /api/sessions/:id/pictures[?head=SHA&repo=DIR] -> { run, named }: the run of the session's folder's head (or
//                                               the given head), started when it has none and its tree names pictures
// POST /api/sessions/:id/pictures            -> { run } taken again for the session's folder's head (null: its tree names none)
// A frame "pictures" to the agent's session and its tree's root says each step.
import { theOwnersLook } from "./looks.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { byChild, rootSession } from "../../automation/agents.ts";
import { repoOf } from "../../checks/ledger.ts";
import { git } from "../../core/git.ts";
import { bindPictures, byId, filesOf, ofHead, startFor } from "../../pictures/run.ts";
import type { RouteModule } from "../app.ts";
import { gate } from "./permissions.ts";
import { workBoard } from "./board.ts";

const NAME = /^[\w.@+-]{1,200}\.png$/;
const SHA = /^[0-9a-f]{40}$/;

export const pictureRoutes: RouteModule = ({ store, bus, errors }) => {
  void bindPictures({
    store, bus,
    perm: (id) => gate?.perm(id),
    confine: (id, workspace, tool, shown) => gate?.confineFor(id, workspace, tool, shown),
    capture: (e, ctx) => errors.capture("server", e, ctx),
    look: theOwnersLook,
    viewers: (r) => {
      const root = r.session_id ? rootSession(r.session_id) : undefined;
      if (root) workBoard()?.forget(root);
      return root ? [root] : [];
    },
  });
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const headOf = async (folder: string) => (await git(folder, ["rev-parse", "HEAD"], { read: true, timeout: 10_000 })).out.trim();
  return {
    "/api/pictures/:id": {
      GET: (req: any) => {
        const run = byId(Number(req.params.id));
        return run ? json({ run }) : json({ error: "no such run" }, 404);
      },
    },
    "/api/pictures/:id/:side/:name": {
      GET: (req: any) => {
        const { side, name } = req.params as { side: string; name: string };
        const run = byId(Number(req.params.id));
        if (!run || (side !== "before" && side !== "after") || !NAME.test(name)) return json({ error: "no such picture" }, 404);
        const path = join(filesOf(run.id, side), name);
        if (!existsSync(path)) return json({ error: run.kept ? "no such picture" : "the pictures of this run were removed (a newer head's run, or the space kept for pictures)" }, 404);
        return new Response(Bun.file(path), { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400, immutable" } });
      },
    },
    "/api/sessions/:id/pictures": {
      // Opening the pictures of a head starts their run when it has none (startFor gives back the one it has):
      // the session's folder's head, or `head` in `repo` for an agent whose worktree is gone.
      GET: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const q = new URL(req.url).searchParams;
        const given = q.get("head"), at = q.get("repo");
        const own = existsSync(s.workspace) && repoOf(s.workspace) ? s.workspace : null;
        const folder = own ?? (given && SHA.test(given) && at && repoOf(at) ? at : null);
        if (!folder) return json({ run: null, named: false });
        const head = given && SHA.test(given) ? given : own ? await headOf(own) : "";
        if (!SHA.test(head)) return json({ run: null, named: false });
        const had = ofHead(repoOf(folder)!.common, head);
        if (had) return json({ run: had, named: true });
        const a = byChild(s.id);
        try {
          const run = await startFor({ folder, head, branch: a?.branch ?? null, session_id: s.id, agent_id: a?.id ?? null });
          return json({ run: run ?? null, named: !!run });
        } catch (e) { errors.capture("server", e, { at: "pictures", session: s.id }); return json({ error: (e as Error).message }, 500); }
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        try { return json({ run: (await startFor({ folder: s.workspace, session_id: s.id, agent_id: byChild(s.id)?.id ?? null, again: true })) ?? null }); }
        catch (e) { errors.capture("server", e, { at: "pictures", session: s.id }); return json({ error: (e as Error).message }, 500); }
      },
    },
  };
};
