// GET /api/sessions/:id/pointer -> { pointer, id, title, state, last_reply }
//   What the message box puts into a prompt where the owner mentions another session:
//   a short pointer (src/core/pointer.ts), never its history. The last reply's first
//   line is read from the newest replies on the read thread, not the whole session.
import { firstLine, pointerText } from "../../core/pointer.ts";
import { seesOutside } from "../admission.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { board } from "./state.ts";

// A reply's own words: the text blocks of an assistant event's data.
export const textOf = (data: string): string => {
  try { return ((JSON.parse(data).blocks ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"); } catch { return ""; }
};

export const pointerRoutes: RouteModule = ({ store }) => ({
  "/api/sessions/:id/pointer": {
    GET: async (req: any) => {
      const s = store.session(req.params.id);
      if (!s || (s.outside && !seesOutside(req))) return Response.json({ error: "no such session" }, { status: 404 });
      const rows = await readsOf(store).sql<{ data: string }>("SELECT data FROM events WHERE session_id = ? AND kind = 'assistant' ORDER BY seq DESC LIMIT 8", [s.id]);
      const last = rows.map((r) => firstLine(textOf(r.data))).find(Boolean);
      const watch = board?.read(s.id)?.watch;
      return Response.json({ pointer: pointerText({ id: s.id, title: s.title || "", watch, last_reply: last }), id: s.id, title: s.title || "", state: watch ?? null, last_reply: last ?? null });
    },
  },
});
