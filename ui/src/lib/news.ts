// What a panel has to show that its owner has not looked at: a panel that is not open when something
// lands in it (a side answer) is marked, and the mark goes when the panel is shown. Per session and
// panel, kept in memory only.
import { useSyncExternalStore } from "react";

const marked = new Map<string, Set<string>>(); // session → the panels with news
const subs = new Set<() => void>();
let ver = 0;
const bump = () => { ver++; subs.forEach((f) => f()); };

export const news = {
  mark(sid: string, panel: string) {
    const s = marked.get(sid) ?? new Set<string>();
    if (s.has(panel)) return;
    marked.set(sid, s.add(panel));
    bump();
  },
  clear(sid: string, panel: string) {
    if (marked.get(sid)?.delete(panel)) bump();
  },
  has: (sid: string, panel: string) => !!marked.get(sid)?.has(panel),
  panels: (sid: string): string[] => [...(marked.get(sid) ?? [])],
};

// Whether any panel of the session other than `except` has news (the chooser's mark), and which have.
export function useNews(sid: string | undefined): (panel: string) => boolean {
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => ver);
  return (panel) => !!sid && news.has(sid, panel);
}
export const anyNews = (sid: string | undefined, except: string | null) => !!sid && news.panels(sid).some((p) => p !== except);
