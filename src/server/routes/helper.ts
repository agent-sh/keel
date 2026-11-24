// The owner's helper (src/helper/): its state, the remembered list, and a
// mail check on demand.
//   GET  /api/helper                 on, session, mail source, recent events
//   PUT  /api/helper                 { on?, mail_every_min?, wake_gap_min? }
//   POST /api/helper/check           look at new mail now
//   POST /api/helper/ask             { text, key? } a question from the helper row on a phone: { id, chat_id }
//   GET  /api/helper/ask/:id         its answer: state, words, the sessions it read and what each waits on
//   GET  /api/helper/memory          the memory's records (?q= finds keys by alias, topic, prefix or words)
//   POST /api/helper/memory          { key?, value, kind?, aliases?, topics? } added by the owner
//   PATCH/DELETE /api/helper/memory/:key  (PATCH may carry a new key)
import { askId } from "../../helper/ask.ts";
import { Helper } from "../../helper/helper.ts";
import { paramKey } from "../../helper/memory.ts";
import { bindHelperTools } from "../../helper/tools.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

// The helper of this daemon, for the phone's API (/v1/helper, src/integrations/mobile/v1.ts).
export let helperNow: (() => Helper) | undefined;

export const helperRoutes: RouteModule = (deps) => {
  const h = new Helper(deps);
  h.install();
  helperNow = () => h;
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
    "/api/helper/ask": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        if (typeof b.text !== "string" || !b.text.trim()) return json({ error: "give text: the question" }, 400);
        if (b.key !== undefined && (typeof b.key !== "string" || !b.key || b.key.length > 100)) return json({ error: "key is a string of at most 100 characters" }, 400);
        try {
          return json(await h.ask(b.text, "page", b.key));
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
      },
    },
    "/api/helper/ask/:id": {
      GET: async (req: any) => {
        const a = await h.answer(askId(String(req.params.id)));
        if (!a) return json({ error: "no such question" }, 404);
        return json({ ...a, read: a.read.map((r) => ({ id: r.id, title: r.title || "(untitled)", waits: a.waits[r.id] ?? 0 })), waits: undefined });
      },
    },
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
      PATCH: async (req: any) => {
        const key = paramKey(req.params.key);
        if (key === null) return json({ error: "the key is not a URL-encoded key" }, 400);
        return json({ item: h.records.edit(key, (await req.json().catch(() => ({}))) as any) });
      },
      DELETE: (req: any) => {
        const key = paramKey(req.params.key);
        if (key === null) return json({ error: "the key is not a URL-encoded key" }, 400);
        return h.records.forget(key) ? json({ ok: true }) : json({ error: "no such record" }, 404);
      },
    },
  };
};
