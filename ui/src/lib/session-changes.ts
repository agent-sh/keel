// What a session changed, as the Changes panel reads it (its checkpoints, and the diff from its first turn in this
// folder): the files and the lines, for the line above the message box. Read when the session is shown, when a turn
// ends, and (a moment after the last of them) when the daemon says its checkpoints moved.
import { useEffect, useState } from "react";
import { api, onFeature, reportUnlessGone, useStore } from "./store.ts";

export type Changed = { files: number; added: number; removed: number };
type Turn = { turn: number; elsewhere?: string };
type Diff = { files: { added: number; removed: number }[] };

export function useChanged(sessionId: string): Changed | null {
  const [changed, setChanged] = useState<Changed | null>(null);
  const idle = useStore((s) => s.sessions[sessionId]?.phase === "idle");
  useEffect(() => {
    let stop = false, timer: Timer | undefined, asked = 0;
    const load = async () => {
      const mine = ++asked;
      try {
        const r = await api<{ turns: Turn[] }>(`/api/sessions/${sessionId}/checkpoints`);
        const first = r.turns.find((t) => !t.elsewhere)?.turn;
        const d = first === undefined ? null : await api<Diff>(`/api/sessions/${sessionId}/checkpoints/diff?from=${first}`);
        if (stop || mine !== asked) return;
        setChanged(d && d.files.length ? { files: d.files.length, added: d.files.reduce((n, f) => n + f.added, 0), removed: d.files.reduce((n, f) => n + f.removed, 0) } : null);
      } catch (e) { reportUnlessGone(e, { at: "changes line" }); }
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 1000); };
    void load();
    const off = onFeature({ frame: (f) => { if (f.name === "checkpoints" && f.session_id === sessionId) soon(); }, reconnect: () => void load() });
    return () => { stop = true; clearTimeout(timer); off(); };
  }, [sessionId, idle]);
  return changed;
}
