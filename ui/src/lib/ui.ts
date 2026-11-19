// Page state that is not daemon state: the route, theme, which overlays are
// open, and the owner's local preferences. Components read it with useUI.
import { useSyncExternalStore } from "react";
import type { PromptBlock } from "../../../src/core/types.ts";

export type Route =
  | { name: "new" }
  | { name: "session"; id: string }
  | { name: "settings"; section: string };

export type ThemePref = "light" | "dark" | "system";

type UIState = {
  route: Route;
  theme: ThemePref;
  sidebar: boolean; // desktop: shown; phone: the drawer is open
  palette: boolean;
  shortcuts: boolean;
  errors: boolean;
  modelMenu: number; // bumped to ask the composer's model picker to open
  permMenu: number; // bumped to ask the session header's permission menu to open
  enterSends: boolean;
  newWorkspace: string; // the folder the start box creates a session in ("" = daemon default)
  newModel: string;
  // Text pushed into a message box (a file mention, a starter): `session` names the
  // session's box, absent for the start box. Several boxes can be on screen.
  // `append`: added below what the box holds instead of replacing it; `notice`: said in the box;
  // `blocks`: attachments that go into the box with the text (a prompt forked back to the box).
  composerSeed: { text: string; n: number; session?: string; append?: boolean; notice?: string; blocks?: PromptBlock[] } | null;
  panel: string | null; // the open tab of the side panel
  focusEvent: string | null; // a message to scroll to once its session is shown (?e=)
  focusCall: string | null; // a tool call whose card opens there (a search hit on a command or its output)
  // A message opened from search on another branch: shown without moving the
  // session's branch until the owner chooses to continue from it.
  preview: { session: string; event: string } | null;
};

function parse(): Route {
  const p = location.pathname;
  const s = p.match(/^\/s\/([\w-]+)/);
  if (s) return { name: "session", id: s[1]! };
  // Links in the Rust Keel form: /#SESSION and /#/s/SESSION.
  const h = location.hash.match(/^#\/?(?:s\/)?([\w-]{8,})/);
  if (p === "/" && h) return { name: "session", id: h[1]! };
  const st = p.match(/^\/settings(?:\/([\w-]+))?/);
  if (st) return { name: "settings", section: st[1] ?? "general" };
  return { name: "new" };
}

const pref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};

const isPhone = () => matchMedia("(max-width: 767px)").matches;

let state: UIState = {
  route: parse(),
  theme: (localStorage.getItem("keel.theme") as ThemePref) || "system",
  sidebar: isPhone() ? false : pref("keel.rail", false), // desktop: the rail shows the full index
  palette: false,
  shortcuts: false,
  errors: false,
  modelMenu: 0,
  permMenu: 0,
  enterSends: pref("keel.enterSends", true),
  newWorkspace: pref("keel.newWorkspace", ""),
  newModel: "",
  composerSeed: null,
  panel: pref("keel.panel", null),
  focusEvent: new URLSearchParams(location.search).get("e"),
  focusCall: null,
  preview: null,
};
const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export function setUI(patch: Partial<UIState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export const getUI = () => state;
export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function navigate(r: Route, replace = false) {
  const url = r.name === "session" ? `/s/${r.id}` : r.name === "settings" ? `/settings/${r.section}` : "/";
  if (url !== location.pathname || location.hash) (replace ? history.replaceState : history.pushState).call(history, null, "", url);
  setUI({ route: r, ...(isPhone() ? { sidebar: false } : {}) });
}
addEventListener("popstate", () => setUI({ route: parse() }));
if (state.route.name === "session" && location.pathname === "/") navigate(state.route, true);

export function savePref(k: "enterSends" | "newWorkspace" | "sidebar" | "panel", v: unknown) {
  if (!(k === "sidebar" && isPhone())) localStorage.setItem(`keel.${k === "sidebar" ? "rail" : k}`, JSON.stringify(v));
  setUI({ [k]: v } as Partial<UIState>);
}

// Crossing to phone width closes the drawer; back on a wide screen the owner's choice returns.
matchMedia("(max-width: 767px)").addEventListener("change", (e) => setUI({ sidebar: e.matches ? false : pref("keel.rail", false) }));

const media = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const dark = state.theme === "dark" || (state.theme === "system" && media.matches);
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  root.classList.add("theme-switch");
  root.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1b1f27" : "#eceef2");
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switch")));
}
media.addEventListener("change", applyTheme);
export function setTheme(t: ThemePref) {
  localStorage.setItem("keel.theme", t);
  setUI({ theme: t });
  applyTheme();
}
export const isDark = () => document.documentElement.classList.contains("dark");
export const phone = isPhone;
export const seedComposer = (text: string, session: string | undefined = state.route.name === "session" ? state.route.id : undefined, o: { append?: boolean; notice?: string; blocks?: PromptBlock[] } = {}) =>
  setUI({ composerSeed: { text, n: (state.composerSeed?.n ?? 0) + 1, session, ...o } });

// Models the owner picked, newest first: the picker's Recent group. A pick
// is recorded when made, so renaming or touching a session moves nothing.
const RECENT_KEY = "keel.recentModels";
export function recentPicks(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function notePick(id: string) {
  if (!id) return;
  localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentPicks().filter((x) => x !== id)].slice(0, 20)));
}
