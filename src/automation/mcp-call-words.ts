// How long a call to an MCP server may run at most, in words: the page says it where a background call is listed
// ("stopped at its limit of 28 hours"), instead of the time the wait gives up, which is that limit plus a minute.
export function ceilingWords(ms: number): string {
  const n = (k: number, unit: string) => `${k} ${unit}${k === 1 ? "" : "s"}`;
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return n(s, "second");
  const m = Math.round(s / 60);
  if (m < 90) return n(m, "minute");
  const h = Math.round(s / 3600);
  if (h < 48) return n(h, "hour");
  return n(Math.round(s / 86_400), "day");
}
