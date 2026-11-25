// The owner's helper (src/helper/): its state, the remembered list, and a
// mail check on demand.
//   GET  /api/helper                 on, session, mail source, recent events
//   PUT  /api/helper                 { on?, mail_every_min?, wake_gap_min?, answer_cards?, name? } (name: "" or null: the default again)
//   GET  /api/helper/answers         { answers }: the approval cards the helper answered on the owner's standing instruction, newest first
//   POST /api/helper/check           look at new mail now
//   POST /api/helper/ask             { text, key? } a question from the helper row on a phone: { id, chat_id }
//   GET  /api/helper/ask/:id         its answer: state, words, the sessions it read and what each waits on
//   GET  /api/helper/avatar          the kept picture (404: none)
//   POST /api/helper/avatar          the bytes of a PNG, JPEG or WebP picture as the body: kept (scaled to fit); DELETE removes it
//   GET  /api/helper/avatar/models   { models, failed }: the image models of the owner's providers (found from the
//                                    listings and the catalog) and the providers that could not be asked
//   POST /api/helper/avatar/make     { prompt, model, n? } a few pictures to pick from (the helper view's candidates)
//   GET  /api/helper/avatar/candidates/:id   one of them
//   POST /api/helper/avatar/pick     { id } the picture kept
//   GET  /api/helper/keel-repo       { repo: { dir, from, commit? } } or { problem }, and setting (helper.keel_repo): the folder an agent started on a bug of Keel works in
//   GET  /api/helper/looks           the helper's looks at errors, newest first
//   POST /api/helper/looks/:cause/ask   look now (or again), whatever the hour's count
//   GET  /api/helper/memory          the memory's records (?q= finds keys by alias, topic, prefix or words)
//   POST /api/helper/memory          { key?, value, kind?, aliases?, topics? } added by the owner
//   PATCH/DELETE /api/helper/memory/:key  (PATCH may carry a new key)
import { settings } from "../../admin/settings.ts";
import { keelRepo } from "../../core/keel-source.ts";
import { askId } from "../../helper/ask.ts";
import { Helper } from "../../helper/helper.ts";
import { paramKey } from "../../helper/memory.ts";
import { UPLOAD_BYTES } from "../../helper/persona.ts";
import { ModelLookupError } from "../../providers/registry.ts";
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
        try {
          if (b.name !== undefined) h.setName(b.name);
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
        try {
          h.configure(b);
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
        if (b.on !== undefined) await h.setOn(b.on);
        return json(h.view());
      },
    },
    "/api/helper/answers": { GET: () => json({ answers: h.answers() }) },
    "/api/helper/keel-repo": { GET: () => json({ ...keelRepo(), setting: settings().helper?.keel_repo ?? null }) },
    "/api/helper/avatar": {
      GET: () => {
        const f = h.avatarFile();
        const bytes = f && h.files.read(f.path);
        return bytes ? new Response(bytes as unknown as BodyInit, { headers: { "content-type": f.type, "cache-control": "private, max-age=31536000, immutable" } }) : json({ error: "no picture" }, 404);
      },
      POST: async (req: Request) => {
        if (Number(req.headers.get("content-length") ?? 0) > UPLOAD_BYTES) return json({ error: "the picture is over 10 MB" }, 413);
        try {
          return json(await h.uploadAvatar(new Uint8Array(await req.arrayBuffer())));
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
      },
      DELETE: () => json(h.removeAvatar()),
    },
    "/api/helper/avatar/models": { GET: async () => json(await h.images()) },
    "/api/helper/avatar/make": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        try {
          return json(await h.makeAvatars(b, AbortSignal.any([req.signal, AbortSignal.timeout(300_000)])));
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? (e instanceof ModelLookupError ? 409 : 502));
        }
      },
    },
    "/api/helper/avatar/candidates/:id": {
      GET: (req: any) => {
        const c = h.persona().candidates?.find((x) => x.id === String(req.params.id));
        const bytes = c && h.files.read(h.files.candidatePath(c));
        return bytes ? new Response(bytes as unknown as BodyInit, { headers: { "content-type": h.files.type(c.ext), "cache-control": "private, max-age=3600" } }) : json({ error: "no such picture" }, 404);
      },
    },
    "/api/helper/avatar/pick": {
      POST: async (req: Request) => {
        const b = (await req.json().catch(() => ({}))) as any;
        try {
          return json(h.pickAvatar(b.id));
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
      },
    },
    "/api/helper/looks": { GET: () => json({ looks: h.looks.list() }) },
    "/api/helper/looks/:cause/ask": {
      POST: async (req: any) => {
        try {
          const l = await h.looks.ask(String(req.params.cause));
          return l ? json({ look: l }) : json({ error: "no such look" }, 404);
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, e?.status ?? 500);
        }
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
