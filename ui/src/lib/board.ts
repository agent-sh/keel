// The work board of a session's tree (src/board/board.ts): read when the Board panel shows the
// session, again when an agent of its tree changes state or its repository's landing queue moves,
// and on the owner's Refresh. Nothing is read while the panel is closed.
import { useEffect, useSyncExternalStore } from "react";
import type { Board, BoardRow } from "../../../src/board/rules.ts";
import { useAuto } from "./automation.ts";
import { api, onFeature, reportUnlessGone } from "./store.ts";

export type { Board, BoardRow };

let byId: Record<string, Board | undefined> = {};
const shown = new Map<string, number>(); // sessions a panel shows, by how many
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const reading = new Map<string, Promise<void>>();

export function loadBoard(id: string, fresh = false): Promise<void> {
  const out = reading.get(id);
  if (out && !fresh) return out;
  const read = (async () => {
    const b = await api<Board>(`/api/sessions/${id}/board${fresh ? "?fresh=1" : ""}`);
    byId = { ...byId, [id]: b };
    changed();
  })().finally(() => { if (reading.get(id) === read) reading.delete(id); });
  reading.set(id, read);
  return read;
}

// The agents of the tree as the page knows them, as one word: it changes when one starts, ends or changes state.
function useTreeMark(root: string): string {
  return useAuto((s) => {
    const kids = new Map<string, { id: string; session_id: string; status: string; ended?: number | null }[]>();
    for (const a of Object.values(s.agents)) kids.set(a.parent_id, [...(kids.get(a.parent_id) ?? []), a]);
    const out: string[] = [];
    const walk = (sid: string, depth: number) => {
      if (depth > 12) return;
      for (const a of kids.get(sid) ?? []) { out.push(`${a.id}:${a.status}:${a.ended ?? ""}`); walk(a.session_id, depth + 1); }
    };
    walk(root, 0);
    return out.sort().join(",");
  });
}

export function useBoard(id: string): Board | undefined {
  const mark = useTreeMark(id);
  useEffect(() => {
    shown.set(id, (shown.get(id) ?? 0) + 1);
    return () => { const n = (shown.get(id) ?? 1) - 1; if (n > 0) shown.set(id, n); else shown.delete(id); };
  }, [id]);
  // (A change of the tree reads the board again a moment later: several agents often end together.)
  useEffect(() => {
    const t = setTimeout(() => loadBoard(id, true).catch(reportUnlessGone), byId[id] ? 600 : 0);
    return () => clearTimeout(t);
  }, [id, mark]);
  return useSyncExternalStore(subscribe, () => byId[id]);
}

onFeature({
  frame(f) {
    if (f.name === "landing" && f.session_id && shown.has(f.session_id)) loadBoard(f.session_id, true).catch(reportUnlessGone);
  },
  reconnect() {
    for (const id of shown.keys()) loadBoard(id, true).catch(reportUnlessGone);
  },
});
