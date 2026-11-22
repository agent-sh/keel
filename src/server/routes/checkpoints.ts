// File checkpoints: list the turns, the diff of a turn or of the session, and
// rewind files to a turn or revert single files.
import { join } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { Bad, Checkpoints } from "../../safety/checkpoints.ts";
import { folderUse, inUse } from "../inuse.ts";
import type { Deps, RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

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
    afterTool: async (s, call) => void (s.machine || (await quiet("checkpoint after", () => c.after(s, call)))),
    turnEnd: async (s) => void (s.machine || (await quiet("checkpoint end", () => c.end(s)))),
  });

  // A restore while the folder is in use would race what writes there: a turn
  // in or around it (this session's or another's), or a background command of
  // any session whose folder overlaps it (its late write would undo the
  // restore). The owner can have the commands stopped with it (stop_shells).
  // Other idle sessions in the folder do not hold it.
  const held = (s: { id: string; workspace: string }, stopShells: boolean) =>
    inUse(folderUse(store, (x) => engine.isRunning(x), s.workspace, s.id), s.id, { stopShells, what: "rewound", others: false });

  return {
    "/api/sessions/:id/checkpoints": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const sh = c.shadow(s.workspace);
        const { turns, expired } = await c.turns(s);
        // `n`: the turn's place among the session's turns (its first is 1), the number its Tokens panel and
        // `keel cost` give it; `turn` is its start's place in the history, the one a rewind and a diff take.
        // (The starts alone, from the index that holds only those columns, on the read thread.)
        const starts = turns.length ? (await readsOf(store).sql<{ seq: number }>("SELECT seq FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = 'turn_start' ORDER BY seq", [s.id])).map((r) => r.seq) : [];
        const place = new Map(starts.map((seq, i) => [seq, i + 1]));
        return json({ turns: turns.map((t) => (place.has(t.turn) ? { ...t, n: place.get(t.turn) } : t)), expired, scope: sh.mode, reason: sh.reason ?? null, skipped: sh.skipped.slice(0, 50), skipped_count: sh.skipped.length });
      }),
    },
    "/api/sessions/:id/checkpoints/diff": {
      GET: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
        const paths = q.getAll("path").filter((p) => p && !p.startsWith("/") && !p.split("/").includes(".."));
        return json(await c.diff(s, { turn: num("turn"), from: num("from"), paths: paths.length ? paths : undefined }));
      }),
    },
    "/api/sessions/:id/changes/revert": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
        const h = await held(s, !!b.stop_shells);
        if (h) return h;
        if (typeof b.path !== "string" || !Number.isInteger(b.hunk?.index) || typeof b.hunk?.header !== "string" || typeof b.hunk?.body !== "string" || !Number.isFinite(b.from)) return bad("give path, hunk { index, header, body } and from (the turn)");
        if (b.path.startsWith("/") || b.path.split("/").includes("..")) return bad("the path is relative to the workspace and stays inside it");
        return json(await c.revertHunk(s, { from: Number(b.from), path: b.path, index: b.hunk.index, header: b.hunk.header, body: b.hunk.body }));
      }),
    },
    "/api/sessions/:id/rewind": {
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (s.workspace_gone) return bad("the session's folder is gone; move the session to a folder that exists first", 409);
        const h = b.preview ? null : await held(s, !!b.stop_shells);
        if (h) return h;
        const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string") : undefined;
        const confirm = Array.isArray(b.confirm?.paths) && b.confirm.versions && typeof b.confirm.versions === "object"
          ? { paths: b.confirm.paths.filter((p: unknown) => typeof p === "string"), versions: b.confirm.versions as Record<string, string> } : undefined;
        return json(await c.rewind(s, { turn: b.turn, checkpoint: b.checkpoint, paths, preview: !!b.preview, includeOutside: !!b.include_outside, confirm }));
      }),
    },
  };
};
