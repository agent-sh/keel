// The daily values the regression alert watches, each on an XmR chart: the last 24 hours against
// the 14 windows of 24 hours before it. Reads only, so the read thread runs it (src/server/read-tasks.ts).
import type { Database } from "bun:sqlite";
import { xmr, XMR_MIN } from "./stats.ts";

const DAY = 86_400_000;

export type RegressionRow = {
  metric: string; label: string; bad: "high" | "low"; value: number | null; n: number; baseline_days: number;
  needs_days: number; limits: ReturnType<typeof xmr>; status: string; regression: boolean;
};

export function regressionRows(db: Database, now: number): RegressionRow[] {
  const window = (k: number) => [now - (k + 1) * DAY, now - k * DAY] as const;
  const metrics: { id: string; label: string; bad: "high" | "low"; value: (a: number, b: number) => { v: number; n: number } | null }[] = [
    { id: "cache_read_share", label: "cache read share of turn requests", bad: "low", value: (a, b) => {
      const r = db.query<{ read: number | null; prompt: number | null; n: number }, [number, number]>("SELECT SUM(cache_read) AS read, SUM(input + cache_read + cache_write) AS prompt, COUNT(*) AS n FROM telemetry_calls WHERE outcome = 'ok' AND COALESCE(purpose, 'turn') = 'turn' AND ts >= ? AND ts < ?").get(a, b)!;
      return r.prompt ? { v: r.read! / r.prompt, n: r.n } : null;
    } },
    { id: "error_rate", label: "share of model requests that failed", bad: "high", value: (a, b) => {
      const r = db.query<{ e: number; n: number }, [number, number]>("SELECT SUM(outcome = 'error') AS e, COUNT(*) AS n FROM telemetry_calls WHERE ts >= ? AND ts < ?").get(a, b)!;
      return r.n ? { v: r.e / r.n, n: r.n } : null;
    } },
    { id: "cost_per_turn", label: "mean cost per turn", bad: "high", value: (a, b) => {
      const r = db.query<{ c: number | null; n: number }, [number, number]>("SELECT AVG(cost) AS c, COUNT(cost) AS n FROM telemetry_turns WHERE ts >= ? AND ts < ?").get(a, b)!;
      return r.n ? { v: r.c!, n: r.n } : null;
    } },
  ];
  return metrics.map((m) => {
    const now0 = m.value(...window(0));
    const base = Array.from({ length: 14 }, (_, i) => m.value(...window(i + 1))).filter((x): x is { v: number; n: number } => !!x).reverse();
    const lim = xmr(base.map((b) => b.v));
    const status = !now0 ? "no data" : !lim ? "baseline too short" : now0.v > lim.upper ? "high" : now0.v < lim.lower ? "low" : "ok";
    return { metric: m.id, label: m.label, bad: m.bad, value: now0?.v ?? null, n: now0?.n ?? 0, baseline_days: base.length, needs_days: XMR_MIN, limits: lim, status, regression: status === m.bad };
  });
}
