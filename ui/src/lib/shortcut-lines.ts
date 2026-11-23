// The shortcut sheet's lines: one line per key. A key the commands bind to
// several acts (Esc stops a turn, leaves a look, closes a panel) is one line
// under General with each act under it and where it applies; a key of one act
// stays a line of its own group. The keys of a context (a card's, the message
// box's) join a shared key's line when they are bound to it too.
export type ShortcutRow = { group: string; label: string; keys: string; where?: string };
export type ShortcutCase = { label: string; where?: string };
export type ShortcutLine = { group: string; keys: string; cases: ShortcutCase[] };

export const SHARED_GROUP = "General";

export function shortcutLines(commands: ShortcutRow[], fixed: ShortcutRow[]): ShortcutLine[] {
  // Two commands can share a name and a key (Esc goes back from a look and from the start page): one case.
  const seen = new Set<string>();
  const once = (r: ShortcutRow) => {
    const id = `${r.label}\u0000${r.keys}\u0000${r.where ?? ""}`;
    return !seen.has(id) && !!seen.add(id);
  };
  const rows = [...commands.filter(once), ...fixed.filter(once)];
  const acts = new Map<string, Set<string>>();
  for (const r of commands) acts.set(r.keys, (acts.get(r.keys) ?? new Set()).add(r.label));
  const shared = (keys: string) => (acts.get(keys)?.size ?? 0) > 1;
  const lines: ShortcutLine[] = [];
  const byKey = new Map<string, ShortcutLine>();
  for (const r of rows) {
    const one = { label: r.label, ...(r.where ? { where: r.where } : {}) };
    if (!shared(r.keys)) { lines.push({ group: r.group, keys: r.keys, cases: [one] }); continue; }
    const line = byKey.get(r.keys);
    if (line) { line.cases.push(one); continue; }
    const made = { group: SHARED_GROUP, keys: r.keys, cases: [one] };
    byKey.set(r.keys, made);
    lines.push(made);
  }
  return lines;
}
