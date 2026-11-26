// Your asks (src/board/asks.ts): the owner's asks of a top-level session, read when the panel shows it and
// again when its history, its head or its tree moves; their states come from the work board's rows, so they
// move when the board does. Nothing is read while the panel is closed.
import { useEffect, useRef, useState } from "react";
import type { Ask } from "../../../src/board/asks.ts";
import { useTreeMark } from "./board.ts";
import { api, reportUnlessGone, useStore } from "./store.ts";

export type { Ask };

export function useAsks(id: string): { asks: Ask[] | undefined; err: string } {
  const [got, setGot] = useState<{ id: string; asks: Ask[] } | null>(null);
  const [err, setErr] = useState("");
  const [again, setAgain] = useState(0);
  const flight = useRef<{ id: string; owed: boolean } | null>(null);
  const shown = useRef(id);
  shown.current = id;
  const mark = useTreeMark(id);
  const moved = useStore((s) => { const x = s.sessions[id]; return x ? `${x.updated} ${x.phase} ${x.head ?? ""}` : ""; });
  useEffect(() => {
    // A read in flight is not sent again: the change that came meanwhile is read once it is answered.
    if (flight.current?.id === id) { flight.current.owed = true; return; }
    // (Several changes come together at a turn's end: one read a moment after them.)
    const t = setTimeout(() => {
      const f = (flight.current = { id, owed: false });
      api<{ asks: Ask[] }>(`/api/sessions/${id}/asks`)
        .then((r) => { if (shown.current === id) { setGot({ id, asks: r.asks }); setErr(""); } })
        .catch((e) => { if (shown.current === id) setErr(String(e?.message ?? e)); reportUnlessGone(e, { at: "asks" }); })
        .finally(() => { if (flight.current === f) flight.current = null; if (f.owed && shown.current === id) setAgain((n) => n + 1); });
    }, got?.id === id ? 600 : 0);
    return () => clearTimeout(t);
  }, [id, mark, moved, again]);
  return { asks: got?.id === id ? got.asks : undefined, err };
}

// The words a row shows: the first paragraph, its lines run together (the whole is in the opened row).
export const askLine = (text: string) => (text.split(/\n\s*\n/)[0] ?? text).replace(/\s+/g, " ").trim();
