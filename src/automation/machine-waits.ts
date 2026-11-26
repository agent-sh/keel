// What waits for this machine, in one account (the rail's machine line and Settings > Health): the trees the
// load hold holds (src/automation/load-hold.ts) and the calls that wait in the heavy-command line
// (src/tools/heavy.ts), each tree counted once. Pure: the waits in, the account out.
//
// A wait for the machine is never the owner's to answer: it goes on by itself, as the load falls or a slot frees.
// A tree that also asks him something is counted here for its wait and asks in Inbox as before; the account says
// how many do, so the line never reads as if nothing were asked.
//
// A call that waits in the heavy line under QUIET_MS is left out: most slots free in seconds, and a line that
// came and went with each command would be noise. A held tree is always in: the hold is a minute's decision.
export const QUIET_MS = 15_000;

export type Cause = "load" | "heavy";
// `tree`: the tree's key (load-hold's treeOf); `since`: when it began to wait; `why`: the heavy line's cause.
export type Wait = { tree: string; title: string; since: number; cause: Cause; why?: string };
export type Account = {
  trees: number;                 // trees that wait, each once
  held: number;                  // of them, held by the load hold
  heavy: number;                 // of them, with a call in the heavy-command line
  asking: number;                // of them, also asking the owner something
  oldest: { title: string; since: number; cause: Cause; releases: string } | null;
};

// What lets a wait go, in words.
export const RELEASES: Record<Cause, string> = {
  load: "goes on as the load falls, the oldest first",
  heavy: "goes on when a heavy-command slot frees",
};

export function account(waits: Wait[], asking: ReadonlySet<string>, now: number, quietMs = QUIET_MS): Account {
  const shown = waits.filter((w) => w.cause === "load" || now - w.since >= quietMs);
  const byTree = new Map<string, Wait[]>();
  for (const w of shown) byTree.set(w.tree, [...(byTree.get(w.tree) ?? []), w]);
  let oldest: Wait | undefined;
  let held = 0, heavy = 0, ask = 0;
  for (const [tree, ws] of byTree) {
    if (ws.some((w) => w.cause === "load")) held++;
    if (ws.some((w) => w.cause === "heavy")) heavy++;
    if (asking.has(tree)) ask++;
    for (const w of ws) if (!oldest || w.since < oldest.since) oldest = w;
  }
  return {
    trees: byTree.size, held, heavy, asking: ask,
    oldest: oldest ? { title: oldest.title, since: oldest.since, cause: oldest.cause, releases: oldest.cause === "heavy" && oldest.why ? `${RELEASES.heavy} (${oldest.why})` : RELEASES[oldest.cause] } : null,
  };
}
