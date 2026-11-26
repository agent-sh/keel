// How a session's conversation is shown: the Conversation lens (components/Lens.tsx: the owner's
// messages, the replies to them and one folded line for each stretch between) or the full stream
// (components/Transcript.tsx). A session that has agents opens on the lens, any other on the
// stream; what the owner picks for a session is kept with its place on this device (lib/place.ts).
import { useSyncExternalStore } from "react";
import { useAuto } from "./automation.ts";
import { flushPlaces, placeOf, putPlace } from "./place.ts";
import { api, getState, useStore } from "./store.ts";

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
const asking = new Map<string, Promise<boolean>>();
// Whether the session has agents, asked once (a read ahead of the press asks it too: lib/open-ahead.ts).
export function agentsOf(session: string): Promise<boolean> {
  const known = asked.get(session);
  if (known != null) return Promise.resolve(known);
  if (kidsHere(session)) return Promise.resolve(true);
  ask(session);
  return asking.get(session) ?? Promise.resolve(false);
}
// The view a session opens on, once its agents are known (as useLensView says it).
export const viewOf = (session: string, agents: boolean): LensView => placeOf(session)?.view ?? (agents ? "conversation" : "stream");
function ask(session: string) {
  if (asked.has(session)) return;
  asked.set(session, null);
  const p = api<{ agents: boolean }>(`/api/sessions/${session}/has-agents`).then((r) => r.agents, () => false).then((agents) => {
    asked.set(session, agents);
    asking.delete(session);
    tick++;
    for (const f of subs) f();
    return agents;
  });
  asking.set(session, p);
}
// (A session whose agents' sessions the page's list holds, or whose agents the list counts as left out of it, has
// agents: known with no question, so its lens is read at the press.)
const kidsHere = (session: string) => !!getState().agentsLeft[session] || Object.values(getState().sessions).some((s) => s.parent_id === session);
export function useHasAgents(session: string): boolean {
  const kids = useStore((s) => !!s.agentsLeft[session] || Object.values(s.sessions).some((x) => x.parent_id === session));
  const auto = useAuto((x) => Object.values(x.agents).some((a) => a.parent_id === session)) || kids;
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

// Whether the view is known yet: a session whose owner picked a view, that is elsewhere, or whose agents are
// known. Until then the pane waits for the answer rather than draw the stream and then the lens over it.
export function useLensViewKnown(session: string): boolean {
  useSyncExternalStore(subscribe, () => tick);
  const kids = useStore((s) => !!s.agentsLeft[session] || Object.values(s.sessions).some((x) => x.parent_id === session));
  const auto = useAuto((x) => Object.values(x.agents).some((a) => a.parent_id === session)) || kids;
  const elsewhere = useStore((s) => !!s.sessions[session]?.machine || !!s.sessions[session]?.outside);
  return auto || elsewhere || !!placeOf(session)?.view || (asked.get(session) ?? null) !== null;
}
