// How many messages of the owner's wait in a session's queue, for its row in
// the list. The daemon tells every page of a queue that changes; a queue that
// was there before the page opened is told only for the sessions the page
// holds, so a row that may have one (its session is at work or stopped) asks
// once, without the transcript.
import { useEffect, useSyncExternalStore } from "react";
import { splitId } from "./fleet-ids.ts";
import { api, useStore } from "./store.ts";

const read = new Map<string, number>();
const asking = new Set<string>();
const subs = new Set<() => void>();

function ask(id: string) {
  if (asking.has(id) || read.has(id)) return;
  asking.add(id);
  api<{ queue?: unknown[] }>(`/api/sessions/${id}?events=0`)
    .then((r) => read.set(id, r.queue?.length ?? 0), () => read.set(id, 0)) // a session gone meanwhile has none
    .finally(() => { asking.delete(id); subs.forEach((f) => f()); });
}

export function useQueued(id: string, maybe: boolean): number {
  const live = useStore((s) => s.queues[id]?.queue.length);
  const once = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => read.get(id));
  // Another machine's queue is its own daemon's to tell.
  useEffect(() => { if (maybe && live === undefined && !splitId(id)) ask(id); }, [id, maybe, live]);
  return live ?? once ?? 0;
}
