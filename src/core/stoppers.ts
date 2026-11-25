// Who stopped a turn, and what that stop means. A turn ends as "interrupted"
// only when Engine.interrupt was called for it, and every caller says who it
// is with one of these words; the word is kept on the turn's end
// (`stopped_by`). One table, so what is said and what follows from a stop
// cannot drift apart: the daemon's log, the timeline, the page, the goal, the
// loop and the agents all read it here.
//
// Only the owner's own Stop is a Stop of the session: it holds the queue until
// the owner resumes it, pauses a goal and keeps agents' reports from waking the
// session. Any other stopper ends that one turn and leaves the rest as it was.
// (Some keep the queue waiting for reasons of their own, and a goal with it:
// the stop of an agent by the side that started it, or with an agent above it,
// until the side that started it sends it something; a move of the session,
// until the move is over; an archive or a delete, so that nothing queued
// starts in a session on its way out.) Two of the owner's acts cut a turn
// without being a Stop: a prompt they edit and a queued prompt they send now
// (`replaces`: their message is the next turn). Pure: the page loads this file.

export type Stopper = {
  // The end of the turn in a few words, after "The turn" or a comma: "stopped by the owner".
  says: string;
  // The owner's own Stop.
  owner?: boolean;
  // The owner's next message takes the turn's place (no Stop: nothing is held, the goal stays on).
  replaces?: boolean;
  // The stop of an agent by the side that started it (its parent, the harness for it).
  parent?: boolean;
  // The queue waits after it (`held`: why, said to whoever is told that nothing starts there).
  held?: string;
};

export const STOPPERS: Record<string, Stopper> = {
  owner: { says: "stopped by the owner", owner: true, held: "the owner stopped this session" },
  phone: { says: "stopped by the owner from the phone", owner: true, held: "the owner stopped this session" },
  edit: { says: "ended when the owner edited an earlier prompt", replaces: true },
  send_now: { says: "ended when the owner sent a new message", replaces: true },
  parent: { says: "stopped by its parent", parent: true, held: "its parent stopped this session" },
  ancestor: { says: "stopped with an agent above it", parent: true, held: "an agent above this one was stopped" },
  parent_turn: { says: "stopped with its parent's turn", parent: true, held: "this session stopped with its parent's turn" },
  time_limit: { says: "stopped at its time limit", parent: true, held: "this session passed its time limit" },
  parent_archived: { says: "stopped when its parent session was archived", parent: true, held: "this session's parent was archived" },
  pause: { says: "stopped when the fleet was paused" },
  hook: { says: "stopped by a hook" },
  supervisor: { says: "stopped by the supervisor" },
  review: { says: "stopped with its review" },
  handoff: { says: "stopped to move the session", held: "this session is being moved" },
  archive: { says: "stopped when the session was archived", held: "this session was archived" },
  delete: { says: "stopped when the session was deleted", held: "this session is being deleted" },
  api: { says: "stopped through the API" },
};

// A stopper's word as a caller may give it (the stop route takes one from its body).
export const isStopper = (by: unknown): by is string => typeof by === "string" && Object.hasOwn(STOPPERS, by);

// A stop nobody named (a turn_end from before every stop was named, a word this build does not know)
// is said as a stop and never as anyone's.
const UNKNOWN: Stopper = { says: "stopped" };
export const stopper = (by: unknown): Stopper => (isStopper(by) ? STOPPERS[by]! : UNKNOWN);

export const ownerStop = (by: unknown): boolean => !!stopper(by).owner;
export const replaced = (by: unknown): boolean => !!stopper(by).replaces;
// Whether the session's queue waits after this stop.
export const holds = (by: unknown): boolean => { const s = stopper(by); return !!(s.owner || s.parent || s.held); };
// What an interrupted end says of itself: "stopped by the owner", "ended when the owner sent a new message", "stopped".
export const stopSays = (by: unknown): string => stopper(by).says;
// Why nothing starts by itself in a session whose queue is held. A hold nobody named is from before
// stops were named, when only the owner's Stop left one.
export const heldSays = (by: unknown): string => (by == null ? STOPPERS.owner!.held! : stopper(by).held ?? "this session was stopped");
