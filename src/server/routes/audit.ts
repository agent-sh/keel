// GET /api/audit/verify?session=ID, /api/audit/bundle?session=ID, /api/audit/roots
// The sealed record (src/core/seal.ts): whether a session's history is whole and where it breaks, its
// receipts as one file that verifies alone, and the days' roots held against the copies kept outside the
// store (src/admin/seal.ts). The reads run on the read thread; the daily root is made here, off a timer.
import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadRoots, rootsPath, SealRoots } from "../../admin/seal.ts";
import { settings } from "../../admin/settings.ts";
import { runMode } from "../../core/runmode.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
let roots: SealRoots | undefined;

// The roots the files outside the store hold, by day: the roots file, and the mirror when it is set. Read on
// the thread pool with a time limit (a mirror on a stale mount must not hold the daemon). null: no such file;
// undefined: it could not be read in time.
type Kept = Record<string, string> | null | undefined;
async function keptRoots(stateDir: string): Promise<{ file: Kept; mirror: Kept; mirrorSet: boolean }> {
  const by = async (path: string): Promise<Kept> => {
    try { const r = await loadRoots(path); return r ? Object.fromEntries(r.map((x) => [x.day, x.root])) : null; } catch { return undefined; }
  };
  const m = String(settings().seal?.mirror ?? "");
  const [file, mirror] = await Promise.all([by(rootsPath(stateDir)), m ? by(m) : Promise.resolve(null)]);
  return { file, mirror, mirrorSet: !!m };
}

// A bundle is written by the read thread to a file of its own and streamed from it; the file goes when the stream ends.
const BUNDLE_STALE_MS = 3_600_000;
function sweepBundles(dir: string) {
  try { for (const f of readdirSync(dir)) { const p = join(dir, f); if (Date.now() - statSync(p).mtimeMs > BUNDLE_STALE_MS) unlinkSync(p); } } catch {}
}

export const auditRoutes: RouteModule = ({ store, errors }) => {
  roots?.stop();
  roots = new SealRoots(store, (e, what) => errors.capture("server", e as Error, { at: what }));
  // (A command's own short-lived daemon makes no root: only a served one does.)
  if (!runMode.client) roots.start();
  const session = (req: Request) => new URL(req.url).searchParams.get("session") ?? "";
  return {
    "/api/audit/verify": {
      GET: async (req: Request) => {
        const id = session(req);
        if (!id) return json({ error: "session is required" }, 400);
        const k = await keptRoots(store.stateDir);
        const v = await readsOf(store).run("seal.verify", { session: id, roots: k.file ?? null });
        if (!v.found && !v.counts.events && !v.counts.cards && !v.counts.egress) return json({ error: `no session ${id}` }, 404);
        // A mirror that differs from the store is the same finding as a roots file that does.
        if (k.mirror === undefined && k.mirrorSet) v.notes.push("the mirror could not be read in time: the roots were not held against it");
        const off = k.mirror && v.anchors.find((a) => k.mirror![a.day] !== a.root);
        if (off) { v.ok = false; off.ok = false; off.why ??= "the day's root differs from the mirror's"; }
        return json(v);
      },
    },
    "/api/audit/bundle": {
      GET: async (req: Request) => {
        const id = session(req);
        if (!id) return json({ error: "session is required" }, 400);
        const dir = join(store.stateDir, "seal", "bundles");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        sweepBundles(dir);
        const path = join(dir, `${crypto.randomUUID()}.json`);
        let made: { bytes: number } | null;
        try { made = await readsOf(store).run("seal.bundle", { session: id, path }); } catch (e) { try { unlinkSync(path); } catch {} throw e; }
        if (!made) return json({ error: `no session ${id}` }, 404);
        const file = createReadStream(path);
        file.once("close", () => { try { unlinkSync(path); } catch {} });
        return new Response(Readable.toWeb(file) as unknown as ReadableStream, { headers: { "content-type": "application/json", "content-length": String(made.bytes) } });
      },
    },
    "/api/audit/roots": {
      GET: async () => {
        const k = await keptRoots(store.stateDir);
        const kept = k.file ? Object.entries(k.file).map(([day, root]) => ({ day, root })) : null;
        const r = await readsOf(store).run("seal.roots", { kept });
        const mirror = k.mirror ? Object.entries(k.mirror).filter(([day, root]) => r.roots.find((x) => x.day === day)?.root !== root).map(([day]) => day) : null;
        return json({ ...r, ok: r.ok && !mirror?.length, file: rootsPath(store.stateDir), file_found: !!k.file, file_unread: k.file === undefined, mirror_unread: k.mirror === undefined && k.mirrorSet, mirror: settings().seal?.mirror || null, mirror_differs: mirror });
      },
      // Makes the root now when it is due (a start that missed its time, a test).
      POST: async () => json({ made: (await roots?.tick()) ?? null }),
    },
  };
};
