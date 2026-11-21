// The whole history of a session, for the few views that count over all of it
// (its usage by turn). The page holds a session in parts; this reads every
// event once while such a view is open, kept out of the store, and adds the
// events that arrive after to its own list: what the store lets go of later
// (a trim of a session nobody reads back) stays here.
import { useEffect, useRef, useState } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { splitId } from "./fleet-ids.ts";
import { grown, missedSince } from "./rows.ts";
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
  // drop it, so taking them on every change of that list misses none. Except
  // when more arrive at once than the page keeps (a reconnect's replay): what
  // the page holds then starts after a gap, and the events since the list's
  // last one are read from the daemon, once per such gap.
  const asked = useRef(0);
  useEffect(() => {
    if (own && own.id === id && missedSince(own.events, held) && asked.current !== own.events.at(-1)!.seq) {
      const after = (asked.current = own.events.at(-1)!.seq);
      api<{ events: StoredEvent[] }>(`/api/sessions/${id}/events?after=${after}`)
        .then((r) => setOwn((cur) => {
          if (!cur || cur.id !== id) return cur;
          const last = cur.events.at(-1)?.seq ?? 0;
          const more = r.events.filter((e) => e.seq > last).map((e) => (splitId(id!) ? { ...e, session_id: id! } : e));
          return more.length ? { id: cur.id, events: [...cur.events, ...more] } : cur;
        }))
        .catch((e) => reportUnlessGone(e, { at: "whole history" }));
      return;
    }
    setOwn((cur) => { if (!cur || cur.id !== id || missedSince(cur.events, held)) return cur; const events = grown(cur.events, held); return events === cur.events ? cur : { id: cur.id, events }; });
  }, [held, id, own]);
  return own && own.id === id ? (missedSince(own.events, held) ? own.events : grown(own.events, held)) : undefined;
}
