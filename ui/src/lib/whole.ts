// The whole history of a session, for the few views that count over all of it
// (its usage by turn, what an export leaves behind). The page holds a session
// in parts; this reads every event once while such a view is open, kept out of
// the store, and follows the events that arrive after.
import { useEffect, useMemo, useState } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { splitId } from "./fleet-ids.ts";
import { api, reportUnlessGone, useStore } from "./store.ts";

export function useWholeEvents(id: string | undefined): StoredEvent[] | undefined {
  const held = useStore((s) => (id ? s.events[id] : undefined));
  const [read, setRead] = useState<{ id: string; events: StoredEvent[] }>();
  useEffect(() => {
    if (!id) return;
    let stop = false;
    api<{ events: StoredEvent[] }>(`/api/sessions/${id}/events`)
      .then((r) => { if (!stop) setRead({ id, events: splitId(id) ? r.events.map((e) => ({ ...e, session_id: id })) : r.events }); })
      .catch((e) => reportUnlessGone(e, { at: "whole history" }));
    return () => { stop = true; };
  }, [id]);
  return useMemo(() => {
    if (!read || read.id !== id) return undefined;
    const last = read.events.at(-1)?.seq ?? 0;
    const fresh = (held ?? []).filter((e) => e.seq > last);
    return fresh.length ? [...read.events, ...fresh] : read.events;
  }, [read, held, id]);
}
