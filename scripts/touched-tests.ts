// The unit tests a change touches, run: what the landing queue checks besides the whole-tree checks.
//
//   bun scripts/touched-tests.ts [--base REF] [--list]
//
// The change is HEAD and the working tree against where HEAD left REF (main by default). The tests are
// the unit check's test files (its `tests` globs in .keel/checks.json), ranked the way the checks beside
// an agent rank them (src/checks/beside.ts testsFor), the most direct first, at most PICK_MAX. They run
// in one `bun test --timeout 60000`; none touched: nothing runs and it passes. --list prints them only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PICK_MAX, refsIn, testsFor, type Refs } from "../src/checks/beside.ts";

const top = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const at = args.indexOf("--base");
const base = at >= 0 ? args[at + 1] : "main";
if (!base || !/^[\w./@-]+$/.test(base)) { console.error("touched-tests: --base takes a ref"); process.exit(2); }

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd: top, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) { console.error(`touched-tests: git ${a.join(" ")}: ${r.stderr.toString().trim()}`); process.exit(2); }
  return r.stdout.toString().split("\n").filter(Boolean);
};
const from = git("merge-base", base, "HEAD")[0]!;
// What the change holds and is still there (a removed file has no test of its own to run).
const changed = [...new Set([...git("diff", "--name-only", "--diff-filter=d", from, "HEAD"), ...git("diff", "--name-only", "--diff-filter=d", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")])];

const unit = (JSON.parse(readFileSync(join(top, ".keel/checks.json"), "utf8")) as { checks: { unit?: { tests?: string[] } } }).checks.unit;
const globs = (unit?.tests ?? []).map((g) => new Bun.Glob(g));
const tests = git("ls-files", "--cached", "--others", "--exclude-standard").filter((f) => globs.some((g) => g.match(f)));
const refsOf = (path: string): Refs | undefined => { try { return refsIn(readFileSync(join(top, path), "utf8"), path); } catch { return undefined; } };
const pick = testsFor(changed, tests, refsOf).slice(0, PICK_MAX);

console.log(`touched-tests: ${changed.length} changed files since ${from.slice(0, 9)} (${base}); ${pick.length ? `${pick.length} test files` : "no test file touched"}`);
if (args.includes("--list")) { for (const t of pick) console.log(t); process.exit(0); }
if (!pick.length) process.exit(0);
const run = Bun.spawnSync(["bun", "test", "--timeout", "60000", ...pick.map((t) => `./${t}`)], { cwd: top, stdio: ["ignore", "inherit", "inherit"] });
process.exit(run.exitCode ?? 1);
