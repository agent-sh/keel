// What waits for a session's pace (src/automation/pace.ts), as the page last heard it: read when a view of the
// session opens and when the socket opens again, then from the session's `pace` frames.
import { useEffect, useState } from "react";
import type { PaceView } from "../../../src/automation/pace.ts";
import { api, onFeature, readAtOpen, reportUnlessGone } from "./store.ts";
import { clock } from "./utils.ts";

export type { PaceView };

export function usePace(sessionId: string): PaceView | null {
  const [v, setV] = useState<PaceView | null>(null);
  useEffect(() => {
    setV(null);
    let live = true;
    const read = () => api<PaceView>(`/api/sessions/${sessionId}/pace?day=0`)
      .then((x) => { if (live) setV(x); })
      .catch((e) => reportUnlessGone(e, { at: "pace" }));
    const off = onFeature({ frame: (f) => { if (f.name === "pace" && f.session_id === sessionId) setV(f.data as PaceView); }, reconnect: readAtOpen(read) });
    return () => { live = false; off(); };
  }, [sessionId]);
  return v;
}

// "14:05" for a time today, as the rest of the page says a clock.
export const clockOf = (ms: number) => clock(ms);

// The menu's and the line's words for a pace.
export const paceWords = (min: number) => (min > 0 ? `${min} min` : "off");
