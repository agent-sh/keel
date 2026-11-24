// Whether a session's tree of agents is open under its row. The owner's choice is kept per session
// (in this browser); the row's chevron sets it and the tree under the row reads it.
import { useSyncExternalStore } from "react";

const KEY = "keel.agentsOpen";
const read = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
let open = read();
const subs = new Set<() => void>();

export function setAgentsOpen(id: string, on: boolean) {
  if ((open[id] === true) === on) return;
  open = { ...open };
  if (on) open[id] = true; else delete open[id];
  try { localStorage.setItem(KEY, JSON.stringify(open)); } catch { /* storage full or off: the choice lasts for the page */ }
  subs.forEach((f) => f());
}

export const useAgentsOpen = (id: string): boolean => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => open[id] === true);
