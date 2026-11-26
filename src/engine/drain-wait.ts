// What a drain waits for before it parks a running turn (Engine.settle).
//
// A drain used to wait for each turn to end by itself, up to its bound. An agent's turn runs for
// an hour of steps, so the bound was spent every time and the turns were cut at its end anyway,
// mostly in the middle of a model request. Now a turn stops at its next step boundary (its tool
// results stored, its next request not sent): nothing of it is lost there, and the next daemon
// sends that request. The drain waits only for what costs something to cut:
//
// - a model request on its way: its output is paid for as it streams, and a cut one is paid again.
//   Most end within seconds (the median request is a few seconds, the slowest in a hundred under a minute).
// - a summary being written for the turn (compacting): the same, longer.
//
// - a step's tool calls, until each has ended or is a command running in front of its turn: a command has
//   its own wait after this one (src/admin/drain-commands.ts), and a call whose command has not started yet
//   would otherwise be cut before it began. Most calls end in milliseconds.
//
// It does not wait for a turn that is already stopped at its boundary, one that waits on the owner (its
// card is put back by the next daemon), one that waits for a provider or a retry (nothing is on its way),
// or one whose calls all block on agents none of which is waited for (they stopped at their own boundaries,
// so the wait would spend the whole bound for nothing).
//
// The facts come from what the turn holds, not from its status: the status says idle from a reply's first
// output, while the reply still streams.
import type { TurnStatus } from "../core/types.ts";

// `requestOut`: a model request of the turn is on its way (sent, or streaming its reply).
// `callsOut`: how many tool calls the turn has out. `inFront`: every one of them is a command running in front
// of the turn. `onAgents`: every call blocks on agents, and none of them is waited for.
export type DrainTurn = {
  atBoundary: boolean; waitsOnOwner: boolean; providerWaiting: boolean; status: TurnStatus;
  requestOut: boolean; callsOut: number; inFront: boolean; onAgents?: boolean;
};

export function drainWaitsFor(t: DrainTurn): boolean {
  if (t.atBoundary || t.waitsOnOwner || t.providerWaiting) return false;
  const s = t.status;
  if (s.kind === "compacting") return true;
  // A request held in its account's line (or by the spend window), or between retries, has nothing on its way.
  if (t.requestOut) return !(s.kind === "model" && s.limit) && s.kind !== "retry";
  if (t.callsOut > 0) return !t.inFront && !t.onAgents;
  return false;
}
