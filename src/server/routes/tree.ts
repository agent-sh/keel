// The session as a tree of its prompts and summaries (every branch, the shown
// one marked), and labels on events: named places to come back to.
import { leafOf, lineage } from "../../core/tree.ts";
import type { StoredEvent } from "../../core/types.ts";
import type { RouteModule } from "../app.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_labels (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_labels_session ON event_labels(session_id);
`;

export const LABEL_MAX = 200;

type Label = { event_id: string; label: string; created_ms: number };

const json = (data: unknown, status = 200) => Response.json(data, { status });

// A prompt of the owner (an edit, a steer or a queued prompt included) or a summary.
const isNode = (e: StoredEvent) =>
  (e.kind === "user" && (!e.data.origin || e.data.origin === "steer" || e.data.origin === "queued")) ||
  (e.kind === "compaction" && e.data.mode === "summary");

const previewOf = (e: StoredEvent) =>
  e.kind === "compaction" ? "Summary of the context before it" : String(e.data.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || "(image)";

export const treeRoutes: RouteModule = ({ store }) => {
  store.migrate(SCHEMA);
  const labels = (sid: string): Label[] =>
    store.db.query<Label, [string]>("SELECT event_id, label, created_ms FROM event_labels WHERE session_id = ? ORDER BY created_ms").all(sid);

  return {
    "/api/sessions/:id/tree": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const all = store.events(s.id);
        const byId = new Map(all.map((e) => [e.id, e]));
        const shown = new Set(lineage(all, s.head).map((e) => e.id));
        const ls = labels(s.id);
        const lmap = new Map(ls.map((l) => [l.event_id, l.label]));
        const nodes = all.filter(isNode).map((e) => {
          // The node above: the nearest prompt or summary among its ancestors.
          let p = e.parent ? byId.get(e.parent) : undefined;
          while (p && !isNode(p)) p = p.parent ? byId.get(p.parent) : undefined;
          return {
            event_id: e.id, parent_event_id: p?.id ?? null, kind: e.kind === "user" ? "prompt" : "summary",
            preview: previewOf(e), ts_ms: e.ts, seq: e.seq, label: lmap.get(e.id) ?? null,
            active: shown.has(e.id), head_event_id: leafOf(all, e.id),
          };
        });
        // A label on a reply or another event is listed with what it says.
        const extra = ls.filter((l) => !nodes.some((n) => n.event_id === l.event_id)).map((l) => {
          const e = byId.get(l.event_id);
          const text = e?.kind === "assistant" ? (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
          return { ...l, preview: text.replace(/\s+/g, " ").trim().slice(0, 140), active: shown.has(l.event_id) };
        });
        return json({ head_event_id: s.head, nodes, labels: ls.map((l) => ({ ...l, ...extra.find((x) => x.event_id === l.event_id) })) });
      },
    },
    "/api/sessions/:id/events/:eid/label": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return json({ error: "no such session" }, 404);
        const e = store.event(req.params.eid);
        if (!e || e.session_id !== s.id) return json({ error: "no such event in this session" }, 404);
        const b = (await req.json().catch(() => ({}))) as any;
        const label = b.label == null ? "" : String(b.label).trim();
        if (label.length > LABEL_MAX) return json({ error: `a label holds at most ${LABEL_MAX} characters` }, 400);
        if (label) store.db.run("INSERT OR REPLACE INTO event_labels (event_id, session_id, label, created_ms) VALUES (?, ?, ?, ?)", [e.id, s.id, label, Date.now()]);
        else store.db.run("DELETE FROM event_labels WHERE event_id = ?", [e.id]);
        return json({ labels: labels(s.id) });
      },
    },
  };
};
