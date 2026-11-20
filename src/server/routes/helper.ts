// The owner's helper (src/helper/): its state, the remembered list, and a
// mail check on demand.
//   GET  /api/helper                 on, session, mail source, recent events
//   PUT  /api/helper                 { on?, mail_every_min?, wake_gap_min? }
//   POST /api/helper/check           look at new mail now
//   GET  /api/helper/memory          the memory's records (?q= finds keys by alias, topic, prefix or words)
//   POST /api/helper/memory          { key?, value, kind?, aliases?, topics? } added by the owner
//   PATCH/DELETE /api/helper/memory/:key  (PATCH may carry a new key)
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
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams.get("q")?.trim();
        if (!q) return json({ items: h.memory() });
        const f = h.records.index.find(q, 200);
        return json({ items: f.hits.map((x) => h.records.index.byKey.get(x.key)!), total: f.total });
      },
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        if (b.key && h.records.index.get(String(b.key))) return json({ error: `a record ${h.records.index.get(String(b.key))!.key} exists: edit it instead` }, 409);
        return json({ item: h.records.put([b], "owner")[0] });
      },
    },
    "/api/helper/memory/:key": {
      PATCH: async (req: any) => json({ item: h.records.edit(decodeURIComponent(req.params.key), (await req.json().catch(() => ({}))) as any) }),
      DELETE: (req: any) => (h.records.drop([decodeURIComponent(req.params.key)]).length ? json({ ok: true }) : json({ error: "no such record" }, 404)),
    },
  };
};
