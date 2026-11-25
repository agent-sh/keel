// The budget of interruptions: the phone gets at most N pushes an hour. The
// ones whose wait costs most go as they are; the rest fold into one digest push
// ("4 more: 1 needs you, 2 done, 1 failed") that takes the last free slot of the
// hour. Nothing that needs the owner is dropped, and none waits long: it is told
// alone while a slot is free, else inside the digest. When no slot is free, what
// needs the owner is held at most `NEED_MS`: it goes out as one push of its own
// ("2 need you: ...") at most every `NEED_MS`, counted past the budget, not in it.
// What does not need the owner is held until the next slot opens (the oldest push
// of the hour leaves it).
// The decisions are pure (`plan`, `nextFree`, `digestOf`); `PushBudget` runs them.
import { byCost } from "../../core/wait-rank.ts";

export const WINDOW_MS = 60 * 60_000;
// What is told in one go: items that come within this span are ranked together.
export const SETTLE_MS = 2000;
// The longest a question or an approval waits for a push when the hour's slots are spent: a turn and
// its agents wait on it, so it goes out past the budget, at most one push of that kind in this span.
export const NEED_MS = 10 * 60_000;
// Six an hour: in the owner's last 30 days of interruptions (128 of them) no hour of the
// last three days passed 4 and 6 of 46 busy hours passed 6, all of them bursts of approvals.
export const DEFAULT_PER_HOUR = 6;

export type Tier = "need" | "failed" | "report" | "done";
export const TIERS: readonly Tier[] = ["need", "failed", "report", "done"];
// What each kind of alert is to the one who reads the phone: the first in the order of attention.
const TIER_OF: Record<string, Tier> = {
  approval: "need", question: "need", mcp: "need",
  failed: "failed", loop_failed: "failed", regression: "failed", declined: "failed", outage: "failed", limit: "failed",
  finished: "done", review: "done",
};
export const tierOf = (kind: string): Tier => TIER_OF[kind] ?? "report";
const WORD: Record<Tier, (n: number) => string> = {
  need: (n) => (n === 1 ? "1 needs you" : `${n} need you`),
  failed: (n) => `${n} failed`,
  report: (n) => (n === 1 ? "1 report" : `${n} reports`),
  done: (n) => `${n} done`,
};

export type Held = { id: string; ts: number; kind: string; wait?: { key: number } | null; label?: string };

// The order of attention: what needs the owner first, then failures, then what an agent says, then
// what finished; inside a class the costliest wait first, then the one asked first (src/core/wait-rank.ts).
export function rank<T extends Held>(items: readonly T[]): T[] {
  const t = (x: T) => TIERS.indexOf(tierOf(x.kind));
  return [...items].sort((a, b) => t(a) - t(b) || byCost(a, b));
}

// The pushes of the last hour (their times) and the room left in it.
const inWindow = (sent: readonly number[], now: number, win = WINDOW_MS) => sent.filter((t) => t > now - win);
export const freeSlots = (sent: readonly number[], now: number, limit: number, win = WINDOW_MS) =>
  limit > 0 ? Math.max(0, limit - inWindow(sent, now, win).length) : Infinity;

// When the next slot is free: now, or when the push that fills the hour is an hour old.
export function nextFree(sent: readonly number[], now: number, limit: number, win = WINDOW_MS): number {
  if (limit <= 0) return now;
  const live = inWindow(sent, now, win).sort((a, b) => a - b);
  return live.length < limit ? now : live[live.length - limit]! + win;
}

// What goes now out of what waits to be told, given `free` slots: all of it, each alone, when it fits;
// else the best of it alone and one digest of the rest (the digest has a slot of its own, the last).
// With no slot free nothing goes and everything is held. Every item is in exactly one of the three.
export function plan<T extends Held>(queue: readonly T[], free: number): { alone: T[]; digest: T[]; held: T[] } {
  const ranked = rank(queue);
  if (free <= 0) return { alone: [], digest: [], held: ranked };
  if (ranked.length <= free) return { alone: ranked, digest: [], held: [] };
  return { alone: ranked.slice(0, free - 1), digest: ranked.slice(free - 1), held: [] };
}

// "4 more: 1 needs you, 2 done, 1 failed", what needs the owner first.
export function digestOf(items: readonly Held[]): { title: string; body: string; need: number; failed: number } {
  const n: Record<Tier, number> = { need: 0, failed: 0, report: 0, done: 0 };
  for (const x of items) n[tierOf(x.kind)]++;
  const words = TIERS.filter((t) => n[t] > 0).map((t) => WORD[t](n[t]));
  return { title: `${items.length} more`, body: `${items.length} more: ${words.join(", ")}`, need: n.need, failed: n.failed };
}

// "2 need you: Which color?; Run rm?": the push for what needs the owner when no slot of the hour is free.
export function needsOf(items: readonly Held[]): { title: string; body: string } {
  const n = items.length, title = n === 1 ? "1 needs you" : `${n} need you`;
  const names = items.slice(0, 3).map((x) => x.label?.trim()).filter(Boolean) as string[];
  const rest = n - Math.min(n, 3);
  return { title, body: names.length ? `${title}: ${names.join("; ")}${rest ? `; and ${rest} more` : ""}` : title };
}

export type BudgetStatus = {
  limit: number; sent: number; held: number; held_need: number;
  // The pushes of the last hour that went past the budget (what needs the owner, with no slot free).
  over: number;
  // When the first of what is held goes out; what needs the owner never later than NEED_MS after its last such push.
  next_slot: number | null; window_ms: number;
};

type Hooks<T extends Held> = {
  limit: () => number;
  // One alert, told alone; the digest of what was folded. Each resolves when the push left (a throw is each item's failure).
  alone: (item: T) => Promise<void>;
  digest: (items: T[]) => Promise<void>;
  // What needs the owner, told past the budget when no slot is free: one alone, or several in one push.
  over: (items: T[]) => Promise<void>;
  // Answered or read while it waited: nothing is told of it.
  moot: (item: T) => boolean;
  now?: () => number;
  timer?: (fn: () => void, ms: number) => unknown;
  clear?: (t: unknown) => void;
  // The times of the pushes of the last hour that an earlier run of the daemon made.
  seed?: () => number[];
};

export class PushBudget<T extends Held> {
  private sent: number[] | undefined;
  private over: number[] = [];
  private queue: { item: T; done: () => void; fail: (e: unknown) => void }[] = [];
  private settle: unknown;
  private later: unknown;
  constructor(private h: Hooks<T>) {}
  private now = () => (this.h.now ?? Date.now)();
  private stamps(): number[] {
    this.sent ??= (this.h.seed?.() ?? []).slice();
    return this.sent;
  }

  // Resolves when the alert was told (alone or in a digest) or no longer needs telling.
  offer(item: T): Promise<void> {
    return new Promise<void>((done, fail) => {
      this.queue.push({ item, done, fail });
      if (this.settle === undefined) this.settle = (this.h.timer ?? setTimeout)(() => { this.settle = undefined; this.flush(); }, SETTLE_MS);
    });
  }

  status(): BudgetStatus {
    const now = this.now(), limit = this.h.limit(), live = this.queue.filter((q) => !this.h.moot(q.item));
    const sent = inWindow(this.stamps(), now);
    const need = live.filter((q) => tierOf(q.item.kind) === "need").length;
    const slot = limit > 0 ? nextFree(sent, now, limit) : now;
    return {
      limit, sent: sent.length, held: live.length, held_need: need, over: inWindow(this.over, now).length,
      next_slot: live.length ? (need ? Math.min(slot, this.needAt(now)) : slot) : null, window_ms: WINDOW_MS,
    };
  }

  // When what needs the owner may next go past the budget: now, or NEED_MS after the last such push.
  private needAt(now: number): number {
    const last = Math.max(0, ...inWindow(this.over, now, NEED_MS));
    return last ? last + NEED_MS : now;
  }

  private flush() {
    const now = this.now(), limit = this.h.limit();
    const stamps = this.stamps();
    // The hour only keeps what is in it.
    this.sent = stamps.filter((t) => t > now - WINDOW_MS);
    const waiting: typeof this.queue = [];
    for (const q of this.queue) (this.h.moot(q.item) ? q.done() : waiting.push(q));
    this.queue = [];
    const by = new Map(waiting.map((q) => [q.item.id, q]));
    const { alone, digest, held: all } = plan(waiting.map((q) => q.item), freeSlots(this.sent, now, limit));
    // No slot free: what needs the owner goes out past the budget unless such a push left less than NEED_MS ago.
    const needs = all.filter((i) => tierOf(i.kind) === "need");
    const past = needs.length && this.needAt(now) <= now ? needs : [];
    const held = all.filter((i) => !past.includes(i));
    const settle = (items: T[], sending: Promise<void>) => sending.then(() => items.forEach((i) => by.get(i.id)!.done()), (e) => items.forEach((i) => by.get(i.id)!.fail(e)));
    for (const i of alone) { this.sent.push(now); void settle([i], this.h.alone(i)); }
    if (digest.length) { this.sent.push(now); void settle(digest, this.h.digest(digest)); }
    if (past.length) { this.over.push(now); void settle(past, this.h.over(past)); }
    this.over = inWindow(this.over, now);
    this.queue = held.map((i) => by.get(i.id)!);
    this.arm();
  }

  // What is held is told when the next slot opens.
  private arm() {
    (this.h.clear ?? clearTimeout)(this.later as never);
    this.later = undefined;
    if (!this.queue.length) return;
    const now = this.now();
    let at = nextFree(this.stamps(), now, this.h.limit());
    if (this.queue.some((q) => tierOf(q.item.kind) === "need")) at = Math.min(at, this.needAt(now));
    const ms = Math.max(SETTLE_MS, at - now);
    this.later = (this.h.timer ?? setTimeout)(() => { this.later = undefined; this.flush(); }, ms);
    (this.later as { unref?: () => void })?.unref?.();
  }
}
