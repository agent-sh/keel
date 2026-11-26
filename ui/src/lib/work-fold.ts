// A finished run of tool calls is one quiet line between replies: what the
// model did, in a few words, and a press opens the run as it is. In Focus as
// soon as it is finished; in the workbench once the owner has sent a message
// after it and the run is drawn anew (the caller's part: nothing folds under
// a reader's eyes): the run of the turn they read now stays whole, what they
// moved past is a line, so their words and the replies to them are what the
// conversation shows. A run with a call that has no result yet (it runs, or
// waits on the owner) is never folded, nor one whose agents still work (the
// caller says so), and one with a call that failed only once the owner moved
// past it: what needs a look stays in view.
import type { Family, Step } from "./work.ts";
import { callState, callsOf } from "./work.ts";

const SAID: Record<Family, string> = {
  explore: "looked around", change: "edited files", run: "ran commands", use: "used tools",
  card: "asked", agents: "started agents", plan: "planned", said: "",
};

// Every call of the run has its result, and none failed.
export function settled(steps: Step[]): boolean {
  const calls = steps.flatMap(callsOf);
  return calls.length > 0 && calls.every((c) => c.t === "call" && !!c.result && !c.result.is_error);
}

// Every call of the run has its result: nothing in it runs or waits on the owner.
export function over(steps: Step[]): boolean {
  const calls = steps.flatMap(callsOf);
  return calls.length > 0 && calls.every((c) => c.t === "call" && !!c.result);
}

// The calls of the run that ran and failed (not the ones the owner denied or stopped).
export const failedIn = (steps: Step[]): number => steps.flatMap(callsOf).filter((c) => c.t === "call" && callState(c.result) === "error").length;

// Whether the run is one line: finished and clean in Focus; over, in a turn the owner moved past, anywhere.
export const folds = (steps: Step[], calm: boolean, passed: boolean): boolean => (calm && settled(steps)) || (passed && over(steps));

// "Planned, started agents and ran commands": each kind of work once, in the order done.
export function foldWords(steps: Step[]): string {
  const seen: string[] = [];
  for (const s of steps) { const w = SAID[s.family]; if (w && !seen.includes(w)) seen.push(w); }
  if (!seen.length) return "Worked";
  const all = seen.length > 1 ? `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}` : seen[0]!;
  return all[0]!.toUpperCase() + all.slice(1);
}
