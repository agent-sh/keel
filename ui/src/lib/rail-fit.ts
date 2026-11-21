// The folded rail has room for `rows` marks and every band must be on it. Each
// band gets one row, then the room left goes to the bands in their order
// (what needs the owner first). The answer is the rows each band takes; a
// band given fewer rows than it has marks shows one mark less and ends in a
// count of the rest.
export function fitBands(counts: number[], rows: number | null): number[] {
  const total = counts.reduce((n, c) => n + c, 0);
  if (rows === null || total <= rows) return counts;
  const out = counts.map((c) => Math.min(c, 1));
  let left = rows - out.reduce((n, c) => n + c, 0);
  for (let i = 0; i < counts.length && left > 0; i++) {
    const add = Math.min(counts[i]! - out[i]!, left);
    out[i]! += add;
    left -= add;
  }
  return out;
}
