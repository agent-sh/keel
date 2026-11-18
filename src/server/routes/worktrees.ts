// Worktree sessions, park and restore, pull requests, the branch diff, and
// review comments sent back to the model.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitError, Worktrees } from "../../worktree/manager.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const guard = async (f: () => Promise<Response>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof GitError) return bad(e.message, e.status);
    throw e;
  }
};

export const worktreeRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, providers } = deps;
  const wts = new Worktrees(store, join(store.stateDir, "worktrees"));
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const managed = (id: string) => {
    const s = store.session(id);
    if (!s) return { error: bad("no such session", 404) };
    const w = wts.get(id);
    if (!w) return { error: bad("the session has no managed worktree") };
    return { s, w };
  };
  const emit = (id: string) => bus.emit({ t: "feature", name: "worktree", session_id: id, data: { changed: true } });

  return {
    "/api/worktrees": {
      GET: () => guard(async () => json({ worktrees: await Promise.all(wts.all().map((w) => wts.status(w))) })),
      // A new session in a fresh worktree of the folder's repository.
      POST: (req: any) => guard(async () => {
        const b = await body(req);
        const workspace = resolve(b.workspace || deps.workspace);
        if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return bad(`not a directory: ${workspace}`);
        const model = b.model || (await providers.defaultModel());
        if (!model) return bad("no model is available: no provider has credentials", 409);
        await providers.resolve(model);
        const title = String(b.title || b.text || "").split("\n")[0]!.slice(0, 80);
        const s = store.createSession({ model, workspace, title });
        try {
          const { wt, cwd } = await wts.create(s.id, workspace, title, b.base);
          wts.adopt(s.id, wt);
          const next = store.updateSession(s.id, { workspace: cwd });
          bus.emit({ t: "session", session: next });
          if (b.text) engine.send(s.id, b.text, b.images ?? []);
          return json({ session: store.session(s.id), worktree: await wts.status(wts.get(s.id)!) }, 201);
        } catch (e) {
          store.deleteSession(s.id);
          throw e;
        }
      }),
    },
    "/api/worktrees/check": {
      GET: (req: any) => guard(async () => {
        const dir = new URL(req.url).searchParams.get("workspace") || deps.workspace;
        const repo = existsSync(dir) ? await wts.repoOf(dir) : null;
        return json({ git: !!repo, root: repo?.root ?? null });
      }),
    },
    "/api/sessions/:id/worktree": {
      GET: (req: any) => guard(async () => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const w = wts.get(req.params.id);
        return json({ worktree: w ? await wts.status(w) : null });
      }),
      DELETE: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        if (m.error) return m.error;
        if (engine.isRunning(m.s.id)) return bad("a turn is running; stop it first", 409);
        const r = await wts.remove(m.w, new URL(req.url).searchParams.has("snapshot"));
        emit(m.s.id);
        return json(r);
      }),
    },
    "/api/sessions/:id/worktree/park": {
      POST: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        if (m.error) return m.error;
        if (engine.isRunning(m.s.id)) return bad("a turn is running; stop it first", 409);
        const w = await wts.park(m.w);
        emit(m.s.id);
        return json({ worktree: await wts.status(w) });
      }),
    },
    "/api/sessions/:id/worktree/restore": {
      POST: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        if (m.error) return m.error;
        if (engine.isRunning(m.s.id)) return bad("a turn is running; stop it first", 409);
        const w = await wts.restore(m.w);
        emit(m.s.id);
        return json({ worktree: await wts.status(w) });
      }),
    },
    "/api/sessions/:id/pr": {
      GET: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        return m.error ?? json(await wts.pr(m.w));
      }),
      POST: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        if (m.error) return m.error;
        const b = await body(req);
        const r = await wts.openPr(m.w, { title: b.title || m.s.title || undefined, body: b.body, draft: !!b.draft });
        emit(m.s.id);
        return json(r, 201);
      }),
    },
    "/api/sessions/:id/changes/branch": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        return s ? json(await wts.branchDiff(s)) : bad("no such session", 404);
      }),
    },
    // Review comments on the branch diff go to the model as one message.
    "/api/sessions/:id/review": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        const b = await body(req);
        const comments = (Array.isArray(b.comments) ? b.comments : []).filter((c: any) => typeof c?.path === "string" && Number.isFinite(c.line) && String(c.text ?? "").trim());
        const note = String(b.note ?? "").trim();
        if (!comments.length && !note) return bad("no comments");
        const lines = comments.map((c: any) => `- ${c.path}:${c.line}: ${String(c.text).trim()}`);
        const text = [
          "Review of the branch diff.",
          note,
          lines.length ? `Comments by line:\n${lines.join("\n")}` : "",
          "Address each comment, then say in a few lines what you changed.",
        ].filter(Boolean).join("\n\n");
        return json({ event: engine.send(s.id, text) }, 201);
      }),
    },
  };
};
