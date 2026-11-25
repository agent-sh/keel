// In Focus a finished run of tool calls is one quiet line between replies: what
// the model did, in a few words, and a press opens the run as it is. A run with
// a call that has no result yet (it runs, or waits on the owner) or that failed
// is not folded: what needs a look stays in view.
import type { Family, Step } from "./work.ts";
import { callsOf } from "./work.ts";

const SAID: Record<Family, string> = {
  explore: "looked around", change: "edited files", run: "ran commands", use: "used tools",
  card: "asked", agents: "started agents", plan: "planned", said: "",
};

// Every call of the run has its result, and none failed.
export function settled(steps: Step[]): boolean {
  const calls = steps.flatMap(callsOf);
  return calls.length > 0 && calls.every((c) => c.t === "call" && !!c.result && !c.result.is_error);
}

// "Planned, started agents and ran commands": each kind of work once, in the order done.
export function foldWords(steps: Step[]): string {
  const seen: string[] = [];
  for (const s of steps) { const w = SAID[s.family]; if (w && !seen.includes(w)) seen.push(w); }
  if (!seen.length) return "Worked";
  const all = seen.length > 1 ? `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}` : seen[0]!;
  return all[0]!.toUpperCase() + all.slice(1);
}
