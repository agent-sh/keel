// A dollar cap over a rolling window for the whole daemon: dollars per N hours across every session.
// What a view shows of it, when the owner is told, and when it holds. Pure; the ledger reads are in
// src/automation/window-cap.ts. Nothing here knows a price or a model.
//
// Off until the owner sets both numbers: no default is invented. At 80 percent the owner is told once.
// At 100 percent a model request of a turn the owner did not start is held, with the reason stated,
// until the window rolls under the cap; a turn the owner started goes on, with a note.

import { localDay, localTime } from "../core/clock.ts";

export const WINDOW_WARN_AT = 0.8;
export const HOUR_MS = 3_600_000;

export type WindowCap = { usd: number; hours: number; ms: number };
export type WindowLevel = "ok" | "warn" | "spent";
export type WindowView = { usd: number; hours: number; spent: number; pct: number; level: WindowLevel };

const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

// The cap the settings name: both numbers, or none (a half-set cap holds nothing).
export const windowCapOf = (v: { usd?: unknown; hours?: unknown } | undefined): WindowCap | undefined =>
  v && positive(v.usd) && positive(v.hours) ? { usd: v.usd, hours: v.hours, ms: v.hours * HOUR_MS } : undefined;

// The settings check: each is a number above 0, or null.
export const checkWindow = (v: { usd?: unknown; hours?: unknown }): string | undefined =>
  [v.usd, v.hours].some((x) => x !== null && !positive(x)) ? "usd and hours are numbers above 0, or null" : undefined;

export function windowView(cap: WindowCap, spent: number): WindowView {
  const level: WindowLevel = spent >= cap.usd ? "spent" : spent >= cap.usd * WINDOW_WARN_AT ? "warn" : "ok";
  return { usd: cap.usd, hours: cap.hours, spent, pct: spent / cap.usd, level };
}

// The sum the window holds at `now`: the rows inside it. A row counts from its own time to that time
// plus the window.
export const inWindow = (rows: { ts: number; usd: number }[], now: number, cap: WindowCap) =>
  rows.reduce((n, r) => (r.ts >= now - cap.ms && r.ts <= now ? n + r.usd : n), 0);

// When the spend of the rows in the window falls under the cap as they roll out, oldest first: the time
// of the first moment that holds. `now` when it is under already.
export function rollsUnderAt(rows: { ts: number; usd: number }[], now: number, cap: WindowCap): number {
  const live = rows.filter((r) => r.ts >= now - cap.ms && r.ts <= now).sort((a, b) => a.ts - b.ts);
  let total = live.reduce((n, r) => n + r.usd, 0);
  if (total < cap.usd) return now;
  for (const r of live) {
    total -= r.usd;
    if (total < cap.usd) return r.ts + cap.ms + 1;
  }
  return now;
}

// Cents for a dollar and up, two figures below a dime: a small cap never reads $0.00.
export const dollars = (n: number) => `$${n >= 1 ? n.toFixed(2).replace(/\.00$/, "") : n >= 0.1 ? n.toFixed(2) : String(Number(n.toPrecision(2)))}`;
export const hoursWords = (h: number) => (h === 1 ? "an hour" : `${Number(h.toFixed(2))} hours`);
// A time of today is the clock; one of another day names the day (a window of a day rolls under tomorrow).
const clock = (ms: number, now = Date.now()) => (localDay(ms) === localDay(now) ? "" : `${localDay(ms)} `) + localTime(ms).slice(0, 5);

export const windowLine = (v: WindowView) => `${dollars(v.spent)} of the ${dollars(v.usd)} spend cap for ${hoursWords(v.hours)} (${Math.floor(v.pct * 100)} percent), counted over every session`;

export const windowWarnTitle = (v: WindowView) => `Spend window at ${Math.floor(v.pct * 100)} percent`;
export const windowWarnBody = (v: WindowView) => `${windowLine(v)}. At the cap, new requests of loops, wakes, monitors and agents wait until the window rolls under it; your own messages still run.`;

// Why a request waits: said in the session's status, its note and the alert.
export const windowHeldWhy = (v: WindowView, until?: number) =>
  `the spend cap of ${dollars(v.usd)} for ${hoursWords(v.hours)} is reached (${dollars(v.spent)} spent)${until ? `; it rolls under at about ${clock(until)}` : ""}`;
export const windowHeldNote = (v: WindowView, until?: number) =>
  `This turn waits: ${windowHeldWhy(v, until)}. It goes on by itself when the window rolls under the cap, or when the owner raises or clears the cap in Settings > Usage.`;
export const windowHeldAlert = (v: WindowView, until?: number) =>
  `${windowLine(v)}. New requests of loops, wakes, monitors and agents wait${until ? ` until about ${clock(until)}` : " until the window rolls under the cap"}. Your own messages still run.`;
export const windowOwnerNote = (v: WindowView) =>
  `The spend cap of ${dollars(v.usd)} for ${hoursWords(v.hours)} is reached (${dollars(v.spent)} spent). This turn goes on because the owner started it; loops, wakes and agents wait.`;
