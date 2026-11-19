// Files the owner attaches to a prompt: stored once by content, sent per model
// (src/engine/attachments.ts). Not tied to a session, so a new session's first
// prompt can carry them too.
import { readFileSync } from "node:fs";
import { ATTACHMENT_MAX, attachmentPath, saveAttachment, setAttachmentsRoot } from "../../engine/attachments.ts";
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
        const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
        return json(saveAttachment(bytes, name, type), 201);
      },
    },
    "/api/attachments/:id": {
      GET: (req: any) => {
        const path = attachmentPath(req.params.id);
        if (!path) return json({ error: "no such attachment" }, 404);
        const name = path.split("/").pop()!;
        const type = Bun.file(path).type || "application/octet-stream";
        return new Response(readFileSync(path), {
          headers: {
            "content-type": type,
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox; default-src 'none'",
            ...(/^image\/(png|jpeg|gif|webp)$/.test(type) ? {} : { "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"` }),
          },
        });
      },
    },
  };
};
