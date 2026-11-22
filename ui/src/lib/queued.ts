// How many messages of the owner's wait in a session's queue, for its row in
// the list. The daemon tells every page of a queue that changes; a queue that
// was there before the page opened is told only for the sessions the page
// holds, so a row that may have one (its session is at work or stopped) asks
// once, without the transcript: two requests at a time, a dozen at most per
// connection (a list of hundreds asks no more), and again after a reconnect,
// when a queue may have changed unseen. The count belongs in the state the
// daemon tells of every session (`queued` beside `watch`): with it there this
// file asks nothing.
import { useEffect, useSyncExternalStore } from "react";
import { splitId } from "./fleet-ids.ts";
import { api, onFeature, useStore } from "./store.ts";

const AT_ONCE = 2, CAP = 12;
const read = new Map<string, number>();
const waiting: string[] = [];
const subs = new Set<() => void>();
let running = 0, asked = 0;

function next() {
  while (running < AT_ONCE && waiting.length && asked < CAP) {
    const id = waiting.shift()!;
    running++;
    asked++;
    api<{ queue?: unknown[] }>(`/api/sessions/${id}?events=0`)
      .then((r) => read.set(id, r.queue?.length ?? 0), () => read.set(id, 0)) // a session gone meanwhile has none
      .finally(() => { running--; subs.forEach((f) => f()); next(); });
  }
}
function ask(id: string) {
  if (read.has(id) || waiting.includes(id)) return;
  waiting.push(id);
  next();
}
// The page was cut off and is back: what it read once may be stale, and it may ask again.
onFeature({ reconnect: () => { read.clear(); waiting.length = 0; asked = 0; subs.forEach((f) => f()); } });

export function useQueued(id: string, maybe: boolean): number {
  const live = useStore((s) => s.queues[id]?.queue.length);
  const once = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => read.get(id));
  // Another machine's queue is its own daemon's to tell. (Asked again when what was read is dropped.)
  useEffect(() => { if (maybe && live === undefined && once === undefined && !splitId(id)) ask(id); }, [id, maybe, live, once]);
  return live ?? once ?? 0;
}
