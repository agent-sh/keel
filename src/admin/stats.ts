// The statistics behind experiment reports, guard stops and regression alerts.
// Pure functions, seeded, so a report read twice says the same thing.
//
// - Intervals: BCa bootstrap (bias-corrected and accelerated). Costs and
//   tokens are skewed and n is small; the percentile bootstrap under-covers
//   there, BCa corrects for bias and skew from the data (Efron 1987).
// - Units are resampled in clusters within strata: a live experiment
//   randomizes sessions, so a session's turns move together (cluster = the
//   session); an offline run keeps its task mix fixed (stratum = the task).
// - Guards: mSPRT on the difference of means (Johari et al., the method
//   behind Statsig's sequential testing), always valid, so it may be read
//   after every turn without inflating the false positive rate.
// - Alerts: an individuals (XmR) control chart over daily values.

export type Unit = { v: number; cluster?: string; stratum?: string };

// Mulberry32: a small seeded generator, enough for resampling.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over UTF-8, 32 bits.
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// MurmurHash3's finalizer: FNV alone keeps two ids that differ in one
// character correlated in their high bits, so two experiments would split the
// same sessions alike.
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// The arm a unit gets: its hash with the experiment's id mapped to [0, 1),
// each arm owning a range as wide as its share of the weights. The same
// experiment and unit always get the same arm.
export function assignArm(expId: string, unitId: string, weights: number[]): number {
  const total = weights.reduce((n, w) => n + Math.max(0, w), 0);
  if (!(total > 0)) throw new Error("no arm has a weight above 0");
  const x = fmix32(fnv1a(`${expId}:${unitId}`)) / 4294967296;
  let edge = 0;
  for (let i = 0; i < weights.length; i++) {
    edge += Math.max(0, weights[i]!) / total;
    if (x < edge) return i;
  }
  return weights.length - 1;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
export function variance(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

// Standard normal CDF (Zelen and Severo 26.2.17, error under 7.5e-8).
export function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Its inverse (Acklam's rational approximation, relative error under 1.2e-9).
export function phiInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -phiInv(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

// Units grouped as strata of clusters (a unit with no cluster is its own).
type Groups = Map<string, Unit[][]>;
function groups(units: Unit[]): Groups {
  const strata = new Map<string, Map<string, Unit[]>>();
  units.forEach((u, i) => {
    const s = u.stratum ?? "";
    const m = strata.get(s) ?? strata.set(s, new Map()).get(s)!;
    const c = u.cluster ?? `#${i}`;
    (m.get(c) ?? m.set(c, []).get(c)!).push(u);
  });
  return new Map([...strata].map(([k, m]) => [k, [...m.values()]]));
}
const meanOf = (clusters: Unit[][]) => {
  let n = 0, s = 0;
  for (const c of clusters) for (const u of c) { s += u.v; n++; }
  return n ? s / n : NaN;
};
// One resample: clusters drawn with replacement within each stratum.
function resample(g: Groups, r: () => number): Unit[][] {
  const out: Unit[][] = [];
  for (const cl of g.values()) for (let i = 0; i < cl.length; i++) out.push(cl[Math.floor(r() * cl.length)]!);
  return out;
}
const all = (g: Groups) => [...g.values()].flat();
// Leave-one-cluster-out means, from the totals (linear, not quadratic).
function jackMeans(clusters: Unit[][]): number[] {
  if (clusters.length < 2) return [];
  const sums = clusters.map((c) => c.reduce((a, u) => a + u.v, 0));
  const S = sums.reduce((a, x) => a + x, 0), N = clusters.reduce((a, c) => a + c.length, 0);
  return clusters.map((c, i) => (N - c.length ? (S - sums[i]!) / (N - c.length) : NaN)).filter(Number.isFinite);
}

export type Interval = { estimate: number; lo: number; hi: number; n: number; method: "bca" | "percentile" | "none" };

// BCa interval from the bootstrap replicates, the estimate and the jackknife values.
function bca(estimate: number, reps: number[], jack: number[], level: number): { lo: number; hi: number; method: Interval["method"] } {
  const sorted = reps.filter(Number.isFinite).sort((x, y) => x - y);
  if (!sorted.length || sorted[0] === sorted.at(-1)) return { lo: estimate, hi: estimate, method: "none" };
  const below = sorted.filter((x) => x < estimate).length + 0.5 * sorted.filter((x) => x === estimate).length;
  const z0 = phiInv(Math.min(1 - 1e-9, Math.max(1e-9, below / sorted.length)));
  const jm = mean(jack);
  const num = jack.reduce((a, x) => a + (jm - x) ** 3, 0);
  const den = 6 * Math.pow(jack.reduce((a, x) => a + (jm - x) ** 2, 0), 1.5);
  const acc = den > 0 ? num / den : 0;
  const at = (q: number) => {
    const z = phiInv(q);
    const adj = phi(z0 + (z0 + z) / (1 - acc * (z0 + z)));
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(adj * sorted.length)))]!;
  };
  const alpha = (1 - level) / 2;
  const lo = at(alpha), hi = at(1 - alpha);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || jack.length < 3) {
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
    return { lo: p(alpha), hi: p(1 - alpha), method: "percentile" };
  }
  return { lo, hi, method: "bca" };
}

export type BootOpts = { reps?: number; seed?: number; level?: number };

// The mean of the units with its interval.
export function meanInterval(units: Unit[], o: BootOpts = {}): Interval {
  const g = groups(units);
  const est = meanOf(all(g));
  if (!units.length) return { estimate: NaN, lo: NaN, hi: NaN, n: 0, method: "none" };
  const r = rng(o.seed ?? 1);
  const reps = Array.from({ length: o.reps ?? 2000 }, () => meanOf(resample(g, r)));
  const jack = jackMeans(all(g));
  return { estimate: est, n: units.length, ...bca(est, reps, jack, o.level ?? 0.95) };
}

// The difference of means, b minus a, with its interval: each side
// resampled on its own, within its strata.
export function diffInterval(a: Unit[], b: Unit[], o: BootOpts = {}): Interval & { significant: boolean; relative: number | null } {
  const ga = groups(a), gb = groups(b);
  const ma = meanOf(all(ga)), mb = meanOf(all(gb));
  const est = mb - ma;
  const n = a.length + b.length;
  if (!a.length || !b.length) return { estimate: NaN, lo: NaN, hi: NaN, n, method: "none", significant: false, relative: null };
  const r = rng(o.seed ?? 1);
  const reps = Array.from({ length: o.reps ?? 2000 }, () => meanOf(resample(gb, r)) - meanOf(resample(ga, r)));
  const ca = all(ga), cb = all(gb);
  const jack = [...jackMeans(ca).map((m) => mb - m), ...jackMeans(cb).map((m) => m - ma)];
  const iv = bca(est, reps, jack, o.level ?? 0.95);
  return { estimate: est, n, ...iv, significant: iv.method !== "none" && (iv.lo > 0 || iv.hi < 0), relative: ma ? est / Math.abs(ma) : null };
}

// mSPRT for a difference of means (normal mixture, tau the effect of
// concern): the likelihood ratio of "there is an effect" to "there is none".
// The variance is the null's (both arms pooled about one mean, as a pooled
// proportion test does), so two arms that each never vary still have one.
// Reject at alpha when the ratio reaches 1/alpha; valid at every look.
export function msprt(a: number[], b: number[], tau: number, alpha = 0.05) {
  if (a.length < 2 || b.length < 2 || !(tau > 0)) return { lr: 1, reject: false, diff: b.length && a.length ? mean(b) - mean(a) : NaN, v: NaN };
  const diff = mean(b) - mean(a);
  const v = variance([...a, ...b]) * (1 / a.length + 1 / b.length);
  if (!(v > 0)) return { lr: 1, reject: false, diff, v };
  const t2 = tau * tau;
  const lr = Math.sqrt(v / (v + t2)) * Math.exp((t2 * diff * diff) / (2 * v * (v + t2)));
  return { lr, reject: lr >= 1 / alpha, diff, v };
}

// XmR control limits from a baseline of individual values: the mean plus or
// minus 2.66 times the mean moving range (3 / d2, d2 = 1.128 for ranges of two).
export const XMR_MIN = 6; // usable limits from 5 to 6 points (Wheeler)
export function xmr(baseline: number[]) {
  if (baseline.length < XMR_MIN) return null;
  const m = mean(baseline);
  const ranges = baseline.slice(1).map((x, i) => Math.abs(x - baseline[i]!));
  const mr = mean(ranges);
  return { mean: m, lower: m - 2.66 * mr, upper: m + 2.66 * mr, mr, n: baseline.length };
}
