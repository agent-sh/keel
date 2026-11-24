// How many passed and failed, from the summary a test tool, a typechecker or a
// linter prints at its end. Pure: the end of a log in, counts out, nothing when
// no summary this knows is there. The last summary wins (a watch run prints
// one per round); cargo's are summed (one per test binary), and so are go's
// package lines.

export type Counts = { pass?: number; fail?: number };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const lastOf = (text: string, re: RegExp): RegExpExecArray | undefined => {
  let m: RegExpExecArray | null, last: RegExpExecArray | undefined;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = g.exec(text))) last = m;
  return last;
};
const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));

export function countsOf(log: string): Counts | undefined {
  const t = log.replace(ANSI, "").replace(/\r/g, "");
  // cargo test: "test result: ok. 12 passed; 0 failed; ..." once per binary.
  const cargo = [...t.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)];
  if (cargo.length) return { pass: cargo.reduce((n, m) => n + Number(m[1]), 0), fail: cargo.reduce((n, m) => n + Number(m[2]), 0) };
  // bun test: " 37 pass" and " 2 fail" on lines of their own.
  const bunPass = lastOf(t, /^\s*(\d+) pass$/m), bunFail = lastOf(t, /^\s*(\d+) fail$/m);
  if (bunPass || bunFail) return { pass: num(bunPass?.[1]) ?? 0, fail: num(bunFail?.[1]) ?? 0 };
  // jest: "Tests:       2 failed, 1 skipped, 40 passed, 43 total".
  const jest = lastOf(t, /^Tests:\s+(.*\d+ total)$/m);
  if (jest) return { pass: num(/(\d+) passed/.exec(jest[1]!)?.[1]) ?? 0, fail: num(/(\d+) failed/.exec(jest[1]!)?.[1]) ?? 0 };
  // vitest: " Tests  2 failed | 40 passed (42)".
  const vitest = lastOf(t, /^\s*Tests\s+(.*)\(\d+\)\s*$/m);
  if (vitest && /passed|failed/.test(vitest[1]!)) return { pass: num(/(\d+) passed/.exec(vitest[1]!)?.[1]) ?? 0, fail: num(/(\d+) failed/.exec(vitest[1]!)?.[1]) ?? 0 };
  // pytest: "==== 2 failed, 40 passed in 1.23s ====".
  const pytest = lastOf(t, /^=+ (.*\d+ (?:passed|failed|error).*) in [\d.]+s(?: \([^)]*\))? =+$/m);
  if (pytest) return { pass: num(/(\d+) passed/.exec(pytest[1]!)?.[1]) ?? 0, fail: (num(/(\d+) failed/.exec(pytest[1]!)?.[1]) ?? 0) + (num(/(\d+) errors?/.exec(pytest[1]!)?.[1]) ?? 0) };
  // Playwright: "  40 passed (1.2m)", "  2 failed", "  1 flaky" on lines of their own.
  const pwPass = lastOf(t, /^\s+(\d+) passed \([\d.]+m?s?\)$/m);
  if (pwPass) return { pass: Number(pwPass[1]), fail: num(lastOf(t, /^\s+(\d+) failed$/m)?.[1]) ?? 0 };
  // mocha: "40 passing (2s)" and "2 failing".
  const mocha = lastOf(t, /^\s*(\d+) passing \(/m);
  if (mocha) return { pass: Number(mocha[1]), fail: num(lastOf(t, /^\s*(\d+) failing$/m)?.[1]) ?? 0 };
  // go test: a line a package, "ok  \tpkg\t0.1s" or "FAIL\tpkg\t0.1s".
  const goOk = [...t.matchAll(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)].length, goFail = [...t.matchAll(/^FAIL\s+\S+\s+[\d.]+s$/gm)].length;
  if (goOk || goFail) return { pass: goOk, fail: goFail };
  // tsc: "Found 3 errors in 2 files." or "Found 1 error."
  const tsc = lastOf(t, /^Found (\d+) errors?\b/m);
  if (tsc) return { fail: Number(tsc[1]) };
  // eslint: "✖ 5 problems (3 errors, 2 warnings)".
  const eslint = lastOf(t, /^✖ \d+ problems? \((\d+) errors?/m);
  if (eslint) return { fail: Number(eslint[1]) };
  return undefined;
}

// The names of what failed, from the lines a test tool or a typechecker prints for each failure: bun's
// "(fail) a > b", jest's "● a › b", pytest's "FAILED path::test", go's "--- FAIL: TestX", cargo's
// "test x ... FAILED", Playwright's "✘ ... › test", and tsc's "file(line,col): error TSn" (as
// "file:line TSn"). Each name once, in the order printed; at most `max`.
export function failedNames(log: string, max = 50): string[] {
  const t = log.replace(ANSI, "").replace(/\r/g, "");
  const out: string[] = [];
  const add = (s: string | undefined) => { const n = s?.trim().replace(/\s+\[[\d.]+\s*m?s\]$/, "").replace(/\s+\([\d.]+m?s\)$/, ""); if (n && !out.includes(n) && out.length < max) out.push(n); };
  for (const m of t.matchAll(/^\(fail\) (.+)$/gm)) add(m[1]);
  for (const m of t.matchAll(/^\s*● (.+ › .+)$/gm)) add(m[1]);
  for (const m of t.matchAll(/^FAILED (\S+::\S+)/gm)) add(m[1]);
  for (const m of t.matchAll(/^\s*--- FAIL: (\S+)/gm)) add(m[1]);
  for (const m of t.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) add(m[1]);
  for (const m of t.matchAll(/^\s*[✘×] +\d+ .*? › (.+)$/gm)) add(m[1]);
  for (const m of t.matchAll(/^([^\s(][^(\n]*)\((\d+),\d+\): error (TS\d+)/gm)) add(`${m[1]}:${m[2]} ${m[3]}`);
  for (const m of t.matchAll(/^([^\s:][^:\n]*):(\d+):\d+ - error (TS\d+)/gm)) add(`${m[1]}:${m[2]} ${m[3]}`);
  return out;
}
