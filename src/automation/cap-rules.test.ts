import { describe, expect, test } from "bun:test";
import { BURN_WINDOW_MS, capClosing, capLine, capView, dollars, levelOf, raisedCap, warnDue, windowOf } from "./cap-rules.ts";

const now = 10_000_000;
const facts = (o: Partial<{ usd: number; spent: number; recent: number; from: number }> = {}) => ({ usd: 10, spent: 0, recent: 0, from: now - 3_600_000, now, ...o });

describe("the burn rate and the forecast", () => {
  test("the rate is the last ten minutes' spend as dollars an hour; the forecast adds an hour of it", () => {
    const v = capView(facts({ spent: 4, recent: 1 }));
    expect(v.burn_hour).toBeCloseTo(6, 9);
    expect(v.forecast_hour).toBeCloseTo(10, 9);
    // $6 left at $6 an hour: an hour to the cap.
    expect(v.ms_to_cap).toBeCloseTo(3_600_000, 3);
  });

  test("nothing spent lately is no rate: the forecast is the spend and the cap is not reached", () => {
    const v = capView(facts({ spent: 4, recent: 0 }));
    expect(v.burn_hour).toBe(0);
    expect(v.forecast_hour).toBe(4);
    expect(v.ms_to_cap).toBeNull();
  });

  test("a cap younger than ten minutes reads its rate over its own life, never under a minute", () => {
    expect(windowOf(now - 2 * 60_000, now)).toBe(120_000);
    expect(windowOf(now - 5_000, now)).toBe(60_000);
    expect(windowOf(now - 3_600_000, now)).toBe(BURN_WINDOW_MS);
    // $0.50 in the two minutes since it was set: $15 an hour.
    expect(capView(facts({ from: now - 120_000, spent: 0.5, recent: 0.5 })).burn_hour).toBeCloseTo(15, 9);
    // One step a second after: a minute's window, not a second's.
    expect(capView(facts({ from: now - 1_000, spent: 0.1, recent: 0.1 })).burn_hour).toBeCloseTo(6, 9);
  });

  test("a reached cap has no time left, and its percent may pass 100", () => {
    const v = capView(facts({ spent: 12, recent: 2 }));
    expect(v.ms_to_cap).toBe(0);
    expect(v.pct).toBeCloseTo(1.2, 9);
    expect(v.level).toBe("spent");
  });
});

describe("the 80 and 100 percent rules", () => {
  test("the levels change at 80 and at 100 percent, on the line itself", () => {
    expect(levelOf(7.99, 10)).toBe("ok");
    expect(levelOf(8, 10)).toBe("warn");
    expect(levelOf(9.99, 10)).toBe("warn");
    expect(levelOf(10, 10)).toBe("spent");
    expect(levelOf(30, 10)).toBe("spent");
  });

  test("the 80 percent is told once for a cap, and again for a raised one or a cap that began again", () => {
    const cap = { usd: 10, from: 5 };
    const warn = capView(facts({ spent: 8.2 }));
    expect(warnDue(capView(facts({ spent: 7 })), undefined, cap)).toBe(false);
    expect(warnDue(warn, undefined, cap)).toBe(true);
    expect(warnDue(warn, { usd: 10, from: 5 }, cap)).toBe(false);
    // Past the cap, still told once when it was not told on the way (a long step crossed both lines).
    expect(warnDue(capView(facts({ spent: 11 })), undefined, cap)).toBe(true);
    expect(warnDue(capView(facts({ spent: 11 })), { usd: 10, from: 5 }, cap)).toBe(false);
    // Raised: its own 80 percent is told again.
    expect(warnDue(capView(facts({ usd: 20, spent: 16.5 })), { usd: 10, from: 5 }, { usd: 20, from: 5 })).toBe(true);
    expect(warnDue(warn, { usd: 10, from: 4 }, cap)).toBe(true);
  });

  test("one press doubles a cap, and goes above an overshoot", () => {
    expect(raisedCap(5, 4.2)).toBe(10);
    expect(raisedCap(5, 5.3)).toBe(10);
    // Spent 12 on a cap of 5: room above the spend, not 10.
    expect(raisedCap(5, 12)).toBe(18);
    expect(raisedCap(0.004, 0.0052)).toBe(0.008);
    expect(levelOf(12, raisedCap(5, 12))).toBe("ok");
  });
});

describe("the words", () => {
  test("a line gives the spend, the cap, the rate and the forecast", () => {
    const line = capLine(capView(facts({ spent: 8.2, recent: 1.5 })));
    expect(line).toBe("$8.20 of the $10 cap (82 percent); at the last ten minutes' rate of $9 an hour it is $17.20 in an hour, and the cap is reached in 12 minutes");
    expect(capLine(capView(facts({ spent: 8.2 })))).toContain("nothing was spent in the last ten minutes");
  });

  test("a small cap never reads $0.00", () => {
    expect(dollars(0.004)).toBe("$0.004");
    expect(dollars(0.25)).toBe("$0.25");
    expect(dollars(5)).toBe("$5");
  });

  test("the last step's words name whose cap it is", () => {
    expect(capClosing(5, 5.1)).toContain("The dollar cap of this session is reached ($5; spent $5.10)");
    expect(capClosing(5, 5.1)).toContain("The owner can raise the cap to go on");
    expect(capClosing(5, 5.1, "Top")).toContain('The dollar cap of "Top", the session above you, is reached');
    expect(capClosing(5, 5.1, "Top")).toContain("any agents you started stop with you");
  });
});
