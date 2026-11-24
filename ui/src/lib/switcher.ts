// The switcher of recent sessions: Ctrl Tab opens it on the session before this one, Tab again goes down the
// list (Shift Tab, up), letting go of Ctrl opens the selected one, Esc leaves it. It lists the last six sessions
// this page showed, most recent first (lib/recent.ts). Next and previous session keep the list's own order.
import { useSyncExternalStore } from "react";
import { announce } from "./announce.ts";
import { modalOpen } from "./overlay.ts";
import { recentList, recentOf } from "./recent.ts";
import { getState } from "./store.ts";
import { getUI, navigate } from "./ui.ts";

type Switcher = { ids: string[]; at: number } | null;
let state: Switcher = null;
const subs = new Set<() => void>();
const set = (s: Switcher) => { state = s; subs.forEach((f) => f()); };
export const useSwitcher = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => state);

const shown = () => {
  const sessions = getState().sessions;
  return recentOf(recentList(), (id) => !!sessions[id] && !sessions[id]!.archived);
};
const wordOf = (id: string) => getState().sessions[id]?.title || "New session";

function open(dir: 1 | -1) {
  const ids = shown();
  if (ids.length < 2) return;
  const r = getUI().route;
  // The session on screen is first: the one to go back to is the second, or the last when going up.
  const at = r.name === "session" && ids[0] === r.id ? (dir > 0 ? 1 : ids.length - 1) : dir > 0 ? 0 : ids.length - 1;
  set({ ids, at });
  announce(`Switch session: ${wordOf(ids[at]!)}`);
}
export function move(dir: 1 | -1) {
  if (!state) return;
  const at = (state.at + dir + state.ids.length) % state.ids.length;
  set({ ...state, at });
  announce(wordOf(state.ids[at]!));
}
export const cancel = () => { if (state) set(null); };
export function choose(at = state?.at ?? 0) {
  const s = state;
  if (!s) return;
  set(null);
  const id = s.ids[at];
  if (id && getState().sessions[id]) navigate({ name: "session", id });
}
export const select = (at: number) => { if (state) set({ ...state, at }); };

// In the capture phase, before the keymap and the controls: while the switcher is open it takes every key it uses.
function onKeyDown(e: KeyboardEvent) {
  const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (!state) {
    if (e.key === "Tab" && e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && !modalOpen()) { take(); if (!e.repeat) open(e.shiftKey ? -1 : 1); }
    return;
  }
  if (e.key === "Tab") { take(); move(e.shiftKey ? -1 : 1); }
  else if (e.key === "ArrowDown") { take(); move(1); }
  else if (e.key === "ArrowUp") { take(); move(-1); }
  else if (e.key === "Escape") { take(); cancel(); }
  else if (e.key === "Enter") { take(); choose(); }
  // Ctrl was let go without its key-up reaching the page: it is not held, so the choice is made.
  else if (!e.ctrlKey && e.key !== "Control" && e.key !== "Shift") choose();
}
function onKeyUp(e: KeyboardEvent) { if (state && e.key === "Control") { e.preventDefault(); choose(); } }

let installed = false;
export function installSwitcher() {
  if (installed) return;
  installed = true;
  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  // The page lost the keyboard while it was open (another window, Alt Tab): nothing was chosen.
  addEventListener("blur", cancel);
}
