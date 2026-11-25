// A side panel popped out into a window of its own, and docked back.
//
// The window is the page's place /s/ID?panel=NAME (components/PanelWindow.tsx): in the desktop app a
// window of its own, in a browser a tab. The window holds a Web Lock named for the session and the panel
// for as long as it lives, so the page it was popped out of learns that it closed from the lock being let
// go, however the window ended (its close button, a crash, the app quitting): no message can be lost. A
// lock is shared by the windows of one origin, which is all they are.
import { useSyncExternalStore } from "react";
import { every } from "./clock.ts";
import { shell } from "./shell.ts";

const GRACE_MS = 1500; // a window that was loaded again lets go of its lock for a moment
const OPEN_MS = 15_000; // a window that has not held its lock by now did not open

export const lockName = (session: string, panel: string) => `keel-panel:${session}:${panel}`;
export const placeOf = (session: string, panel: string) => `/s/${encodeURIComponent(session)}?panel=${encodeURIComponent(panel)}`;
// The page tells a popped out window to close (a panel docked back from the pane).
export const DOCK_CHANNEL = "keel-panel";

export const canPopOut = typeof navigator !== "undefined" && !!navigator.locks?.request && typeof BroadcastChannel !== "undefined";

const out = new Set<string>();
const watching = new Set<string>();
const docking = new Set<string>(); // told to close: its lock being let go is the end, with no wait
const subs = new Set<() => void>();
let version = 0;
const change = () => { version++; subs.forEach((f) => f()); };
const held = async (name: string) => !!(await navigator.locks.query()).held?.some((l) => l.name === name);

// Waits for the window to hold its lock (the pane says "in its own window" meanwhile), then for it to let go.
async function watch(name: string) {
  if (watching.has(name)) return;
  watching.add(name);
  out.add(name);
  change();
  const end = () => { watching.delete(name); out.delete(name); docking.delete(name); change(); };
  const opened = await new Promise<boolean>((done) => {
    const since = Date.now();
    let stop = () => {};
    let busy = false;
    const look = async () => {
      if (busy) return;
      busy = true;
      try {
        if (await held(name)) { stop(); done(true); } else if (Date.now() - since > OPEN_MS) { stop(); done(false); }
      } finally { busy = false; }
    };
    stop = every(250, () => void look());
    void look();
  });
  if (!opened) return end();
  for (;;) {
    await navigator.locks.request(name, () => {});
    if (!docking.has(name)) await new Promise((r) => setTimeout(r, GRACE_MS));
    if (!(await held(name))) return end();
  }
}

// The pane of this session shows the panel as popped out, and docks back when its window closes.
export function popOut(session: string, panel: string) {
  const path = placeOf(session, panel);
  if (shell?.can.windows) shell.post({ t: "window", path });
  else if (!window.open(path, "_blank")) return;
  void watch(lockName(session, panel));
}

// Windows of this session that were popped out before this page loaded (it was loaded again): the pane knows them.
export async function recover(session: string) {
  if (!canPopOut) return;
  const prefix = `keel-panel:${session}:`;
  for (const l of (await navigator.locks.query()).held ?? []) if (l.name?.startsWith(prefix)) void watch(l.name);
}

// Asks the window to close; the pane docks back when it has (its lock is let go).
export function dockBack(session: string, panel: string) {
  const name = lockName(session, panel);
  if (watching.has(name)) docking.add(name);
  const c = new BroadcastChannel(DOCK_CHANNEL);
  c.postMessage({ dock: name });
  c.close();
}

export const isPopped = (session: string, panel: string) => out.has(lockName(session, panel));

export function usePopped(session: string, panel: string): boolean {
  const name = lockName(session, panel);
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => version);
  return out.has(name);
}
