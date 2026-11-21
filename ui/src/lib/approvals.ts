// Which open requests one "allow all" answers. Pure: the card list decides
// what to show, this decides what a single click may cover.
import type { Approval } from "../../../src/safety/gate.ts";

// A request counts as seen once it has been on screen this long. One that
// arrived under the pointer is not yet part of "all": the button names and
// answers only the requests the owner had the time to read, the way a
// browser's permission prompt holds its button for a moment.
export const SETTLE_MS = 1000;

export type Batch = {
  tool: string;
  kind: Approval["kind"];
  ids: string[];   // what a click answers now: the seen ones, oldest first
  waiting: number; // how many of the tool's requests are open, seen or not
};

// One batch per tool with two or more open requests that can be allowed as a
// set. A high-risk request is never in one (it is answered alone, read on its
// own), and neither is a refused call. `shownAt` holds when each card was
// first on screen; a card it does not know has not been shown.
export function batches(cards: Approval[], shownAt: ReadonlyMap<string, number>, now: number): Batch[] {
  const by = new Map<string, Batch>();
  for (const a of cards) {
    if (a.state !== "pending" || a.risk !== "low" || a.kind === "refused") continue;
    const b = by.get(a.tool) ?? { tool: a.tool, kind: a.kind, ids: [], waiting: 0 };
    b.waiting++;
    const at = shownAt.get(a.id);
    if (at !== undefined && now - at >= SETTLE_MS) b.ids.push(a.id);
    by.set(a.tool, b);
  }
  return [...by.values()].filter((b) => b.waiting > 1);
}

// "3 Bash commands", "2 Edit changes", "2 fetch calls".
export function batchName(b: Pick<Batch, "tool" | "kind">, n: number): string {
  const noun = b.kind === "shell" ? "command" : b.kind === "edit" ? "change" : "call";
  return `${n} ${b.tool} ${noun}${n === 1 ? "" : "s"}`;
}
