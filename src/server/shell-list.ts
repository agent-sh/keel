// What the desktop app's tray menu lists (desktop/src/tray.rs): up to five top-level sessions,
// the ones that need the owner first, then the unread, then the working. It travels in the same
// `needs` frame as the count, so the mark and the menu are never told apart.
import { STATE_WORD, UNREAD_WORD } from "../core/state-words.ts";

export const TRAY_SESSIONS = 5;
const TITLE_MAX = 80;

export type TrayLine = { id: string; title: string; state: "need" | "unread" | "work"; word: string };
export type TrayFrame = { n: number; unread: number; list: TrayLine[] };

// A title as one plain line: control characters and line breaks are a space, the characters that
// reorder text are dropped, and it is cut on a whole character.
export function plainTitle(title: string | null | undefined): string {
  const one = (title ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  if (!one) return "Untitled session";
  const chars = [...one];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : one;
}

// `needs`: what waits on the owner per top-level session (the count `n` adds it up, listed or
// not); `working`: the top-level sessions at work; `unread`: unread alerts per inbox session;
// `titleOf` is undefined for a session this machine does not hold; `recent`: when a session last did anything.
export function trayFrame(needs: ReadonlyMap<string, number>, working: ReadonlySet<string>, unread: Record<string, number>, titleOf: (id: string) => string | undefined, recent: (id: string) => number): TrayFrame {
  const byRecent = (ids: string[]) => ids.sort((a, b) => recent(b) - recent(a));
  const line = (state: TrayLine["state"], word: string) => (id: string): TrayLine => ({ id, title: plainTitle(titleOf(id)), state, word });
  const unreadIds = Object.keys(unread).filter((id) => unread[id]! > 0 && !needs.has(id) && titleOf(id) !== undefined);
  const workIds = [...working].filter((id) => !needs.has(id) && !(unread[id]! > 0));
  const list = [...byRecent([...needs.keys()]).map(line("need", STATE_WORD.need)), ...byRecent(unreadIds).map(line("unread", UNREAD_WORD)), ...byRecent(workIds).map(line("work", STATE_WORD.work))].slice(0, TRAY_SESSIONS);
  return { n: [...needs.values()].reduce((a, b) => a + b, 0), unread: Object.values(unread).reduce((a, b) => a + b, 0), list };
}
