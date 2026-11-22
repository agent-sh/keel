// Runs browser specs several times, the files in another order each time, and
// prints the tests that did not pass every time: the ones that always fail,
// the ones that fail now and then, and for those the spec files that ran
// before them in every failing run and in no passing one (a spec that leaves
// something behind). For a reviewer telling a change's failures from the
// suite's own.
//
//   bun scripts/flake.ts SPEC...                 three runs through scripts/smoke.sh
//   bun scripts/flake.ts                         every spec of test/e2e
//   bun scripts/flake.ts --runs 5 --seed 7 SPEC...
//   KEEL_URL=http://127.0.0.1:PORT bun scripts/flake.ts SPEC...   against that scratch daemon
//   bun scripts/flake.ts --via "CMD ARGS" [--read FILE] SPEC...   through another command
//
// The first run is in the order by name, as a plain `playwright test` runs
// them; each later one is shuffled from the seed (printed, and given again
// with --seed to repeat a run). playwright.config.ts runs named files in the
// order named. `--via` names the command that takes the spec files as its
// last arguments; `--read` the file that command leaves its list report in,
// when it does not print it whole. Further Playwright options go after `--`
// (`-- --repeat-each=3`). The logs of the runs are kept under --out (a new
// folder under $TMPDIR by default).
//
// Exit code: 0 when every test passed or was skipped in every run, 1 when one
// failed, 2 for a command line it does not take.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Outcome = "pass" | "fail" | "skip";
export type Run = { order: string[]; results: Map<string, Outcome[]> };

// One line of the list reporter: "  ✓  12 [003 copy] › test/e2e/copy.spec.ts:77:1 › a failed copy says so (1.2s)".
const LINE = /^\s+(✓|✘|-)\s+\d+\s+(?:\[[^\]]*\] › )?(\S+\.spec\.ts):(\d+):\d+ › (.*?)(?: \((?:\d+(?:\.\d+)?(?:ms|s|m))\))?\s*$/;
const WORD: Record<string, Outcome> = { "✓": "pass", "✘": "fail", "-": "skip" };

// What a run's list report says: each test's outcomes (several with --repeat-each) and the files in the order they ran.
export function parseRun(report: string): Run {
  const run: Run = { order: [], results: new Map() };
  for (const line of report.split("\n")) {
    const m = LINE.exec(line.replace(/\u001b\[[0-9;]*m/g, ""));
    if (!m) continue;
    const file = m[2]!.replace(/^.*test\/e2e\//, "test/e2e/");
    const key = `${file}:${m[3]} › ${m[4]}`;
    if (!run.order.includes(file)) run.order.push(file);
    run.results.set(key, [...(run.results.get(key) ?? []), WORD[m[1]!]!]);
  }
  return run;
}

// A shuffle that the same seed gives again (mulberry32).
export function shuffled<T>(list: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

export type Row = { test: string; runs: string[]; kind: "passes" | "fails" | "flaky" | "skipped"; failed: number; ran: number; after: string[] };

// A test over the runs. `after`: for one that failed in some runs and passed in others, the files that
// ran before its own in every run it failed in and in none it passed in.
export function table(runs: Run[]): Row[] {
  const tests = [...new Set(runs.flatMap((r) => [...r.results.keys()]))].sort();
  return tests.map((test) => {
    const file = test.slice(0, test.indexOf(".spec.ts") + 8);
    const got = runs.map((r) => r.results.get(test) ?? []);
    const all = got.flat();
    const failed = all.filter((o) => o === "fail").length, passed = all.filter((o) => o === "pass").length;
    const kind = failed && !passed ? "fails" : failed ? "flaky" : passed ? "passes" : "skipped";
    const before = (r: Run) => new Set(r.order.slice(0, Math.max(0, r.order.indexOf(file))));
    let after: string[] = [];
    if (kind === "flaky") {
      const bad = runs.filter((_, i) => got[i]!.includes("fail")).map(before);
      const good = runs.filter((_, i) => got[i]!.length && !got[i]!.includes("fail")).map(before);
      after = bad.length && good.length ? [...bad[0]!].filter((f) => bad.every((b) => b.has(f)) && !good.some((g) => g.has(f))) : [];
    }
    return { test, runs: got.map((g) => (g.length ? g.map((o) => (o === "fail" ? "FAIL" : o)).join(",") : "not run")), kind, failed, ran: failed + passed, after };
  });
}

export function report(rows: Row[], runs: number, everything = false): string {
  const shown = rows.filter((r) => everything || r.kind === "fails" || r.kind === "flaky");
  const out: string[] = [];
  const cls = (r: Row) => (r.kind === "fails" ? "fails every time" : r.kind === "flaky" ? `flaky: failed ${r.failed} of ${r.ran}` : r.kind === "skipped" ? "skipped" : "passes");
  if (shown.length) {
    out.push(`| test | ${Array.from({ length: runs }, (_, i) => `run ${i + 1}`).join(" | ")} | class |`);
    out.push(`| --- | ${Array.from({ length: runs }, () => "---").join(" | ")} | --- |`);
    for (const r of shown) out.push(`| ${r.test.replaceAll("|", "\\|")} | ${r.runs.join(" | ")} | ${cls(r)}${r.after.length ? `; only after ${r.after.length > 6 ? `${r.after.length} files` : r.after.join(", ")}` : ""} |`);
  }
  const n = (k: Row["kind"]) => rows.filter((r) => r.kind === k).length;
  out.push(`${rows.length} tests in ${runs} run${runs === 1 ? "" : "s"}: ${n("passes")} passed every time, ${n("fails")} failed every time, ${n("flaky")} flaky, ${n("skipped")} skipped every time.`);
  return out.join("\n");
}

if (import.meta.main) {
  const top = resolve(import.meta.dir, "..");
  const usage = (why: string): never => { console.error(`flake: ${why}\n       bun scripts/flake.ts [--runs N] [--seed N] [--via "CMD"] [--read FILE] [--out DIR] [--all] [SPEC...] [-- PLAYWRIGHT OPTIONS]`); process.exit(2); };
  const argv = process.argv.slice(2);
  let runs = 3, seed = Math.floor(Math.random() * 1e9), via = "", read = "", out = "", everything = false;
  const specs: string[] = [], more: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => argv[++i] ?? usage(`${a} takes a value`);
    if (a === "--") { more.push(...argv.slice(i + 1)); break; }
    else if (a === "--runs") runs = Number(value());
    else if (a === "--seed") seed = Number(value());
    else if (a === "--via") via = value();
    else if (a === "--read") read = resolve(value());
    else if (a === "--out") out = resolve(value());
    else if (a === "--all") everything = true;
    else if (a.startsWith("-")) usage(`unknown option ${a}`);
    else specs.push(a);
  }
  if (!Number.isInteger(runs) || runs < 1) usage("--runs takes a whole number, 1 or more");
  if (!Number.isInteger(seed)) usage("--seed takes a whole number");
  const files = (specs.length ? specs : readdirSync(join(top, "test/e2e")).filter((f) => f.endsWith(".spec.ts")).map((f) => `test/e2e/${f}`)).sort();
  // Against the daemon the caller named, else a daemon of the run's own.
  const command = via || (process.env.KEEL_URL ? "node_modules/.bin/playwright test" : "bash scripts/smoke.sh");
  out ||= mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-flake."));
  mkdirSync(out, { recursive: true });
  console.log(`flake: ${files.length} spec file${files.length === 1 ? "" : "s"}, ${runs} run${runs === 1 ? "" : "s"}, seed ${seed}, through \`${command}\`; logs in ${out}`);
  const done: Run[] = [];
  for (let n = 1; n <= runs; n++) {
    const order = n === 1 ? files : shuffled(files, seed + n);
    writeFileSync(join(out, `run-${n}.order`), order.join("\n") + "\n");
    const started = Date.now();
    const p = Bun.spawn(["bash", "-c", `${command} "$@"`, "flake", ...order, ...more], { cwd: top, stdout: "pipe", stderr: "pipe" });
    const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const log = read ? readFileSync(read, "utf8") : text;
    writeFileSync(join(out, `run-${n}.log`), read ? `${log}\n--- the command's own output ---\n${text}${err}` : `${text}${err}`);
    const run = parseRun(log);
    const all = [...run.results.values()].flat();
    console.log(`flake: run ${n} of ${runs} (${n === 1 ? "by name" : "shuffled"}): ${all.filter((o) => o === "pass").length} passed, ${all.filter((o) => o === "fail").length} failed, ${all.filter((o) => o === "skip").length} skipped in ${Math.round((Date.now() - started) / 1000)} s (exit ${code})`);
    if (!all.length) console.log(`flake: run ${n} reported no test: see ${join(out, `run-${n}.log`)}`);
    done.push(run);
  }
  const rows = table(done);
  console.log(`\n${report(rows, runs, everything)}`);
  process.exit(rows.some((r) => r.kind === "fails" || r.kind === "flaky") || done.some((r) => !r.results.size) ? 1 : 0);
}
