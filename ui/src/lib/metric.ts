// A metric value in its own unit.
export function fmtMetric(unit: string, v: number | null | undefined, signed = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "none";
  const s = signed && v > 0 ? "+" : "";
  if (unit === "usd") return `${s}${v < 0 ? "-" : ""}$${Math.abs(v) < 0.01 ? Math.abs(v).toFixed(5) : Math.abs(v).toFixed(4)}`;
  if (unit === "share") return `${s}${(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}${signed ? " pt" : "%"}`;
  if (unit === "ms") return `${s}${(v / 1000).toFixed(1)} s`;
  if (unit === "tokens") return `${s}${Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)}`;
  return `${s}${v.toFixed(v % 1 ? 2 : 0)}`;
}
