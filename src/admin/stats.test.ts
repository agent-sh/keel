import { describe, expect, test } from "bun:test";
import { assignArm, diffInterval, labelBet, meanInterval, msprt, phi, phiInv, rng, xmr } from "./stats.ts";

describe("arm assignment", () => {
  test("is deterministic and follows the weights", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `session-${i}`);
    const first = ids.map((id) => assignArm("exp-1", id, [1, 1]));
    expect(ids.map((id) => assignArm("exp-1", id, [1, 1]))).toEqual(first);
    const share = first.filter((a) => a === 1).length / ids.length;
    expect(share).toBeGreaterThan(0.46);
    expect(share).toBeLessThan(0.54);
    const skew = ids.map((id) => assignArm("exp-1", id, [3, 1])).filter((a) => a === 1).length / ids.length;
    expect(skew).toBeGreaterThan(0.21);
    expect(skew).toBeLessThan(0.29);
    // Another experiment splits the same sessions independently.
    const other = ids.map((id) => assignArm("exp-2", id, [1, 1]));
    const agree = other.filter((a, i) => a === first[i]).length / ids.length;
    expect(agree).toBeGreaterThan(0.45);
    expect(agree).toBeLessThan(0.55);
  });
  test("refuses weights that sum to nothing", () => {
    expect(() => assignArm("e", "s", [0, 0])).toThrow();
  });
});

describe("normal distribution", () => {
  test("phi and its inverse agree", () => {
    for (const p of [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) expect(phi(phiInv(p))).toBeCloseTo(p, 6);
    expect(phiInv(0.975)).toBeCloseTo(1.959964, 5);
  });
});

describe("bootstrap intervals", () => {
  // A skewed sample (log-normal costs): the interval covers the true mean at
  // about the stated rate over many draws.
  test("BCa covers a skewed mean at about 95%", () => {
    const r = rng(7);
    const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    const trueMean = Math.exp(0.5); // log-normal(0, 1)
    let covered = 0;
    const trials = 300;
    for (let t = 0; t < trials; t++) {
      const units = Array.from({ length: 30 }, () => ({ v: Math.exp(normal()) }));
      const iv = meanInterval(units, { reps: 1000, seed: t + 1 });
      if (iv.lo <= trueMean && trueMean <= iv.hi) covered++;
    }
    expect(covered / trials).toBeGreaterThan(0.88);
    expect(covered / trials).toBeLessThan(0.99);
  });
  test("a clear difference is significant and a null one is not", () => {
    const a = Array.from({ length: 12 }, (_, i) => ({ v: 10 + (i % 4) }));
    const b = Array.from({ length: 12 }, (_, i) => ({ v: 6 + (i % 4) }));
    const d = diffInterval(a, b);
    expect(d.estimate).toBeCloseTo(-4, 6);
    expect(d.significant).toBe(true);
    expect(d.hi).toBeLessThan(0);
    const same = diffInterval(a, a.map((u) => ({ ...u })));
    expect(same.significant).toBe(false);
  });
  test("strata keep the task mix: a big task difference does not drown the effect", () => {
    // Two tasks of very different size; the arm saves 1 on each.
    const a = [100, 101, 99, 5, 6, 4].map((v, i) => ({ v, stratum: i < 3 ? "big" : "small" }));
    const b = [99, 100, 98, 4, 5, 3].map((v, i) => ({ v, stratum: i < 3 ? "big" : "small" }));
    expect(diffInterval(a, b).significant).toBe(true);
    expect(diffInterval(a.map(({ v }) => ({ v })), b.map(({ v }) => ({ v }))).significant).toBe(false);
  });
  test("clusters widen the interval when a session's turns move together", () => {
    const units = (base: number) => Array.from({ length: 4 }, (_, s) => Array.from({ length: 5 }, () => ({ v: base + s * 3, cluster: `s${s}` }))).flat();
    const turns = meanInterval(units(0).map(({ v }) => ({ v })));
    const sessions = meanInterval(units(0));
    expect(sessions.hi - sessions.lo).toBeGreaterThan(turns.hi - turns.lo);
  });
});

describe("guards and alerts", () => {
  test("mSPRT rejects a large regression and keeps a null", () => {
    const zeros = Array(20).fill(0), ones = Array(20).fill(1);
    expect(msprt(zeros, ones, 0.1).reject).toBe(true);
    const mixed = Array.from({ length: 20 }, (_, i) => i % 2);
    expect(msprt(mixed, mixed.slice().reverse(), 0.1).reject).toBe(false);
    expect(msprt([0], [1], 0.1).reject).toBe(false);
  });
  test("a label bet is fair at every step, whatever the values, and grows only when the labelled run higher", () => {
    const r = rng(11);
    const xs = Array.from({ length: 40 }, () => Math.exp(3 * r())); // skewed, no model fits it
    for (const p of [0.5, 0.25]) {
      // Two bettors on the same history that differ in the last label: the evidence before
      // it is the chance-weighted mean of the two after it (a martingale, exactly).
      for (let n = 2; n <= xs.length; n += 7) {
        const labels = xs.slice(0, n - 1).map(() => r() < p);
        const [yes, no] = [labelBet(p, (m) => 0.3 * m), labelBet(p, (m) => 0.3 * m)];
        let before = 1;
        labels.forEach((l, i) => { before = yes.add(xs[i]!, l); no.add(xs[i]!, l); });
        expect(p * yes.add(xs[n - 1]!, true) + (1 - p) * no.add(xs[n - 1]!, false)).toBeCloseTo(before, 9);
      }
    }
    // The labelled half shifted up by one deviation: evidence past 20. Shifted down: none.
    const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    const [up, down] = [labelBet(0.5, () => 1), labelBet(0.5, () => 1)];
    for (let i = 0; i < 200; i++) { const l = i % 2 === 0, z = normal(); up.add(z + (l ? 1 : 0), l); down.add(z - (l ? 1 : 0), l); }
    expect(up.evidence).toBeGreaterThan(20);
    expect(down.evidence).toBeLessThan(1);
  });
  test("a label bet makes none on values that do not vary, and no bet loses more than half the stake", () => {
    // Equal values that are not exact in floating point: no variance, so no bet, at any label chance.
    for (const p of [0.5, 0.25]) for (const v of [0.7, 1 / 3, 1234.567]) {
      const b = labelBet(p, (m) => 0.25 * Math.abs(m));
      for (let i = 0; i < 6; i++) expect(b.add(v, i % 2 === 0)).toBe(1);
    }
    // Mostly equal values (a variance far below the shift squared), then one on the side the bet was against.
    const b = labelBet(0.5, () => 0.1);
    let before = 1;
    for (let i = 0; i < 30; i++) before = b.add(0, i % 2 === 0);
    expect(b.add(1, false) / before).toBeGreaterThanOrEqual(0.5);
  });
  test("XmR limits come from the moving range and need a baseline", () => {
    expect(xmr([1, 2, 3])).toBeNull();
    const l = xmr([10, 12, 11, 13, 10, 12])!;
    expect(l.mean).toBeCloseTo(68 / 6, 6);
    expect(l.mr).toBeCloseTo((2 + 1 + 2 + 3 + 2) / 5, 6);
    expect(l.upper).toBeCloseTo(68 / 6 + 2.66 * 2, 6);
  });
});
