// What the page knows of a call beyond its record: whether its session works
// (a call with no result runs only then) and whether its approval card is open
// (then it waits on the owner and has not started). Both are asked only for
// calls with no result, so a finished step never renders again for them.
import { useSyncExternalStore } from "react";
import { useSafety } from "./safety.ts";
import { getState, subscribe } from "./store.ts";

const never = () => () => {};

// `waiting`: the ids of the calls that wait, in one string.
export function useCallsLive(sessionId: string | undefined, calls: { id: string; result?: unknown }[]): { working: boolean; waiting: string } {
  const pending = calls.some((c) => !c.result);
  // The page's store tells every reply's words as they stream: a call that has its result does not listen to it at all.
  const working = useSyncExternalStore(pending ? subscribe : never, () => pending && !!sessionId && getState().sessions[sessionId]?.phase === "working");
  const waiting = useSafety((x) => {
    const open = pending && sessionId ? x.approvals[sessionId] : undefined;
    if (!open?.length) return "";
    let out = "";
    for (const c of calls) if (!c.result && open.some((a) => a.call_id === c.id)) out += `${c.id} `;
    return out;
  });
  return { working, waiting };
}
