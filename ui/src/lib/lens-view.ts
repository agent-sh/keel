// How a session's conversation is shown: the Conversation lens (components/Lens.tsx: the owner's
// messages, the replies to them and one folded line for each stretch between) or the full stream
// (components/Transcript.tsx). A session that has agents opens on the lens, any other on the
// stream; what the owner picks for a session is kept with its place on this device (lib/place.ts).
import { useSyncExternalStore } from "react";
import { useAuto } from "./automation.ts";
import { flushPlaces, placeOf, putPlace } from "./place.ts";
import { api, useStore } from "./store.ts";

export type LensView = "conversation" | "stream";
const subs = new Set<() => void>();
let tick = 0;
const subscribe = (f: () => void) => { subs.add(f); return () => void subs.delete(f); };

export function setLensView(session: string, view: LensView) {
  putPlace(session, { view });
  flushPlaces(); // (a choice is kept at once: a reload right after it finds it)
  tick++;
  for (const f of subs) f();
}

// A session has agents when an agent of it is known here, or the daemon says it started one (the page's
// list of agents holds the live and recent ones only): asked once a session, a seek on the daemon.
const asked = new Map<string, boolean | null>();
function ask(session: string) {
  if (asked.has(session)) return;
  asked.set(session, null);
  api<{ agents: boolean }>(`/api/sessions/${session}/has-agents`).then((r) => {
    asked.set(session, r.agents);
    if (r.agents) { tick++; for (const f of subs) f(); }
  }, () => asked.set(session, false));
}
export function useHasAgents(session: string): boolean {
  const auto = useAuto((x) => Object.values(x.agents).some((a) => a.parent_id === session));
  if (!auto) ask(session);
  return auto || asked.get(session) === true;
}

// (A session on another machine is read there: it shows the stream.)
export function useLensView(session: string): LensView {
  useSyncExternalStore(subscribe, () => tick);
  const agents = useHasAgents(session);
  const elsewhere = useStore((s) => !!s.sessions[session]?.machine || !!s.sessions[session]?.outside);
  if (elsewhere) return "stream";
  return placeOf(session)?.view ?? (agents ? "conversation" : "stream");
}
