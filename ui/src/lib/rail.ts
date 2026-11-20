// The form the rail takes. It is the readable list (titles, state, time, by
// folder) whenever the stations asked for still fit beside it. Only when
// they do not (pinned stations, a side panel, a narrow window), or when the
// list was folded by choice, is it the column of marks; the list is then one
// press away, laid over the stations until a session is picked.
import { useEffect, useState } from "react";
import { getStations, useStations } from "./stations.ts";
import { getState, useStore } from "./store.ts";
import { getUI, savePref, setUI, useUI } from "./ui.ts";

export const LIST = 300; // the list's width, px
export const RAIL = 64; // the marks' width, px
export const STATION_MIN = 540; // matches .k-station's min-width

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

// Stations that must be on screen whatever the room: the pinned ones, the
// helm, a new session being started; an open side panel takes one more.
function asked(): number {
  const ui = getUI();
  if (ui.route.name === "settings") return 1;
  const st = getStations();
  const helm = ui.route.name === "session" ? ui.route.id : null;
  const ids = new Set<string>();
  if (!st.focus) for (const s of Object.values(getState().sessions)) if (!s.archived && (st.pinned.includes(s.id) || s.settings.pinned_ms)) ids.add(s.id);
  if (helm) ids.add(helm);
  return Math.max(1, ids.size + (ui.route.name === "new" ? 1 : 0)) + (ui.panel && helm ? 1 : 0);
}

// No room for the list beside what was asked for.
export const railTight = (width = innerWidth) => !phone() && width - LIST < asked() * STATION_MIN;

export type RailForm = { list: boolean; tight: boolean; over: boolean };
export function railForm(width = innerWidth): RailForm {
  const ui = getUI();
  const tight = railTight(width);
  const over = tight && ui.peek;
  return { list: phone() || (ui.sidebar && !tight) || over, tight, over };
}

export function useRail(): RailForm {
  const width = useWidth();
  useUI((s) => s);
  useStations((s) => s.pinned);
  useStations((s) => s.focus);
  useStore((s) => s.sessions);
  const form = railForm(width);
  // The laid-over list does not outlive the squeeze that called for it.
  useEffect(() => { if (!form.tight && getUI().peek) setUI({ peek: false }); }, [form.tight]);
  return form;
}

// The one control (and Ctrl B): show the list or fold it. With room the
// choice is remembered; without, the list lays over the stations.
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
