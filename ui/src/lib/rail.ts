// The form the rail takes, and the measures the bridge lays out by. The rail
// is the readable list (titles, state, time, by folder) whenever the panes
// the owner chose still fit beside it. Only when they do not (many panes, a
// side panel, a narrow window), or when the list was folded by choice, is it
// the column of marks; the list is then one press away, laid over the panes
// until a session is picked. Every measure is a rem, so it follows the text size.
import { useEffect, useState } from "react";
import { getStations, MAX_PANES, useStations } from "./stations.ts";
import { getUI, savePref, setUI, useUI } from "./ui.ts";

const rem = (n: number) => n * getUI().scale;
export const railWidth = () => rem(64); // the marks
export const paneMin = () => rem(440); // matches .k-station's min-width
const LIST = 300, LIST_MIN = 232, LIST_MAX = 560;
export const listBounds = () => ({ min: rem(LIST_MIN), max: Math.max(rem(LIST_MIN), Math.min(rem(LIST_MAX), innerWidth - paneMin())), base: rem(LIST) });
// The list's width: the dragged one within what fits, else the default.
export function listWidth() {
  const { min, max, base } = listBounds();
  return Math.round(Math.min(max, Math.max(min, getUI().listW ?? base)));
}

const phone = () => matchMedia("(max-width: 767px)").matches;

export function useWidth() {
  const [w, setW] = useState(innerWidth);
  useEffect(() => {
    const f = () => setW(innerWidth);
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

// The width the panes on screen need at their narrowest; a side panel widens the helm.
function needed(width: number): number {
  const ui = getUI();
  if (ui.route.name === "settings") return paneMin();
  const st = getStations();
  const panes = st.focus ? 1 : st.count;
  return panes * paneMin() + (ui.panel && ui.route.name === "session" ? Math.min(0.44 * width, rem(640)) : 0);
}

// No room for the list beside the panes.
export const railTight = (width = innerWidth) => !phone() && width - listWidth() < needed(width);

// How many panes the window can hold (beside the folded rail).
export const panesMax = (width = innerWidth) => Math.min(MAX_PANES, Math.max(1, Math.floor((width - railWidth()) / paneMin())));

export type RailForm = { list: boolean; tight: boolean; over: boolean; width: number };
export function railForm(width = innerWidth): RailForm {
  const ui = getUI();
  const tight = railTight(width);
  const over = tight && ui.peek;
  const list = phone() || (ui.sidebar && !tight) || over;
  return { list, tight, over, width: list && !over ? listWidth() : railWidth() };
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

// The one control (and Ctrl B): show the list or fold it. With room the
// choice is remembered; without, the list lays over the panes.
export function toggleList(show?: boolean) {
  const ui = getUI();
  if (phone()) return savePref("sidebar", show ?? !ui.sidebar);
  if (railTight()) {
    const next = show ?? !ui.peek;
    if (next && !ui.sidebar) savePref("sidebar", true);
    return setUI({ peek: next });
  }
  savePref("sidebar", show ?? !ui.sidebar);
}

// A short code per session for its mark on the folded rail: the initials of
// the title's first two telling words, so the mark reads as the session.
// Two sessions never share one: the older keeps the initials, the newer takes
// other letters of its title.
const FILLER = new Set("a an the to of for and or in on at by with from into is are be how why what when where which that this it its as do does".split(" "));
const letters = (w: string) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c));
export function callsigns(sessions: { id: string; title: string; created: number }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const s of [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
    const all = s.title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const telling = all.filter((w) => !FILLER.has(w.toLowerCase()));
    const words = (telling.length ? telling : all).map(letters).filter((w) => w.length);
    const [a, b] = words;
    const tries: string[] = [];
    if (a && b) tries.push(a[0]! + b[0]!);
    if (a) for (const c of a.slice(1)) tries.push(a[0]! + c);
    if (a) for (const w of words.slice(2)) tries.push(a[0]! + w[0]!);
    if (a && b) for (const c of b.slice(1)) tries.push(a[0]! + c);
    const head = a?.[0] ?? "N";
    if (!a) tries.push("NS"); // an untitled session
    for (let n = 2; n < 100; n++) tries.push(head + n);
    const code = tries.map((t) => t.toLocaleUpperCase()).find((t) => !taken.has(t)) ?? head.toLocaleUpperCase();
    taken.add(code);
    out[s.id] = code;
  }
  return out;
}
