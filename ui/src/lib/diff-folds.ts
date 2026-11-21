// Which unchanged lines of a diff are folded until asked for. A run of
// FOLD_MIN or more unchanged lines keeps its first and last KEEP and folds
// the rest; a run that holds a line the reader is at (a comment on it, a
// comment being written) is left whole. Pure.
export const FOLD_MIN = 9, KEEP = 3;

// By the index of the first folded line: [first folded, first shown again).
export function foldsOf(lines: { kind: string }[], pinned?: ReadonlySet<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind !== "ctx") continue;
    let j = i;
    while (j < lines.length && lines[j]!.kind === "ctx") j++;
    if (j - i >= FOLD_MIN) {
      const from = i + KEEP, to = j - KEEP;
      let held = false;
      if (pinned) for (let k = from; k < to && !held; k++) held = pinned.has(k);
      if (!held) out.set(from, to);
    }
    i = j;
  }
  return out;
}

// The fold that hides the line at `index`, by its first folded line.
export function foldOver(folds: Map<number, number>, index: number): number | undefined {
  for (const [from, to] of folds) if (index >= from && index < to) return from;
  return undefined;
}
