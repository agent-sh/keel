import { expect, test } from "bun:test";
import { cardDays, countCards, type Card } from "./cards-days.ts";

test("Jerusalem days split at local midnight, including short and long DST days", () => {
  const hour = 3_600_000;
  for (const [today, midnight, hours] of [
    ["2026-03-28T12:00Z", "2026-03-27T21:00Z", 23],
    ["2026-10-26T12:00Z", "2026-10-25T22:00Z", 25],
  ] as const) {
    const days = cardDays(Date.parse(today));
    const day = days.at(-2)!;
    const end = Date.parse(midnight);
    expect(days).toHaveLength(8);
    expect(day.until_ms).toBe(end);
    expect(day.until_ms - day.from_ms).toBe(hours * hour);
    expect(days.at(-1)!.from_ms).toBe(end);
    const base = { mode: "full-auto", build: "first", kinds: ["approval", "account", "private_words"] } as const;
    const cards: Card[] = [
      { ...base, id: "approval:same", at: end - 1 },
      { ...base, id: "approval:same", at: end, build: "later" },
      { id: "question:new", at: end, mode: null, build: null, kinds: ["question"] },
    ];
    const grouped = countCards(days, cards);
    expect(grouped.at(-2)).toMatchObject({
      cards: 1, by_kind: { approval: 1, account: 1, private_words: 1 },
      builds: [{ build: "first", by_mode: { "full-auto": { cards: 1 } } }],
    });
    expect(grouped.at(-1)).toMatchObject({
      cards: 1, by_kind: { question: 1 }, builds: [{ build: null, by_mode: { unknown: { cards: 1 } } }],
    });
  }
});
