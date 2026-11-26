// The error tracker's routes: the list (open or resolved, read or unread, of
// every session or of one, with that session's grouped failures), a
// browser error posted by the page, and marking one kind of failure fixed or read.
import { recordOf } from "../../automation/failures.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const errorRoutes: RouteModule = ({ store, errors: tracker, bus }) => {
  const errors = tracker;
  const allSeen = async (req: Request, what: "resolve" | "read") => {
    const b = (await req.json().catch(() => null)) as { seen?: { id: string; count: number }[] } | null;
    const open = store.errors(5000, what === "resolve" ? { resolved: false } : { resolved: false, read: false });
    const seen = Array.isArray(b?.seen) ? new Map(b.seen.map((x) => [String(x.id), Number(x.count)])) : undefined;
    const changed: string[] = [];
    let n = 0;
    for (const e of open) {
      if (seen && !seen.has(e.id)) continue;
      if (seen && seen.get(e.id) !== (e.count ?? 1)) { changed.push(e.id); continue; }
      if (what === "resolve") errors.resolve(e.id, true); else store.readError(e.id, true);
      bus.emit({ t: "error", error: errors.get(e.id)! });
      n++;
    }
    return json({ [what === "resolve" ? "resolved" : "read"]: n, changed });
  };
  return {
    "/api/errors": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const flag = (k: string) => (q.get(k) === null ? undefined : q.get(k) === "1");
        // ?session=: what went wrong in that session's scope. `errors` are the
        // kinds that happened in it or in its agents (each with every session
        // it happened in: `sites`); `failures` is its own
        // grouped record (one row per cause, with counts and where), the same
        // one its model is told from.
        const session = q.get("session") ?? undefined;
        // The failures the store could not take (its disk is full, or it takes no writes) lead the open list.
        const waiting = flag("resolved") === true || flag("read") === true ? [] : tracker.unwritten(session);
        const list = [...waiting, ...errors.list(200, { resolved: flag("resolved"), read: flag("read"), session })];
        return json(session ? { errors: list, failures: recordOf(store, session) } : { errors: list });
      },
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        const rec = errors.captureClient(String(b.message ?? "client error"), b.stack, b.context);
        return rec ? json({ ok: true, id: rec.id }, 201) : json({ ok: true, ignored: true });
      },
    },
    // { resolved?: boolean, read?: boolean }
    "/api/errors/:id": {
      PATCH: async (req: Request & { params: { id: string } }) => {
        const b = (await req.json().catch(() => null)) as { resolved?: unknown; read?: unknown } | null;
        const ok = (v: unknown) => v === undefined || typeof v === "boolean";
        if (!b || (b.resolved === undefined && b.read === undefined) || !ok(b.resolved) || !ok(b.read)) return json({ error: "resolved or read must be true or false" }, 400);
        // One the store never took is only in memory: seen or resolved, it is let go.
        if (req.params.id.startsWith("unwritten-")) {
          const gone = tracker.dismiss(req.params.id);
          return gone ? json({ record: gone }) : json({ error: "no such error" }, 404);
        }
        if (!store.error(req.params.id)) return json({ error: "no such error" }, 404);
        if (typeof b.resolved === "boolean") errors.resolve(req.params.id, b.resolved);
        if (typeof b.read === "boolean") store.readError(req.params.id, b.read);
        const rec = errors.get(req.params.id)!;
        bus.emit({ t: "error", error: rec });
        return json({ record: rec });
      },
    },
    // { seen: [{ id, count }] }: resolve (or mark read) the kinds the owner saw,
    // as they were seen. A kind that happened again since (its count moved)
    // stays as it was and is named in `changed`. With no body every open
    // (unread) kind is changed.
    "/api/errors/resolve-all": { POST: (req: Request) => allSeen(req, "resolve") },
    "/api/errors/read-all": { POST: (req: Request) => allSeen(req, "read") },
  };
};
