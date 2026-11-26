// Calendar days, not last-24-hour windows. A day can have 23 or 25 hours.
export const CARD_ZONE = "Asia/Jerusalem";
export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const format = new Intl.DateTimeFormat("en-CA", { timeZone: CARD_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export type Day = { date: string; from_ms: number; until_ms: number };
export function cardDays(now: number): Day[] {
  const label = Date.parse(format.format(now));
  const dates = Array.from({ length: 9 }, (_, i) => label + (i - 7) * DAY_MS);
  const bounds = dates.map((utc) => {
    const date = new Date(utc).toISOString().slice(0, 10);
    let lo = utc - DAY_MS, hi = utc + DAY_MS;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (format.format(mid) < date) lo = mid;
      else hi = mid;
    }
    return { date, from_ms: hi };
  });
  return bounds.slice(0, -1).map((d, i) => ({ ...d, until_ms: bounds[i + 1]!.from_ms }));
}

export const CARD_KINDS = ["approval", "question", "account", "private_words", "unparsed", "provenance"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export type Card = { id: string; at: number; mode: string | null; build: string | null; kinds: readonly CardKind[] };
type Counts = { cards: number; by_kind: Record<CardKind, number> };
type ByMode = Record<string, Counts>;
type Build = Counts & { build: string | null; by_mode: ByMode };
export type CardDay = Day & Counts & { by_mode: ByMode; builds: Build[] };

const counts = (): Counts => ({
  cards: 0, by_kind: { approval: 0, question: 0, account: 0, private_words: 0, unparsed: 0, provenance: 0 },
});
const byMode = (): ByMode => Object.create(null);
const add = (c: Counts, kinds: Set<CardKind>) => { c.cards++; for (const kind of kinds) c.by_kind[kind]++; };

export function countCards(days: Day[], cards: Card[]): CardDay[] {
  const out = days.map((d): CardDay => ({ ...d, ...counts(), by_mode: byMode(), builds: [] }));
  const seen = new Set<string>();
  for (const card of [...cards].sort((a, b) => a.at - b.at)) {
    // The first raise counts, not a reopened card or its answer. Reasons can
    // overlap, but the card counts once in the day, mode and build totals.
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const day = out.find((d) => d.from_ms <= card.at && card.at < d.until_ms);
    if (!day) continue;
    let build = day.builds.find((b) => b.build === card.build);
    if (!build) day.builds.push(build = { build: card.build, ...counts(), by_mode: byMode() });
    const mode = card.mode ?? "unknown", kinds = new Set(card.kinds);
    for (const c of [day, build, (day.by_mode[mode] ??= counts()), (build.by_mode[mode] ??= counts())]) add(c, kinds);
  }
  return out;
}
