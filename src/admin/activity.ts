// What the daemon has in flight that holds memory and is not a session's turn: counted where it starts and ends,
// read by the resource sampler to say what was running when the daemon's memory stepped (src/admin/resources.ts).
const live = new Map<string, number>();

// One more of `kind` until the returned function is called (a second call does nothing).
export function begin(kind: string): () => void {
  live.set(kind, (live.get(kind) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (live.get(kind) ?? 1) - 1;
    if (n > 0) live.set(kind, n);
    else live.delete(kind);
  };
}

export async function during<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const end = begin(kind);
  try { return await run(); } finally { end(); }
}

// The kinds that have something in flight now, and how many.
export const ongoing = (): Record<string, number> => Object.fromEntries(live);
