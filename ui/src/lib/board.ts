// When the owner last looked at each session, so the board can mark what
// finished since. Kept per browser.
const KEY = "keel.seen";
let seen: Record<string, number> = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
})();

export const seenAt = (id: string) => seen[id] ?? 0;

export function markSeen(id: string, ts = Date.now()) {
  if (seenAt(id) >= ts) return;
  seen = { ...seen, [id]: ts };
  const ids = Object.keys(seen);
  if (ids.length > 500) for (const k of ids.sort((a, b) => seen[a]! - seen[b]!).slice(0, ids.length - 500)) delete seen[k];
  localStorage.setItem(KEY, JSON.stringify(seen));
}
