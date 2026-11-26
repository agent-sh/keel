// What the owner opened or closed stays so when its row is drawn again. A block of the transcript
// far from the view is not drawn (lib/window.ts), and the rows it holds are made again when the
// reader comes back to them: a step, a call or a long prompt keeps the state the owner gave it.
// Null: the owner never chose (the row's own default stands). A null key keeps nothing (a call
// still being written has no id of its own yet).
//
// A journal notes what the lens's Find opens and puts it back when Find ends, drawn rows too.
// A later choice by the owner takes precedence over that temporary opening.
import { useEffect, useState } from "react";

const chosen = new Map<string, boolean>();
const drawn = new Map<string, Set<(v: boolean | null) => void>>();
let journal: Map<string, boolean | undefined> | null = null;

export function useKept(key: string | null): [boolean | null, (to: boolean, byFind?: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(() => (key === null ? null : chosen.get(key) ?? null));
  useEffect(() => {
    if (key === null) return;
    let s = drawn.get(key);
    if (!s) drawn.set(key, (s = new Set()));
    s.add(setValue);
    return () => { s!.delete(setValue); if (!s!.size) drawn.delete(key); };
  }, [key]);
  const set = (to: boolean, byFind?: boolean) => {
    if (chosen.size > 4000) chosen.clear(); // a page open for days
    if (key !== null) {
      if (!byFind) journal?.delete(key);
      else if (journal && !journal.has(key)) journal.set(key, chosen.get(key));
      chosen.set(key, to);
    }
    setValue(to);
  };
  return [value, set];
}

// The returned function restores entries that Find still owns.
export function keptJournal(): () => void {
  const mine = new Map<string, boolean | undefined>();
  journal = mine;
  return () => {
    if (journal === mine) journal = null;
    for (const [key, was] of mine) {
      if (was === undefined) chosen.delete(key);
      else chosen.set(key, was);
      for (const f of drawn.get(key) ?? []) f(was ?? null);
    }
    mine.clear();
  };
}
