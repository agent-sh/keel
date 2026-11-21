// Worktree sessions, park and restore, pull requests, the branch diff, and
// review comments sent back to the model.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { folderUse, inUse as folderInUse } from "../inuse.ts";
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
  // What would break if a session's folder went or moved now (src/server/inuse.ts):
  // a turn there, another session working in it, a background command in it.
  const usage = (id: string) => {
    const s = store.session(id), w = wts.get(id);
    const dir = w?.state === "active" ? w.path : s?.workspace;
    return dir ? folderUse(store, (x) => engine.isRunning(x), dir, id) : { others: [], jobs: [], turns: [] };
  };
  const busy = (id: string) => { const u = usage(id); return u.turns.length > 0 || u.others.length > 0 || u.jobs.length > 0; };
  const inUse = (id: string, stopShells: boolean, what: string) => folderInUse(usage(id), id, { stopShells, what, others: true });
  const emit = (id: string) => bus.emit({ t: "feature", name: "worktree", session_id: id, data: { changed: true } });
  const keep = () => { const n = Number(store.db.query<{ value: string }, []>("SELECT value FROM perm_settings WHERE key = 'worktree_keep'").get()?.value ?? process.env.KEEL_WORKTREE_KEEP ?? 15); return Number.isFinite(n) && n >= 0 ? n : 15; };
  // Retention runs at start and after each new worktree; failures are captured, never fatal.
  const sweep = () => wts.prune(keep(), busy).then((r) => { for (const id of r.removed) emit(id); return r; });
  sweep().catch((e) => deps.errors.capture("server", e, { at: "worktree prune" }));

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
          sweep().catch((e) => deps.errors.capture("server", e, { at: "worktree prune" }));
          const next = store.updateSession(s.id, { workspace: cwd });
          bus.emit({ t: "session", session: next });
          // Images alone are a message too, as in the plain create.
          if (b.text || b.images?.length) engine.send(s.id, String(b.text ?? "").trim(), { images: b.images ?? [] });
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
    "/api/worktrees/prune": {
      POST: (req: any) => guard(async () => {
        const b = await body(req);
        const n = b.keep === undefined ? keep() : Math.floor(Number(b.keep));
        if (!(n >= 0)) return bad("keep is a number of worktrees, 0 or more");
        return json(await wts.prune(n, busy));
      }),
    },
    "/api/worktrees/settings": {
      GET: () => json({ keep: keep() }),
      PUT: async (req: any) => {
        const b = await body(req);
        const n = Math.floor(Number(b.keep));
        if (!(n >= 0 && n <= 1000)) return bad("keep is a number from 0 to 1000");
        store.db.query("INSERT INTO perm_settings (key, value) VALUES ('worktree_keep', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
        return json({ keep: keep() });
      },
    },
    // Move the session between its main checkout and a worktree, with its uncommitted work.
    "/api/sessions/:id/worktree/handoff": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        // Into a worktree the main checkout stays; back to main the worktree's folder goes.
        if (b.to !== "main" && engine.isRunning(s.id)) return bad("a turn is running; stop it first", 409);
        const held = b.to === "main" ? await inUse(s.id, !!b.stop_shells, "moved") : null;
        if (held) return held;
        const w = wts.get(s.id);
        if (b.to === "worktree") {
          const r = await wts.toWorktree(s);
          wts.adopt(s.id, r.wt);
          const next = store.updateSession(s.id, { workspace: r.cwd });
          bus.emit({ t: "session", session: next });
          bus.emit({ t: "event", event: store.append(s.id, "note", { kind: "handoff", text: `Moved to a worktree on branch ${r.wt.branch}${r.moved ? `, with ${r.moved} changed file${r.moved === 1 ? "" : "s"}` : ""}. The main checkout is back at its last commit.` }) });
          emit(s.id);
          return json({ session: next, worktree: await wts.status(wts.get(s.id)!), moved: r.moved });
        }
        if (b.to === "main") {
          if (!w || w.state !== "active") return bad("the session has no active worktree");
          const r = await wts.toMain(w, s);
          const next = store.updateSession(s.id, { workspace: r.cwd });
          bus.emit({ t: "session", session: next });
          bus.emit({ t: "event", event: store.append(s.id, "note", { kind: "handoff", text: `Moved to the main checkout, now on branch ${r.branch}${r.previous ? ` (it was on ${r.previous})` : ""}${r.moved ? `, with ${r.moved} changed file${r.moved === 1 ? "" : "s"}` : ""}.` }) });
          emit(s.id);
          return json({ session: next, branch: r.branch, previous: r.previous, moved: r.moved });
        }
        return bad('to is "worktree" or "main"');
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
        const q = new URL(req.url).searchParams;
        const held = await inUse(m.s.id, q.has("stop_shells"), "removed");
        if (held) return held;
        const r = await wts.remove(m.w, q.has("snapshot"));
        emit(m.s.id);
        return json(r);
      }),
    },
    "/api/sessions/:id/worktree/park": {
      POST: (req: any) => guard(async () => {
        const m = managed(req.params.id);
        if (m.error) return m.error;
        const held = await inUse(m.s.id, !!(await body(req)).stop_shells, "parked");
        if (held) return held;
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
        const paths = new URL(req.url).searchParams.getAll("path").filter((p) => p && !p.startsWith("/") && !p.split("/").includes(".."));
        return s ? json(await wts.branchDiff(s, paths.length ? paths : undefined)) : bad("no such session", 404);
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
        // Each comment names its side (a removed line is the old file's line)
        // and the text it was written on, so a line that moved is not mistaken
        // for another; one the diff no longer holds is said to be outdated.
        const lines = comments.map((c: any) => {
          const where = c.side === "old" ? `${c.path}, removed line ${c.line} (old file)` : `${c.path}:${c.line}`;
          const quote = typeof c.quote === "string" ? c.quote.slice(0, 300) : "";
          const on = !quote ? "" : c.outdated ? `\n  (outdated: that line changed since; the comment was written on \`${quote}\`)` : `\n  on: \`${quote}\``;
          return `- ${where}: ${String(c.text).trim()}${on}`;
        });
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
