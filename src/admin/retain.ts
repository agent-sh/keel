// Which backups the daemon keeps (Storage.prune removes the rest).
//
// A restart makes a backup, and a full one soon after (it is never made while
// a restart waits), so a store of a few GB holds one backup of 0.2 to 2 GB per
// restart. Keeping the last five by count kept a day of them, all of the same
// hours. The rule is by time: the newest few (for a backup that fails its
// check: the one before it is whole), and the newest of each of the last days
// (what the store held a day ago, a week ago). A delta stays with the full
// backup it is read over; the newest backup known whole stays with its base;
// the newest backup is never removed.
export type Retainable = { name: string; created_ms: number | null; base?: string; newest_whole?: true };
export type Retention = { recent: number; days: number };
export const DEFAULT_RETENTION: Retention = { recent: 2, days: 7 };
const DAY = 86_400_000;

// `list`: newest first. The names to keep.
export function retained(list: readonly Retainable[], now: number, r: Retention): Set<string> {
  const keep = new Set<string>();
  // (At least the newest, whatever the settings say.)
  for (const b of list.slice(0, Math.max(1, r.recent))) keep.add(b.name);
  const days = new Set<number>();
  for (const b of list) {
    if (b.created_ms === null) continue;
    const ago = Math.max(0, Math.floor((now - b.created_ms) / DAY));
    if (ago >= r.days || days.has(ago)) continue;
    days.add(ago);
    keep.add(b.name);
  }
  for (const b of list) if (b.newest_whole) keep.add(b.name);
  // What a kept delta is read over.
  for (const b of list) if (keep.has(b.name) && b.base) keep.add(b.base);
  return keep;
}
