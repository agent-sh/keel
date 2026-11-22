// The desktop app attached to this daemon (desktop/): a window of its own
// around the same page, with a tray mark and native notifications. A shell
// is attached for as long as its event stream is open (GET /api/shell/events,
// src/server/routes/shell.ts).
//
// A desktop notification is the app's to show, so its click lands in the
// app's window. But "handed over" is not "put on a stream": the alert is the
// app's only once the app said it showed it. So:
//   - only a shell that said it acknowledges (`acks`) is handed alerts; any
//     other reader of the stream holds none;
//   - each alert carries a number, and the app posts it back once the
//     desktop's notification service took the notification;
//   - with no word within `ACK_WAIT_MS` the shell is detached (its stream is
//     closed, so a live app attaches again) and the daemon shows the alert
//     itself. A word that comes late takes the daemon's own notification down
//     again, so one alert is never left on screen twice.
export type ShellInfo = { engine: string; version: string; since: number; acks: boolean };
type Shell = ShellInfo & { put(event: string, data: unknown): boolean; close(): void };

export const ACK_WAIT_MS = 3000;

// Kept across a hot reload: the streams stay open while the module is read again.
type Waiting = { done(ok: boolean): void; late?: () => void; timedOut?: boolean };
const g = globalThis as { __keelShells?: Map<number, Shell>; __keelShellSeq?: number; __keelShellAcks?: Map<number, Waiting>; __keelShellAckSeq?: number };
const shells = (g.__keelShells ??= new Map<number, Shell>());
const waiting = (g.__keelShellAcks ??= new Map<number, Waiting>());

export const shellAttached = () => shells.size > 0;
// One that will show a notification and say so.
export const shellShows = () => [...shells.values()].some((s) => s.acks);
export const shellList = (): ShellInfo[] => [...shells.values()].map(({ engine, version, since, acks }) => ({ engine, version, since, acks }));

// Returns what detaches it.
export function attachShell(info: Omit<ShellInfo, "since">, put: Shell["put"], close: () => void = () => {}): () => void {
  const id = (g.__keelShellSeq = (g.__keelShellSeq ?? 0) + 1);
  shells.set(id, { ...info, since: Date.now(), put, close });
  return () => void shells.delete(id);
}

function drop(id: number) {
  const s = shells.get(id);
  shells.delete(id);
  try { s?.close(); } catch {}
}

// Hands a notification to the app: true once a shell said it showed it.
// False when none did in time (the caller then shows it itself). `late` runs
// if the word comes after that.
export async function handShell(data: Record<string, unknown>, opts: { wait?: number; late?: () => void } = {}): Promise<boolean> {
  for (const [id, s] of [...shells]) {
    if (!s.acks) continue;
    const ack = (g.__keelShellAckSeq = (g.__keelShellAckSeq ?? 0) + 1);
    const shown = new Promise<boolean>((done) => waiting.set(ack, { done, late: opts.late }));
    if (!s.put("notify", { ...data, ack })) { waiting.delete(ack); drop(id); continue; }
    const timer = setTimeout(() => { const w = waiting.get(ack); if (w) { w.timedOut = true; w.done(false); } }, opts.wait ?? ACK_WAIT_MS);
    const ok = await shown;
    clearTimeout(timer);
    if (ok) { waiting.delete(ack); return true; }
    // It stays in `waiting` for a while, so a late word is known for what it is.
    setTimeout(() => waiting.delete(ack), 60_000).unref?.();
    drop(id);
  }
  return false;
}

// The app's word that it showed the notification numbered `ack`.
export function ackShell(ack: number): boolean {
  const w = waiting.get(ack);
  if (!w) return false;
  if (w.timedOut) { waiting.delete(ack); w.late?.(); return true; }
  w.done(true);
  return true;
}

// To every shell.
export function tellShells(event: string, data: unknown) {
  for (const [id, s] of shells) if (!s.put(event, data)) shells.delete(id);
}
