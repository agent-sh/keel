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
//   - each alert carries a number, and the app posts it back, with the word
//     only its own stream was given, once the desktop's notification service
//     took the notification: a reader of another stream cannot acknowledge
//     an alert that was not handed to it;
//   - with no word within `ACK_WAIT_MS` the shell is detached (its stream is
//     closed, so a live app attaches again) and the daemon shows the alert
//     itself. A word that comes late takes the daemon's own notification down
//     again, so one alert is never left on screen twice;
//   - one shell takes the alerts: the one attached longest that acknowledges.
//     Any other is handed none and is told so (`takes` in its hello, and a
//     `takes` event when it becomes the one), so an app that came second can
//     say that another program shows the notifications. The daemon cannot
//     tell the owner's app from another program of the same account that
//     speaks as one: whichever attached first takes them, and the other
//     knows.
export type ShellInfo = { engine: string; version: string; since: number; acks: boolean };
type Shell = ShellInfo & { stream: string; put(event: string, data: unknown): boolean; close(): void };

export const ACK_WAIT_MS = 3000;

// Kept across a hot reload: the streams stay open while the module is read again.
type Waiting = { stream: string; done(ok: boolean): void; late?: () => void; timedOut?: boolean };
const g = globalThis as { __keelShells?: Map<number, Shell>; __keelShellSeq?: number; __keelShellAcks?: Map<number, Waiting>; __keelShellAckSeq?: number };
const shells = (g.__keelShells ??= new Map<number, Shell>());
const waiting = (g.__keelShellAcks ??= new Map<number, Waiting>());

export const shellAttached = () => shells.size > 0;
// One that will show a notification and say so.
export const shellShows = () => [...shells.values()].some((s) => s.acks);
// The one that takes the alerts: attached longest among those that acknowledge.
const taker = () => [...shells].find(([, s]) => s.acks);
export const shellTakes = (stream: string) => taker()?.[1].stream === stream;
export const shellList = (): (ShellInfo & { takes: boolean })[] => { const t = taker()?.[0]; return [...shells].map(([id, { engine, version, since, acks }]) => ({ engine, version, since, acks, takes: id === t })); };
// After a shell left: the one that takes the alerts from now on is told, when it is another.
function left(was: number | undefined) {
  const now = taker();
  if (now && now[0] !== was && !now[1].put("takes", { takes: true })) { shells.delete(now[0]); left(now[0]); }
}

// `stream`: a word of this stream alone (its hello carries it), which its acknowledgements
// must name. Returns what detaches it.
export function attachShell(info: Omit<ShellInfo, "since">, put: Shell["put"], close: () => void = () => {}, stream: string = crypto.randomUUID()): () => void {
  const id = (g.__keelShellSeq = (g.__keelShellSeq ?? 0) + 1);
  shells.set(id, { ...info, since: Date.now(), stream, put, close });
  return () => { const was = taker()?.[0]; if (shells.delete(id) && was === id) left(id); };
}

function drop(id: number) {
  const s = shells.get(id);
  const was = taker()?.[0];
  shells.delete(id);
  try { s?.close(); } catch {}
  if (was === id) left(id);
}

// Hands a notification to the app: true once the shell that takes the alerts said it showed
// it. False when it did not in time (the caller then shows it itself, and that shell is
// detached: the next attached takes the alerts from the next one on). `late` runs if the word
// comes after that.
export async function handShell(data: Record<string, unknown>, opts: { wait?: number; late?: () => void } = {}): Promise<boolean> {
  for (;;) {
    const first = taker();
    if (!first) return false;
    const [id, s] = first;
    const ack = (g.__keelShellAckSeq = (g.__keelShellAckSeq ?? 0) + 1);
    const shown = new Promise<boolean>((done) => waiting.set(ack, { stream: s.stream, done, late: opts.late }));
    // A stream that is gone was no shell any more: the next one is the first.
    if (!s.put("notify", { ...data, ack })) { waiting.delete(ack); drop(id); continue; }
    const timer = setTimeout(() => { const w = waiting.get(ack); if (w) { w.timedOut = true; w.done(false); } }, opts.wait ?? ACK_WAIT_MS);
    const ok = await shown;
    clearTimeout(timer);
    if (ok) { waiting.delete(ack); return true; }
    // It stays in `waiting` for a while, so a late word is known for what it is.
    setTimeout(() => waiting.delete(ack), 60_000).unref?.();
    drop(id);
    return false;
  }
}

// The app's word that it showed the notification numbered `ack`, from the stream it was handed to.
export function ackShell(ack: number, stream: string): boolean {
  const w = waiting.get(ack);
  if (!w || w.stream !== stream) return false;
  if (w.timedOut) { waiting.delete(ack); w.late?.(); return true; }
  w.done(true);
  return true;
}

// To every shell.
export function tellShells(event: string, data: unknown) {
  for (const [id, s] of shells) if (!s.put(event, data)) shells.delete(id);
}
