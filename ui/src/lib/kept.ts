// What the owner opened or closed stays so when its row is drawn again. A block of the transcript
// far from the view is not drawn (lib/window.ts), and the rows it holds are made again when the
// reader comes back to them: a step, a call or a long prompt keeps the state the owner gave it.
// Null: the owner never chose (the row's own default stands). A null key keeps nothing (a call
// still being written has no id of its own yet).
import { useState } from "react";

const chosen = new Map<string, boolean>();

export function useKept(key: string | null): [boolean | null, (to: boolean) => void] {
  const [value, setValue] = useState<boolean | null>(() => (key === null ? null : chosen.get(key) ?? null));
  const set = (to: boolean) => {
    if (chosen.size > 4000) chosen.clear(); // a page open for days
    if (key !== null) chosen.set(key, to);
    setValue(to);
  };
  return [value, set];
}
