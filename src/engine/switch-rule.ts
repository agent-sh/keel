// What a session keeps of its effort across a model switch, for the server
// (the switch itself) and the page (the model picker shows on each row the
// effort a pick of it would run at). Pure: the page imports it.

// Effort levels from least to most: a level the new model does not list goes
// to the nearest one it does (xhigh on a model that stops at high runs high).
const LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function nearestEffort(want: string, offered: readonly string[]): string | undefined {
  if (offered.includes(want)) return want;
  const w = LADDER.indexOf(want);
  if (w < 0) return undefined;
  let best: string | undefined;
  let gap = Infinity;
  for (const e of offered) {
    const i = LADDER.indexOf(e);
    // On a tie the lower level wins: the switch never makes a request dearer than asked.
    if (i >= 0 && (Math.abs(i - w) < gap || (Math.abs(i - w) === gap && i < w))) { best = e; gap = Math.abs(i - w); }
  }
  return best;
}

// The effort a model runs at when the session's wanted level moves to it:
// the nearest level it lists, else its default (high when it lists high, as
// the engine sends), else its first. Undefined: the model takes no effort.
export function carriedEffort(want: string | undefined, offered: readonly string[]): string | undefined {
  if (!offered.length) return undefined;
  return (want ? nearestEffort(want, offered) : undefined) ?? (offered.includes("high") ? "high" : offered[0]);
}

// The next level in the model's own list, one step down or up, held at the ends.
export function stepEffort(cur: string | undefined, offered: readonly string[], by: -1 | 1): string | undefined {
  if (!offered.length) return undefined;
  const i = cur ? offered.indexOf(cur) : -1;
  if (i < 0) return offered.includes("high") ? "high" : offered[0];
  return offered[Math.max(0, Math.min(offered.length - 1, i + by))];
}
