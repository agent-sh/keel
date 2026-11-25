// The form the rail takes, and the measures the bridge lays out by. The rail
// is the readable list (titles, state, time, by folder) whenever the panes
// the owner chose still fit beside it: at the width they gave it, else as
// wide as the room beside the panes, down to the narrowest the list is
// dragged to. With less room than that it is still a list of titles, one
// line a session (the mark and the title, cut), down to a width where a
// title can be read. More panes than the window holds (they scroll sideways)
// keep the list the panes that fit leave it, and the panes' map stands at the
// row's edge (PaneMap.tsx): the panes that fit give it its width. Only below that (a side panel beside the helm, a narrow
// window), or when the list was folded by choice, is it the column of marks; the list is then one press away, laid over the panes
// until a session is picked. Every measure is a rem, so it follows the text size.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getStations, MAX_PANES, useStations } from "./stations.ts";
import { getUI, savePref, setUI, useUI } from "./ui.ts";
import { PHONE_QUERY } from "./phone.ts";

// A length given in px at a 16 px root, at the root's size now (the default
// size and the owner's text size are the stylesheet's: styles.css sets the root).
// The root's size is read once per text size (and again after a resize): a
// read of the computed style makes the browser bring every pending style
// change up to date, and these measures are asked for on every render of
// every pane while replies stream.
let root: { scale: number; px: number } | null = null;
addEventListener("resize", () => (root = null));
function rootPx(): number {
  const scale = getUI().scale;
  if (!root || root.scale !== scale) root = { scale, px: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  return root.px;
}
const rem = (n: number) => (n * rootPx()) / 16 || n * getUI().scale;
export const railWidth = () => rem(64); // the marks
export const paneMin = () => rem(416); // matches .k-station's min-width (26rem)
// NARROW: the least a list of titles is worth: a dozen letters of a title beside its mark.
const LIST = 300, LIST_MIN = 232, LIST_MAX = 560, NARROW = 120;
// The panes' map at the row's edge (bridge.css: .k-pane-map).
export const mapWidth = () => rem(32);
export const listBounds = () => ({ min: rem(LIST_MIN), max: Math.max(rem(LIST_MIN), Math.min(rem(LIST_MAX), innerWidth - paneMin())), base: rem(LIST) });
// The list's width: the dragged one within what fits, else the default.
export function listWidth() {
  const { min, max, base } = listBounds();
  return Math.round(Math.min(max, Math.max(min, getUI().listW ?? base)));
}

const phone = () => matchMedia(PHONE_QUERY).matches;

export function useWidth() {
  const [w, setW] = useState(innerWidth);
  useEffect(() => {
    const f = () => setW(innerWidth);
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

// A side panel beside the conversation: the narrowest each column works at
// and the widest the panel gets. bridge.css holds only the conversation's
// minimum (27.5rem, in the helm's min-width); the panel's width comes from here.
const sessionMin = () => rem(440), panelMin = () => rem(384), panelMax = () => rem(640);
const panes = () => { const st = getStations(); return st.focus ? 1 : st.count; };
// The room the helm pane can have: the window less the folded rail and the
// other panes at their narrowest, each with its 1 px divider.
const helmRoom = (width: number) => width - Math.ceil(railWidth()) - (panes() - 1) * (Math.ceil(paneMin()) + 1);
// The panel sits beside the conversation when the helm has room for both
// columns. Otherwise it is a sheet over the pane, which costs no width: no
// pane changes size and nothing scrolls sideways for it.
export const panelBeside = (width = innerWidth) => !phone() && helmRoom(width) - sessionMin() >= panelMin();
// Its width beside the conversation: 44% of the window, within what the helm can give.
export const panelWidth = (width = innerWidth) => Math.floor(Math.min(panelMax(), 0.44 * width, helmRoom(width) - sessionMin()));

// The width the panes on screen need at their narrowest; a panel beside the helm widens it.
function needed(width: number): number {
  const ui = getUI();
  if (ui.route.name === "settings" || ui.route.name === "customize") return paneMin();
  const beside = ui.panel && ui.route.name === "session" && panelBeside(width);
  return panes() * paneMin() + (beside ? sessionMin() - paneMin() + panelWidth(width) : 0);
}

// The room the list has beside the panes at their narrowest (a pixel for each pane's divider).
const listRoom = (width: number) => Math.floor(width - needed(width)) - panes();
// More panes than the window holds beside the folded rail: the row scrolls sideways whatever the list does.
export const panesOver = (width = innerWidth) => !phone() && panes() > panesMax(width);
// Settings and Customize read as a column of their own rail (15rem) and a page (52rem, the reading width): the
// list stays beside them only while the window holds all three. With less it folds to the marks, as a squeeze does
// (a press lays it over the page), and comes back by itself on leaving. It is derived from the route, so the
// owner's own choice to fold or show the list is never written by it.
const SETTINGS_NEED = 15 + 52 + 3;
export const settingsFold = (width = innerWidth) => {
  const ui = getUI();
  return !phone() && (ui.route.name === "settings" || ui.route.name === "customize") && width - listWidth() < rem(SETTINGS_NEED * 16);
};
// The list beside the panes: at the owner's width or what the room gives, while
// that is a width the list is dragged to; with less, the narrow list of titles.
// With more panes than fit, the room is what the panes that fit leave: the list
// is as it would be with only those open.
function beside(width: number): { width: number; narrow: boolean } | null {
  if (settingsFold(width)) return null;
  if (panesOver(width)) {
    const fit = panesMax(width), room = Math.floor(width - fit * paneMin() - fit);
    if (room >= Math.floor(rem(LIST_MIN))) return { width: Math.min(listWidth(), room), narrow: false };
    return room >= rem(NARROW) ? { width: room, narrow: true } : null;
  }
  const room = listRoom(width);
  const full = Math.min(listWidth(), room);
  if (full >= Math.floor(rem(LIST_MIN))) return { width: full, narrow: false };
  return room >= rem(NARROW) ? { width: room, narrow: true } : null;
}

// More panes than fit: the width of each pane that fits, so that they, the list and the panes'
// map share the window (the map's width comes off the panes, a few pixels each, never off the list).
export function paneOver(width = innerWidth): number | null {
  if (!panesOver(width)) return null;
  const fit = panesMax(width);
  return Math.min(paneMin(), Math.floor((width - railForm(width).width - mapWidth() - fit) / fit));
}

// No room for a list of titles beside the panes.
export const railTight = (width = innerWidth) => !phone() && !beside(width);

// How many panes the window can hold (beside the folded rail).
export const panesMax = (width = innerWidth) => Math.min(MAX_PANES, Math.max(1, Math.floor((width - railWidth()) / paneMin())));

// `narrow`: the list is the one-line list of titles. `width`: what the rail takes beside the panes.
export type RailForm = { list: boolean; tight: boolean; over: boolean; narrow: boolean; width: number };
export function railForm(width = innerWidth): RailForm {
  const ui = getUI();
  const fit = phone() ? { width: listWidth(), narrow: false } : beside(width);
  const tight = !fit;
  const over = tight && ui.peek;
  const list = phone() || (ui.sidebar && !tight) || over;
  return { list, tight, over, narrow: list && !over && !!fit?.narrow, width: list && !over ? fit!.width : railWidth() };
}

export function useRail(): RailForm {
  const width = useWidth();
  // What the form depends on, and no more: a pane does not render again for an overlay opening.
  useUI((s) => `${s.sidebar}|${s.peek}|${s.listW}|${s.scale}|${!!s.panel}|${s.route.name}`);
  useStations((s) => s.count);
  useStations((s) => s.focus);
  const form = railForm(width);
  // The laid-over list does not outlive the squeeze that called for it.
  useEffect(() => { if (!form.tight && getUI().peek) setUI({ peek: false }); }, [form.tight]);
  return form;
}

// Whether the helm's side panel sits beside the conversation now. It renders
// again only when the answer changes, not on every resize event.
const onResize = (f: () => void) => { addEventListener("resize", f); return () => removeEventListener("resize", f); };
export function usePanelBeside(): boolean {
  useUI((s) => s.scale);
  useStations((s) => s.count);
  useStations((s) => s.focus);
  return useSyncExternalStore(onResize, () => panelBeside());
}

// The form the helm's side panel takes now, and its width beside the conversation
// (for the bridge, which lays the panes out at every width).
export function usePanelSide(): { beside: boolean; width: number } {
  const width = useWidth();
  useUI((s) => s.scale);
  useStations((s) => s.count);
  useStations((s) => s.focus);
  const beside = panelBeside(width);
  return { beside, width: beside ? panelWidth(width) : 0 };
}

// The one control (and Ctrl B): show the list or fold it. With room the
// choice is remembered; without, the list lays over the panes.
export function toggleList(show?: boolean) {
  const ui = getUI();
  if (phone()) return savePref("sidebar", show ?? !ui.sidebar);
  if (railTight()) {
    const next = show ?? !ui.peek;
    // (A list folded for Settings is only laid over it: the owner's own choice stays as it was.)
    if (next && !ui.sidebar && !settingsFold()) savePref("sidebar", true);
    return setUI({ peek: next });
  }
  savePref("sidebar", show ?? !ui.sidebar);
}

export { callsigns } from "./callsigns.ts";
