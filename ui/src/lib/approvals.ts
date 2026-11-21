// What an answer on the approval cards may cover. Pure: the cards measure
// where they stand on screen (ApprovalCard.tsx), this decides from it. The
// rule behind all of it: an approval is never given for something the owner
// could not have read, or for a control that came under the hand a moment ago.
import type { Approval } from "../../../src/safety/gate.ts";

// How long something must stand whole on screen, unmoved, before it counts:
// a request before it joins "allow all", an Allow before it acts, a changed
// "allow all" before it acts again. The time a browser's permission prompt
// holds its button for.
export const SETTLE_MS = 1000;

// Where a thing stands on screen, and since when it has stood there whole.
export type Stand = { x: number; y: number; whole: boolean; since: number };

// The next reading of a thing. One that is whole in view where it was keeps
// its time; one that moved, or was cut by an edge or covered, starts again.
export function stand(prev: Stand | undefined, at: { x: number; y: number; whole: boolean }, now: number): Stand {
  if (prev?.whole && at.whole && Math.abs(prev.x - at.x) < 1 && Math.abs(prev.y - at.y) < 1) return prev;
  return { ...at, since: now };
}
export const settled = (s: Stand | undefined, now: number): boolean => !!s && s.whole && now - s.since >= SETTLE_MS;

// A request that is only ever answered on its own: high risk, a call the
// harness refused, one only the owner answers, one the daemon shows the start of.
export const alone = (a: Approval): boolean => a.risk !== "low" || a.kind === "refused" || !!a.once || !!a.cut;

export type Batch = {
  tool: string;
  kind: Approval["kind"];
  waiting: number; // the tool's open requests, whatever they are
  ids: string[];   // the ones one answer may cover now, oldest first
};

// One batch per tool with two or more requests that could be answered
// together. `read` holds the requests whose text stands whole on screen and
// has for the settle time; `cutByBox` the ones whose text is longer than the
// box that shows it. A request joins only while it is in the first and not in
// the second: what is out of view, moving, covered or cut is left out, as the
// ones answered alone are.
export function batches(cards: Approval[], read: ReadonlySet<string>, cutByBox: ReadonlySet<string>): Batch[] {
  const by = new Map<string, Batch & { able: number }>();
  for (const a of cards) {
    if (a.state !== "pending") continue;
    const b = by.get(a.tool) ?? { tool: a.tool, kind: a.kind, waiting: 0, ids: [], able: 0 };
    by.set(a.tool, b);
    b.waiting++;
    if (alone(a) || cutByBox.has(a.id)) continue;
    b.able++;
    if (read.has(a.id)) b.ids.push(a.id);
  }
  return [...by.values()].filter((b) => b.able > 1).map(({ able: _able, ...b }) => b);
}

// The state of one "allow all" action between two readings.
export type Action = {
  covered: string[];       // what it names and would answer
  frozen: string[] | null; // while the pointer or the keyboard is on it and it can be pressed: what it covered then
  hold: number;            // it does not act before this time
  live: boolean;           // it can be pressed
};

// `ready` is the batch's ids now; `hot` says the pointer or the keyboard is on
// the action; `open` holds the requests that still wait.
// - While it is hot and can be pressed, what it covers only shrinks: a request
//   joins after the pointer and the keyboard have left it.
// - When everything it held is answered (elsewhere, or by itself), it starts
//   again from what is ready, after the settle time: the hand is still on it.
// - When it grows while it could be pressed (nothing on it: a finger gives no
//   warning), it shows the new count and does not act for the settle time, so
//   a press aimed at the old count lands on nothing.
// - From not pressable (too few ready, or still held) it becomes pressable
//   with what is ready then, as a prompt's button does after its delay.
export function nextAction(prev: Action | undefined, ready: string[], hot: boolean, now: number, open: ReadonlySet<string>): Action {
  const was = prev ?? { covered: [], frozen: null, hold: 0, live: false };
  let frozen = hot ? was.frozen : null;
  let hold = was.hold;
  if (frozen && !frozen.some((id) => open.has(id))) {
    frozen = null;
    hold = now + SETTLE_MS;
  }
  const covered = frozen ? ready.filter((id) => frozen!.includes(id)) : ready;
  const grew = covered.some((id) => !was.covered.includes(id));
  if (!frozen && grew && (was.live || now < was.hold)) hold = now + SETTLE_MS;
  const live = covered.length > 1 && now >= hold;
  if (hot && live && !frozen) frozen = covered;
  return { covered, frozen, hold, live };
}
// The action has just answered: it does not act again for the settle time, wherever the rows stand.
export const spentAction = (now: number): Action => ({ covered: [], frozen: null, hold: now + SETTLE_MS, live: false });

const noun = (b: Pick<Batch, "kind">, n: number) => `${b.kind === "shell" ? "command" : b.kind === "edit" ? "change" : "call"}${n === 1 ? "" : "s"}`;
// "3 Bash commands", "2 Edit changes", "1 fetch call".
export const batchName = (b: Pick<Batch, "tool" | "kind">, n: number): string => `${n} ${b.tool} ${noun(b, n)}`;
// What the action says it covers: all of the tool's requests, or how many of them.
export const coverName = (b: Pick<Batch, "tool" | "kind" | "waiting">, n: number): string =>
  n === b.waiting ? `all ${batchName(b, n)}` : `${n} of ${batchName(b, b.waiting)}`;
