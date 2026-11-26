// A session row the hand rests on is read before the press: whether it has agents (which view it opens
// on), then that view's part, its lens (lib/lens-data.ts) or the end of its stream (actions.openSession,
// what opening it reads first). The press then draws what the page holds, and the daemon has the session
// in memory. One read at a time, and only for a row rested on for DWELL_MS: a hand passing over the list
// reads nothing.
import { lensAhead } from "./lens-data.ts";
import { agentsOf, viewOf } from "./lens-view.ts";
import { actions, getState } from "./store.ts";
import { getUI } from "./ui.ts";

const DWELL_MS = 90;
let timer: ReturnType<typeof setTimeout> | undefined;

export function restOn(session: string) {
  clearTimeout(timer);
  timer = setTimeout(() => void readAhead(session), DWELL_MS);
}

export function restOff() {
  clearTimeout(timer);
}

async function readAhead(session: string) {
  const ui = getUI().route;
  if (ui.name === "session" && ui.id === session) return;
  const s = getState().sessions[session];
  // (A session on another machine or of another harness is read where it is, when it opens.)
  if (!s || s.machine || s.outside) return;
  const view = viewOf(session, await agentsOf(session));
  if (view === "conversation") lensAhead(session);
  else if (!getState().events[session]) await actions.openSession(session).catch(() => {});
}
