// File checkpoints: list the turns, the diff of a turn or of the session, and
// rewind files to a turn or revert single files.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { Bad, Checkpoints } from "../../safety/checkpoints.ts";
import { inside } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const guard = async (f: () => Promise<Response>) => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Bad) return bad(e.message, e.status);
    throw e;
  }
};

export let checkpoints: Checkpoints | undefined;

export const checkpointRoutes: RouteModule = (deps: Deps) => {
  const { store, engine, errors } = deps;
  const c = (checkpoints = new Checkpoints(store, deps.bus, errors, join(store.stateDir, "checkpoints")));
  const quiet = (at: string, f: () => unknown) =>
    Promise.resolve().then(f).catch((e) => void errors.capture("server", e, { at }));
  // A store that grew past its budget (or holds sessions that are gone) is trimmed soon after start.
  setTimeout(() => quiet("checkpoint maintenance", () => c.maintain()), 60_000).unref?.();
  // A session whose tools run on another machine has its folder there: nothing here to snapshot.
  registerHooks({
    beforeTool: async (s, call) => void (s.machine || (await quiet("checkpoint before", () => c.before(s, call)))),
    afterTool: (s, call) => (s.machine ? undefined : c.after(s, call)),
    turnEnd: async (s) => void (s.machine || (await quiet("checkpoint end", () => c.end(s)))),
  });

  // A restore while a turn runs in this workspace (this session or another)
  // would race the tools.
  const busy = (id: string, workspace: string) =>
    store.sessions().some((o) => engine.isRunning(o.id) && (o.id === id || inside(o.workspace, workspace) || inside(workspace, o.workspace)));

  return {
    "/api/sessions/:id/checkpoints": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const sh = c.shadow(s.workspace);
        return json({ turns: await c.turns(s), scope: sh.mode, reason: sh.reason ?? null, skipped: sh.skipped.slice(0, 50), skipped_count: sh.skipped.length });
      }),
    },
    "/api/sessions/:id/checkpoints/diff": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
        return json(await c.diff(s, { turn: num("turn"), from: num("from") }));
      }),
    },
    "/api/sessions/:id/changes/revert": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (busy(s.id, s.workspace)) return bad("a turn is running in this workspace; stop it first", 409);
        if (typeof b.path !== "string" || !Number.isInteger(b.hunk?.index) || typeof b.hunk?.header !== "string" || !Number.isFinite(b.from)) return bad("give path, hunk { index, header } and from (the turn)");
        if (b.path.startsWith("/") || b.path.split("/").includes("..")) return bad("the path is relative to the workspace and stays inside it");
        return json(await c.revertHunk(s, { from: Number(b.from), path: b.path, index: b.hunk.index, header: b.hunk.header }));
      }),
    },
    "/api/sessions/:id/rewind": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (!b.preview && busy(s.id, s.workspace)) return bad("a turn is running in this workspace; stop it first", 409);
        const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string") : undefined;
        return json(await c.rewind(s, { turn: b.turn, checkpoint: b.checkpoint, paths, preview: !!b.preview, includeOutside: !!b.include_outside }));
      }),
    },
  };
};
