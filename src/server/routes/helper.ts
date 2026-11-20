// The owner's helper (src/helper/): its state, the remembered list, and a
// mail check on demand.
//   GET  /api/helper                 on, session, mail source, recent events
//   PUT  /api/helper                 { on?, mail_every_min?, wake_gap_min? }
//   POST /api/helper/check           look at new mail now
//   GET  /api/helper/memory          the remembered list
//   POST /api/helper/memory          { text, kind } added by the owner
//   PATCH/DELETE /api/helper/memory/:id
import { Helper } from "../../helper/helper.ts";
import { bindHelperTools } from "../../helper/tools.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const helperRoutes: RouteModule = (deps) => {
  const h = new Helper(deps);
  h.install();
  bindHelperTools(h);
  return {
    "/api/helper": {
      GET: () => json(h.view()),
      PUT: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        if (b.on !== undefined && typeof b.on !== "boolean") return json({ error: "on is true or false" }, 400);
        h.configure(b);
        if (b.on !== undefined) await h.setOn(b.on);
        return json(h.view());
      },
    },
    "/api/helper/check": { POST: async () => json(await h.runMailCheck()) },
    "/api/helper/memory": {
      GET: () => json({ items: h.memory() }),
      POST: async (req: Request) => json({ item: h.remember((await req.json().catch(() => ({}))) as any, "owner") }),
    },
    "/api/helper/memory/:id": {
      PATCH: async (req: any) => {
        if (!h.item(req.params.id)) return json({ error: "no such item" }, 404);
        return json({ item: h.remember({ ...((await req.json().catch(() => ({}))) as any), id: req.params.id }, "owner") });
      },
      DELETE: (req: any) => (h.forget(req.params.id) ? json({ ok: true }) : json({ error: "no such item" }, 404)),
    },
  };
};
