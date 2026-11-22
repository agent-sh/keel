// How many messages of the owner's wait in a session's queue, for its row in
// the list. Counts come with /api/state at open and reconnect. A queue frame
// or a full session read can be newer, but a copy from before the snapshot
// must not hide what happened while the page was away, including a clear.
import { useEffect, useSyncExternalStore } from "react";
import { splitId } from "./fleet-ids.ts";
import { api, onFeature, queueCount, useStore } from "./store.ts";

// Older daemons do not include counts. Keep the bounded reads for them only.
const AT_ONCE = 2, CAP = 12;
const read = new Map<string, number>();
const waiting: string[] = [];
const subs = new Set<() => void>();
let running = 0, asked = 0, connection = 0;

function next() {
  while (running < AT_ONCE && waiting.length && asked < CAP) {
    const id = waiting.shift()!;
    running++;
    asked++;
    const at = connection;
    const keep = (n: number) => { if (at === connection) read.set(id, n); };
    api<{ queue?: unknown[] }>(`/api/sessions/${id}?events=0`)
      .then((r) => keep(r.queue?.length ?? 0), () => keep(0))
      .finally(() => { running--; subs.forEach((f) => f()); next(); });
  }
}
function ask(id: string) {
  if (read.has(id) || waiting.includes(id)) return;
  waiting.push(id);
  next();
}
// The page was cut off and is back: what it read once may be stale, and it may ask again.
onFeature({ reconnect: () => { connection++; read.clear(); waiting.length = 0; asked = 0; subs.forEach((f) => f()); } });

export function useQueued(id: string, maybe: boolean): number {
  const local = !splitId(id);
  const heard = useStore((s) => queueCount(s, id));
  const legacy = useStore((s) => s.queueSnapshot !== undefined && s.queueSnapshot.counts === undefined);
  const once = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => read.get(id));
  useEffect(() => { if (local && legacy && maybe && heard === undefined && once === undefined) ask(id); }, [id, local, legacy, maybe, heard, once]);
  return heard ?? (legacy ? once : undefined) ?? 0;
}
