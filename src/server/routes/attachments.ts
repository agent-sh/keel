// Files the owner attaches to a prompt: stored once by content, sent per model
// (src/engine/attachments.ts). Not tied to a session, so a new session's first
// prompt can carry them too.
import { ATTACHMENT_MAX, attachmentPath, saveAttachment, servedType, setAttachmentsRoot } from "../../engine/attachments.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const attachmentRoutes: RouteModule = ({ store }) => {
  setAttachmentsRoot(store.stateDir);
  return {
    "/api/attachments": {
      POST: async (req: Request) => {
        const name = new URL(req.url).searchParams.get("name") || "file";
        const len = Number(req.headers.get("content-length") ?? 0);
        if (len > ATTACHMENT_MAX) return json({ error: `a file can be at most ${ATTACHMENT_MAX / 1024 / 1024} MiB` }, 413);
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.byteLength) return json({ error: "the file is empty" }, 400);
        if (bytes.byteLength > ATTACHMENT_MAX) return json({ error: `a file can be at most ${ATTACHMENT_MAX / 1024 / 1024} MiB` }, 413);
        const ct = req.headers.get("content-type") ?? "";
        const type = ct.split(";")[0]!.trim();
        const charset = /;\s*charset=([^;]+)/i.exec(ct)?.[1];
        return json(saveAttachment(bytes, name, type, charset), 201);
      },
    },
    "/api/attachments/:id": {
      // `name` and `type`: the prompt's own reference (one content can be two
      // files with two names); the download is named as that prompt named it.
      GET: (req: any) => {
        const path = attachmentPath(req.params.id);
        if (!path) return json({ error: "no such attachment" }, 404);
        const q = new URL(req.url).searchParams;
        const name = (q.get("name") || path.split("/").pop()!).replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 120);
        const type = servedType(path, name, q.get("type") ?? undefined);
        const ascii = name.replace(/[^\x20-\x7e]/g, "_");
        // The file is the body: it is sent from the disk as the client reads it,
        // not read whole first (a slice, since a whole Bun.file adds a
        // content-disposition with its name on disk). A range is answered too.
        return new Response(Bun.file(path).slice(), {
          headers: {
            "content-type": type,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox; default-src 'none'",
            ...(/^image\/(png|jpeg|gif|webp)$/.test(type) ? {} : { "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}` }),
          },
        });
      },
    },
  };
};
