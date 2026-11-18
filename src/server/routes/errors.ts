// The error tracker's routes: the list (open or resolved), a browser error
// posted by the page, and marking one kind of failure fixed.
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const errorRoutes: RouteModule = ({ store, errors, bus }) => ({
  "/api/errors": {
    GET: (req: Request) => {
      const r = new URL(req.url).searchParams.get("resolved");
      return json({ errors: store.errors(200, r === null ? {} : { resolved: r === "1" }) });
    },
    POST: async (req: Request) => {
      const b = (await req.json().catch(() => ({}))) as any;
      const err = Object.assign(new Error(String(b.message ?? "client error").slice(0, 2000)), { stack: b.stack });
      const rec = errors.capture("client", err, b.context);
      return json({ ok: true, id: rec.id }, 201);
    },
  },
  // { resolved: boolean }
  "/api/errors/:id": {
    PATCH: async (req: Request & { params: { id: string } }) => {
      const b = (await req.json().catch(() => null)) as { resolved?: unknown } | null;
      if (!b || typeof b.resolved !== "boolean") return json({ error: "resolved must be true or false" }, 400);
      const rec = store.resolveError(req.params.id, b.resolved);
      if (!rec) return json({ error: "no such error" }, 404);
      bus.emit({ t: "error", error: rec });
      return json({ record: rec });
    },
  },
  "/api/errors/resolve-all": {
    POST: () => {
      const open = store.errors(5000, { resolved: false });
      for (const e of open) bus.emit({ t: "error", error: store.resolveError(e.id, true)! });
      return json({ resolved: open.length });
    },
  },
});
