// Files the owner attaches to a prompt: stored once by content, sent per model
// (src/engine/attachments.ts). Not tied to a session, so a new session's first
// prompt can carry them too.
import { ATTACHMENT_MAX, attachmentPath, saveAttachmentStream, servedType, setAttachmentsRoot, TOO_LARGE } from "../../engine/attachments.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const attachmentRoutes: RouteModule = ({ store }) => {
  setAttachmentsRoot(store.stateDir);
  return {
    "/api/attachments": {
      POST: async (req: Request) => {
        const name = new URL(req.url).searchParams.get("name") || "file";
        // A declared length past the cap is refused before a byte is read; a body
        // that declares none, or lies, is refused where it passes the cap.
        if (Number(req.headers.get("content-length") ?? 0) > ATTACHMENT_MAX) return json({ error: TOO_LARGE }, 413);
        if (!req.body) return json({ error: "the file is empty" }, 400);
        const ct = req.headers.get("content-type") ?? "";
        const type = ct.split(";")[0]!.trim();
        const charset = /;\s*charset=([^;]+)/i.exec(ct)?.[1];
        // The body goes to the disk as it arrives, hashed on the way: never whole in memory.
        try {
          return json(await saveAttachmentStream(req.body, name, type, charset), 201);
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (!status) throw e;
          return json({ error: (e as Error).message }, status);
        }
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
