// A session started in the background (the start box's Alt+Enter): said once, with a way to open
// it (components/StartedToast.tsx). One at a time: the next start takes the place of the last.
import { useSyncExternalStore } from "react";

export const STARTED_MS = 8_000;
export type Started = { n: number; id: string; title: string };
let current: Started | null = null;
let made = 0;
let timer = 0;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

export function offerStarted(id: string, title: string) {
  clearTimeout(timer);
  current = { n: ++made, id, title };
  const n = current.n;
  timer = window.setTimeout(() => { if (current?.n === n) { current = null; tell(); } }, STARTED_MS);
  tell();
}
export const dropStarted = () => { if (!current) return; clearTimeout(timer); current = null; tell(); };
export const useStarted = (): Started | null => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);

// What the toast calls the session: its title, else the first line of what was asked.
export const startedTitle = (title: string | undefined, text: string) => {
  const t = (title || text.split("\n").find((l) => l.trim()) || "New session").trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
};
