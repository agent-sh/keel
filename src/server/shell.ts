// The desktop shell attached to this daemon (desktop/): a window of its own
// around the same page, with a tray mark and native notifications. A shell
// is attached for as long as its event stream is open (GET /api/shell/events,
// src/server/routes/shell.ts). While one is, a desktop notification is the
// shell's to show, so its click lands in the shell's window; with none, the
// daemon shows it itself as before. One alert goes down exactly one of the
// two paths, so it is never shown twice.
export type ShellInfo = { engine: string; version: string; since: number };
type Shell = ShellInfo & { put(event: string, data: unknown): boolean };

// Kept across a hot reload: the streams stay open while the module is read again.
const g = globalThis as { __keelShells?: Map<number, Shell>; __keelShellSeq?: number };
const shells = (g.__keelShells ??= new Map<number, Shell>());

export const shellAttached = () => shells.size > 0;
export const shellList = (): ShellInfo[] => [...shells.values()].map(({ engine, version, since }) => ({ engine, version, since }));

// Returns what detaches it.
export function attachShell(info: Omit<ShellInfo, "since">, put: Shell["put"]): () => void {
  const id = (g.__keelShellSeq = (g.__keelShellSeq ?? 0) + 1);
  shells.set(id, { ...info, since: Date.now(), put });
  return () => void shells.delete(id);
}

// To one shell, the one attached longest that still takes it: true when it was handed over.
export function tellShell(event: string, data: unknown): boolean {
  for (const [id, s] of shells) {
    if (s.put(event, data)) return true;
    shells.delete(id);
  }
  return false;
}

// To every shell.
export function tellShells(event: string, data: unknown) {
  for (const [id, s] of shells) if (!s.put(event, data)) shells.delete(id);
}
