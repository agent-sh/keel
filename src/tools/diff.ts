// Line diff (Myers) shared by the patch engine and the UI: pure, no imports.

export const splitLines = (s: string) => (s === "" ? [] : (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n"));

export type Op = { t: " " | "-" | "+"; line: string };

export function diffLines(a: string[], b: string[]): Op[] {
  // Common prefix and suffix first: most edits are small, so Myers runs on little.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const N = A.length, M = B.length, MAX = N + M;
  const mid: Op[] = [];
  if (N === 0) for (const l of B) mid.push({ t: "+", line: l });
  else if (M === 0) for (const l of A) mid.push({ t: "-", line: l });
  else {
    const off = MAX;
    let v = new Int32Array(2 * MAX + 2);
    const trace: Int32Array[] = [];
    outer: for (let d = 0; d <= MAX; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { trace.push(v.slice()); break outer; }
      }
    }
    // Walk the trace back from (N, M).
    let x = N, y = M;
    for (let d = trace.length - 2; d > 0 && (x > 0 || y > 0); d--) {
      const vv = trace[d]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
      const px = vv[off + prevK]!;
      const py = px - prevK;
      while (x > px && y > py) { mid.push({ t: " ", line: A[--x]! }); y--; }
      if (x === px) mid.push({ t: "+", line: B[--y]! });
      else mid.push({ t: "-", line: A[--x]! });
    }
    while (x > 0 && y > 0) { mid.push({ t: " ", line: A[--x]! }); y--; }
    mid.reverse();
  }
  return [...a.slice(0, pre).map((line): Op => ({ t: " ", line })), ...mid, ...a.slice(a.length - suf).map((line): Op => ({ t: " ", line }))];
}

// A unified diff with three lines of context, named a/<path> and b/<path>.
export function buildDiff(relPath: string, before: string, after: string): { diff: string; added: number; removed: number } {
  const ops = diffLines(splitLines(before), splitLines(after));
  let added = 0, removed = 0;
  for (const o of ops) { if (o.t === "+") added++; else if (o.t === "-") removed++; }
  if (!added && !removed) return { diff: "", added, removed };
  const CTX = 3;
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`];
  // Group changes whose context windows touch into one hunk.
  const changed = ops.map((o, i) => (o.t !== " " ? i : -1)).filter((i) => i >= 0);
  let g = 0;
  while (g < changed.length) {
    let end = g;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= 2 * CTX) end++;
    const from = Math.max(0, changed[g]! - CTX), to = Math.min(ops.length, changed[end]! + CTX + 1);
    let oldStart = 1, newStart = 1;
    for (let i = 0; i < from; i++) { if (ops[i]!.t !== "+") oldStart++; if (ops[i]!.t !== "-") newStart++; }
    const slice = ops.slice(from, to);
    const oldLen = slice.filter((o) => o.t !== "+").length, newLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`);
    for (const o of slice) out.push(o.t + o.line);
    g = end + 1;
  }
  return { diff: out.join("\n") + "\n", added, removed };
}
