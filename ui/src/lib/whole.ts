// The whole history of a session, for the few views that count over all of it
// (its usage by turn). The page holds a session in parts; this reads every
// event once while such a view is open, kept out of the store, and adds the
// events that arrive after to its own list: what the store lets go of later
// (a trim of a session nobody reads back) stays here.
import { useEffect, useState } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { splitId } from "./fleet-ids.ts";
import { grown } from "./rows.ts";
import { api, reportUnlessGone, useStore } from "./store.ts";

export function useWholeEvents(id: string | undefined): StoredEvent[] | undefined {
  const held = useStore((s) => (id ? s.events[id] : undefined));
  const [own, setOwn] = useState<{ id: string; events: StoredEvent[] }>();
  useEffect(() => {
    if (!id) return;
    let stop = false;
    api<{ events: StoredEvent[] }>(`/api/sessions/${id}/events`)
      .then((r) => { if (!stop) setOwn({ id, events: splitId(id) ? r.events.map((e) => ({ ...e, session_id: id })) : r.events }); })
      .catch((e) => reportUnlessGone(e, { at: "whole history" }));
    return () => { stop = true; };
  }, [id]);
  // Each new event is in the held list for hundreds of events before a trim can
  // drop it, so taking them on every change of that list misses none.
  useEffect(() => {
    setOwn((cur) => { if (!cur || cur.id !== id) return cur; const events = grown(cur.events, held); return events === cur.events ? cur : { id: cur.id, events }; });
  }, [held, id]);
  return own && own.id === id ? grown(own.events, held) : undefined;
}
