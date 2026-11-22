import { clsx, type ClassValue } from "clsx";
import { ownFocus } from "./asks.ts";
import { extendTailwindMerge } from "tailwind-merge";

// The type scale of styles.css (--text-*) is font sizes: without this, a color
// class such as text-danger beside text-title made twMerge drop the size.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["micro", "caption", "ui", "base", "read", "title", "display"] } } });
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

// Work for idle time. WebKit has no requestIdleCallback: there the work runs
// right after the next frame is painted, so it still never takes a frame.
export const whenIdle = (fn: () => void, timeout?: number) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, timeout ? { timeout } : undefined);
  else requestAnimationFrame(() => setTimeout(fn, 0));
};

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Every time on screen is on the 24-hour clock, and these two write it: no
// surface formats a time of its own (src/ui-conventions.test.ts).
// Full time for tooltips.
export const when = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// A time of day (09:30), with its seconds, its weekday or its date when asked, in a zone other than the browser's when named.
export const clock = (ts: number, o: { seconds?: boolean; weekday?: boolean; date?: boolean; zone?: string } = {}) =>
  new Date(ts).toLocaleString(undefined, {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(o.seconds ? { second: "2-digit" } : {}), ...(o.weekday ? { weekday: "short" } : {}), ...(o.date ? { month: "short", day: "numeric" } : {}), ...(o.zone ? { timeZone: o.zone } : {}),
  });
// A session's cost as its header shows it, digit for digit: wherever the figure is said again it is this.
export const fmtSessionCost = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
export function fmtCost(usd?: number): string {
  if (usd === undefined) return "";
  if (usd < 0.0001) return usd ? "<$0.0001" : "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export function fmtWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Short names for folders that stay apart: the last part of each path, with
// as many parts before it as it takes to differ from the others shown with
// it (`docs`, `beta/api`, `alpha/api`).
export function folderNames(paths: Iterable<string>): Map<string, string> {
  const all = [...new Set(paths)];
  const parts = new Map<string, string[]>(all.map((p) => [p, p.split("/").filter(Boolean)]));
  const depth = new Map<string, number>(all.map((p) => [p, 1]));
  const label = (p: string) => parts.get(p)!.slice(-depth.get(p)!).join("/") || p;
  for (let changed = true; changed; ) {
    changed = false;
    const by = new Map<string, string[]>();
    for (const p of all) (by.get(label(p)) ?? by.set(label(p), []).get(label(p))!).push(p);
    for (const same of by.values()) {
      if (same.length < 2) continue;
      for (const p of same) if (depth.get(p)! < parts.get(p)!.length) { depth.set(p, depth.get(p)! + 1); changed = true; }
    }
  }
  return new Map(all.map((p) => [p, label(p)]));
}

// How a scroll the page starts by itself moves: a glide, or at once for
// someone whose system asks for reduced motion (the CSS rule for it covers
// animations and transitions, not scrolls asked for from script).
export const scrollMotion = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth");

// The message box of a session's pane takes the keyboard. (No other pane's box stands in
// for one that is not drawn yet: what is typed would go to another session.) `own`: a key
// of the owner's that names the box asked for it (the command that goes to it, Escape from
// a row of the conversation); else it is a move by code, and when that takes the keyboard
// from a card, Enter in the box sends nothing within the settle time of it (lib/asks.ts).
export const focusBox = (id: string, own = true) => {
  // (Not one under a look or the start page: that session stays drawn there, out of reach.)
  const box = document.querySelector<HTMLElement>(`[data-station="${CSS.escape(id)}"] [data-testid="composer"]:not([inert] *)`);
  if (own) ownFocus(box, true);
  else box?.focus();
};
