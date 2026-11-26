// Branches checked together before they land. The overlap forecast (src/worktree/overlap-scan.ts) says
// which live branches merge clean; after each of its passes, the pairs of those branches that touch
// related code (src/landing/pairs.ts relatedPairs) are merged on the base in a worktree of Keel's own and
// the repository's fast checks run there: its named checks that take no words, and its unit check with
// the tests of the pair (pairs.ts fastChecks, pairTests). Only when a check fails together do the sides
// run it alone, on the same base; a check that fails together and passes on each side alone is run
// together once more, and red twice is a pair that breaks: said on both agents' cards (the board reads
// this table) and to each agent's parent once, as a failure in its scope (src/automation/failures.ts).
//
// A result is kept by the pair's two heads: nothing is checked again until one of them moves. A pair is
// due when both heads have been still for `quiet_s`; at most `at_once` pairs run at a time across the
// daemon, and each command takes a slot of the heavy-command pool (src/tools/heavy.ts), so a pair waits
// while the machine has no room. The checks run at a low priority here, or on the host the owner's
// setting names (`together.host`, anything ssh reaches) while its load leaves room. Nothing runs on the
// loop: git and the checks are processes of their own.
//
// The cost (measured 2026-11-24 on this repository). A pair runs the typecheck and the tests that reach
// both sides: 16 processor seconds in the median, 10 to 56 seconds of wall time (a slow test file is most
// of it). A soak of 10 minutes, six live branches each moving every four minutes: 2 of the 15 pairs were
// related, 4 pairs ran, 81 processor seconds in all (passes included), nothing waited in line; at that
// rate 24 pairs and 8 processor minutes an hour. On a tree of 12 branches, 49% of the pairs are related
// (32 of 66); a head that settles makes its related pairs due, about 5 of them, so at three settles a
// head an hour (an estimate) 12 x 3 x 5 = 180 pairs and about 48 processor minutes an hour, under one
// core. Two at once (`at_once`) give that many pairs about 50 minutes of slot time an hour; a pair whose
// head moves before it runs is dropped, so the line holds only pairs of heads that are still there, and
// the rest of the machine stays with the work the owner waits on: a pair's answer is wanted before a
// landing, which is minutes away, not at once.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { homeDir } from "../core/paths.ts";
import { tempEnv } from "../core/temp.ts";
import { join } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import { packagesFor, readsIn, INSTALL_MS } from "../checks/before-run.ts";
import { failedNames } from "../checks/counts.ts";
import { inputsOf, keyOf, onTree, record, repoOf, settingFor } from "../checks/ledger.ts";
import { overlay, parseChecks, readChecks, type Check } from "../checks/named.ts";
import { release } from "../checks/package-cache.ts";
import { flakyOn } from "../checks/words.ts";
import { git } from "../core/git.ts";
import { cpuMsOf, readText, outputOf } from "../core/proc.ts";
import type { Store } from "../core/store.ts";
import { pool } from "../tools/heavy.ts";
import { git as worktreeGit } from "../worktree/manager.ts";
import type { Overlaps } from "../worktree/overlap-scan.ts";
import { brokenText, commandOf, due, fastChecks, graphOf, hubsOf, hunksOf, IMPORT_PATHS, noTestFiles, pairKey, pairTests, redText, relatedPairs, setupLineOf, testMatcher, verdictOf, type Graph, type Related, type Res, type Side, type Verdict } from "./pairs.ts";
import { readTail } from "./queue.ts";
import { importLines, readTree } from "./repo-map.ts";
import { readLand } from "./rules.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pair_checks (
  repo TEXT NOT NULL, tip1 TEXT NOT NULL, tip2 TEXT NOT NULL, branch1 TEXT NOT NULL, branch2 TEXT NOT NULL,
  base TEXT, base_tip TEXT, rules TEXT, why TEXT NOT NULL, detail TEXT, state TEXT NOT NULL, checks TEXT, runs TEXT, place TEXT,
  error TEXT, started INTEGER NOT NULL, ended INTEGER, told INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, tip1, tip2)
);
CREATE INDEX IF NOT EXISTS pair_checks_branches ON pair_checks(repo, branch1, branch2);
CREATE INDEX IF NOT EXISTS pair_checks_branch2 ON pair_checks(repo, branch2);
CREATE TABLE IF NOT EXISTS pair_tips (repo TEXT NOT NULL, branch TEXT NOT NULL, tip TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (repo, branch));
`;

// running: its checks run now. green, red, flaky, own: pairs.ts Verdict. error: it could not be built or run.
export type PairState = "running" | Verdict["state"] | "error";
export type PairRow = {
  repo: string; tip1: string; tip2: string; branch1: string; branch2: string; base: string | null; base_tip: string | null; rules: string | null;
  why: string; detail: string | null; state: PairState; checks: string | null; runs: string | null; place: string | null;
  error: string | null; started: number; ended: number | null; told: number;
};

export const DEFAULTS = { at_once: 2, quiet_s: 120, host: null as string | null, host_dir: ".cache/keel-pairs", host_setup: null as string | null, load_share: 0.83 };
export type Config = typeof DEFAULTS;
registerSettings("together", DEFAULTS as unknown as Record<string, unknown>, (v: any) => {
  if (!v || typeof v !== "object") return "together is an object";
  if (v.at_once !== undefined && (!Number.isInteger(v.at_once) || v.at_once < 0 || v.at_once > 16)) return "together.at_once is a whole number from 0 (off) to 16";
  if (v.quiet_s !== undefined && (typeof v.quiet_s !== "number" || v.quiet_s < 0 || v.quiet_s > 86_400)) return "together.quiet_s is seconds from 0 to 86400";
  // (Never one ssh would read as an option.)
  if (v.host !== undefined && v.host !== null && (typeof v.host !== "string" || !/^[\w.@][\w.@-]{0,119}$/.test(v.host))) return "together.host is a name ssh reaches (not starting with -), or null";
  if (v.host_dir !== undefined && (typeof v.host_dir !== "string" || !/^[\w./-]{1,200}$/.test(v.host_dir) || v.host_dir.split("/").includes(".."))) return "together.host_dir is a folder under the host's home";
  if (v.host_setup !== undefined && v.host_setup !== null && (typeof v.host_setup !== "string" || v.host_setup.length > 400)) return "together.host_setup is a command of up to 400 characters, or null";
  if (v.load_share !== undefined && (typeof v.load_share !== "number" || v.load_share <= 0 || v.load_share > 4)) return "together.load_share is a share of the host's processors over 0";
  return undefined;
});
export const config = (): Config => ({ ...DEFAULTS, ...(settings().together ?? {}) });

export type TogetherDeps = {
  error: (e: unknown, at: string) => void;
  // The sessions whose board reads the pair (each side's holder and the sessions above it).
  changed: (sessionIds: string[]) => void;
  // A pair that breaks, told to `to` (a side's parent, or the side's own session at the top) once.
  tell: (to: string, f: { message: string; ref?: { id: string; label?: string } }) => void;
  // The pairs of a repository cannot be checked where they run (red on both sides alone, a setup that
  // fails): told to the owner, once.
  broken: (message: string) => void;
  // Who a session is for a note: its agent's id and title, when it is an agent's.
  agentOf: (sessionId: string) => { id: string; title: string } | undefined;
  // `shown`: folders outside the folder that the command may read (the base's packages linked into it), read-only.
  confine: (argv: string[], sessionId: string | null, folder: string, shown?: string[]) => string[];
  env: (sessionId: string | null) => Record<string, string>;
};

// What the error of a pair starts with when its checks lacked something the tree is given.
const MISSING = "setup missing: ";
// The version of how a pair's commands are built (src/landing/pairs.ts commandOf). 2: the tests are paths with `./`
// (a bare path was a name filter for bun test and matched no file).
const COMMANDS = 2;
const NO_EDIT = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
const KEEL_IDENT = { GIT_AUTHOR_NAME: "Keel", GIT_AUTHOR_EMAIL: "keel@localhost", GIT_COMMITTER_NAME: "Keel", GIT_COMMITTER_EMAIL: "keel@localhost" };
// A finished pair is kept two weeks (as the landing queue keeps its entries), the newest KEEP_ROWS.
const KEEP_MS = 14 * 86_400_000;
const KEEP_ROWS = 5_000;
// What a pass waits after the forecast's, so the passes of one step make one.
const SETTLE_MS = 500;
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
// (A UUIDv7's random part: the same each run under a fixed world, src/core/fixed-world.ts.)
const newId = () => `pc-${Bun.randomUUIDv7().replace(/-/g, "").slice(-18)}`;
const short = (b: string) => b.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");

// The process groups of the checks: killed with the daemon.
const groups = new Set<number>();
const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
process.on("exit", () => { for (const g of groups) killGroup(g); });

// `rules`: a print of what the base names for the pairs (the checks' commands and the setup): a broken
// repository is held until its base or this changes.
type Job = { id: string; repo: string; base: string; baseTip: string; rules: string; a: Side; b: Side; rel: Related; who: string | null; checks: Check[]; setup?: string; timeoutMs: number };
type Step = { check: Check; command: string };
// (`text`: the end of the output, where a host's run has no log file here.)
type Ran = Res & { ms: number; answered?: true; log?: string; text?: string };

export class Together {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanning = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private line: Job[] = [];
  private running = new Set<string>(); // `${repo}\0${tip1}\0${tip2}`
  private graphs = new Map<string, { known: Set<string>; lines: { path: string; line: string }[]; touched: Map<string, number>; commits: number }>(); // `${repo}\0${baseTip}`
  private changes = new Map<string, Side["files"] | null>(); // `${tip} ${baseTip}`
  private work = new Set<Promise<unknown>>();
  // dropped: a pair whose head moved before it ran or between its runs (its answer would be old).
  stats = { passes: 0, due: 0, ran: 0, red: 0, dropped: 0 };

  constructor(private store: Store, private ov: Overlaps, private d: TogetherDeps) {
    store.migrate(SCHEMA);
    // A pair a stop cut is checked again: its row goes.
    store.db.query("DELETE FROM pair_checks WHERE state = 'running'").run();
    rmSync(join(store.stateDir, "pairs", "wt"), { recursive: true, force: true });
  }

  // ---- what others read

  // The pairs of `branches` whose two heads are the tips the repository's branches have now (`tips`:
  // every branch's), for the board.
  of(repo: string, branches: string[], tips: ReadonlyMap<string, string>): PairRow[] {
    if (!branches.length) return [];
    const rows = this.store.db.query<PairRow, [string, string]>("SELECT * FROM pair_checks WHERE repo = ?1 AND (branch1 IN (SELECT value FROM json_each(?2)) OR branch2 IN (SELECT value FROM json_each(?2)))").all(repo, JSON.stringify(branches));
    return rows.filter((r) => tips.get(r.branch1) === r.tip1 && tips.get(r.branch2) === r.tip2);
  }

  // Resolves when nothing of `repo` runs or waits to (a test's end).
  async idle(repo?: string) {
    for (let i = 0; i < 1000; i++) {
      const t = repo ? this.timers.get(repo) : undefined;
      if (t) { clearTimeout(t); this.timers.delete(repo!); void this.scan(repo!); }
      const s = repo ? this.scanning.get(repo) : [...this.scanning.values()][0];
      if (s) { await s; continue; }
      if (!this.work.size) return;
      await Promise.all([...this.work]);
    }
  }

  // ---- passes

  schedule(repo: string, ms = SETTLE_MS) {
    const had = this.timers.get(repo);
    if (had) return;
    const t = setTimeout(() => { this.timers.delete(repo); void this.scan(repo); }, ms);
    t.unref?.();
    this.timers.set(repo, t);
  }

  scan(repo: string): Promise<void> {
    const cur = this.scanning.get(repo);
    if (cur) { this.again.add(repo); return cur; }
    const p = this.pass(repo).catch((e) => this.d.error(e, "pair checks")).finally(() => {
      this.scanning.delete(repo);
      if (this.again.delete(repo)) void this.scan(repo);
    });
    this.scanning.set(repo, p);
    return p;
  }

  private async pass(repo: string) {
    const cfg = config();
    if (!cfg.at_once) return;
    this.stats.passes++;
    this.prune();
    const owners = this.ov.owners(repo);
    if (owners.size < 2) return;
    const baseRef = await this.ov.baseOf(repo);
    if (!baseRef) return;
    const listed = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...[...owners.keys()].map((b) => `refs/heads/${b}`), baseRef], { read: true });
    if (listed.code !== 0) return;
    const refTips = new Map(listed.out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, string]));
    const baseTip = refTips.get(baseRef);
    if (!baseTip) return;
    const tipOf = (b: string) => refTips.get(`refs/heads/${b}`);
    // A pair in line whose head moved, or whose branch is no longer live, would be checked on a head that
    // is not there: it goes (its new heads make a pair of their own below).
    const before = this.line.length;
    this.line = this.line.filter((j) => j.repo !== repo || (tipOf(j.a.branch) === j.a.tip && tipOf(j.b.branch) === j.b.tip));
    this.stats.dropped += before - this.line.length;
    const now = Date.now();
    // When each head was first seen where it is now.
    const seen = new Map<string, number>();
    for (const b of owners.keys()) {
      const tip = tipOf(b);
      if (!tip) continue;
      const r = this.store.db.query<{ tip: string; seen: number }, [string, string]>("SELECT tip, seen FROM pair_tips WHERE repo = ? AND branch = ?").get(repo, b);
      if (r?.tip === tip) seen.set(b, r.seen);
      else { this.store.db.query("INSERT OR REPLACE INTO pair_tips (repo, branch, tip, seen) VALUES (?, ?, ?, ?)").run(repo, b, tip, now); seen.set(b, now); }
    }
    // The forecast's pairs at the tips there are now: branches that merge clean with the base, and pairs of them that merge clean.
    const rows = this.ov.pairRows(repo);
    const fresh = (b: string, t: string) => tipOf(b) === t;
    const withBase = new Set(rows.filter((r) => r.base && !r.conflict && !r.error && r.b_tip === baseTip && fresh(r.a, r.a_tip)).map((r) => r.a));
    const clean = rows.filter((r) => !r.base && !r.conflict && !r.error && withBase.has(r.a) && withBase.has(r.b) && fresh(r.a, r.a_tip) && fresh(r.b, r.b_tip));
    if (!clean.length) return;
    // What the repository's base names: its fast checks, its setup and its time limit.
    const rules = await this.rulesOf(repo, baseTip);
    if (!rules || "off" in rules.pairs || "problem" in rules.pairs) return;
    const checks = rules.pairs.checks;
    // (COMMANDS: how the pair's commands are built. A row broken by an older build's commands is not this build's.)
    const print = hashOf(JSON.stringify([COMMANDS, checks.map((c) => [c.name, c.run, c.dir]), rules.setup ?? ""]));
    // A repository whose pairs were broken here (red on both sides alone, or a setup that fails) is not
    // checked again until its base or what it names for the pairs changes: each pair would cost three runs
    // and say the same.
    const last = this.store.db.query<{ state: string; base_tip: string | null; rules: string | null; error: string | null }, [string]>("SELECT state, base_tip, rules, error FROM pair_checks WHERE repo = ? AND state NOT IN ('running', 'error') ORDER BY COALESCE(ended, started) DESC LIMIT 1").get(repo);
    // (What the checks lacked, packages or programs, is not the base's: the next pair is tried, it costs the runs that fail at once.)
    if (last?.state === "broken" && last.base_tip === baseTip && last.rules === print && !last.error?.startsWith(MISSING)) return;
    const unit = checks.find((c) => c.tests);
    const isTest = testMatcher(unit?.tests);
    const branches = [...new Set(clean.flatMap((r) => [r.a, r.b]))];
    const sides: Side[] = [];
    for (const b of branches) {
      const files = await this.changed(repo, tipOf(b)!, baseTip);
      if (files) sides.push({ branch: b, tip: tipOf(b)!, files });
    }
    const g = await this.graph(repo, baseTip, sides);
    const at = this.graphs.get(`${repo}\0${baseTip}`);
    const known = at?.known ?? new Set<string>();
    const hubs = hubsOf({ touched: at?.touched ?? new Map(), commits: at?.commits ?? 0, g });
    // Where two sides both change a hub file, the lines they change there.
    const inHubs = new Map<string, number>();
    for (const s of sides) for (const f of s.files) if (hubs.has(f)) inHubs.set(f, (inHubs.get(f) ?? 0) + 1);
    for (const s of sides) {
      const mine = s.files.filter((f) => (inHubs.get(f) ?? 0) > 1);
      if (mine.length) s.hunks = await this.hunks(repo, s.tip, baseTip, mine);
    }
    const related = relatedPairs(sides, g, [...known].filter(isTest), isTest, hubs);
    const want = new Set(clean.map((r) => (r.a < r.b ? `${r.a}\0${r.b}` : `${r.b}\0${r.a}`)));
    const quietMs = cfg.quiet_s * 1000;
    let next = Infinity;
    for (const rel of related) {
      if (!want.has(`${rel.a}\0${rel.b}`)) continue;
      const a = sides.find((s) => s.branch === rel.a)!, b = sides.find((s) => s.branch === rel.b)!;
      const k = pairKey(repo, a.tip, b.tip);
      const id = `${repo}\0${k.tip1}\0${k.tip2}`;
      if (this.running.has(id) || this.line.some((j) => j.id === id)) continue;
      if (this.store.db.query("SELECT 1 FROM pair_checks WHERE repo = ? AND tip1 = ? AND tip2 = ?").get(repo, k.tip1, k.tip2)) continue;
      const sa = seen.get(a.branch) ?? now, sb = seen.get(b.branch) ?? now;
      if (!due(sa, sb, now, quietMs)) { next = Math.min(next, Math.max(sa, sb) + quietMs - now); continue; }
      const holder = owners.get(a.branch) ?? owners.get(b.branch) ?? null;
      this.stats.due++;
      this.line.push({ id, repo, base: short(baseRef), baseTip, rules: print, a, b, rel, who: holder ? this.store.session(holder)?.parent_id ?? holder : null, checks, ...(rules.setup ? { setup: rules.setup } : {}), timeoutMs: rules.timeoutMs });
    }
    // A pair waiting for its heads to be still is looked at again when they will have been.
    if (next < Infinity) {
      const t = setTimeout(() => void this.scan(repo), Math.max(1_000, next + 50));
      t.unref?.();
    }
    this.pump();
  }

  // The rules as the base's own commit names them, with the owner's setting laid over.
  private async rulesOf(repo: string, baseTip: string): Promise<{ pairs: ReturnType<typeof fastChecks>; setup?: string; timeoutMs: number } | undefined> {
    const shown = await git(repo, ["show", `${baseTip}:.keel/checks.json`], { read: true });
    let raw: any;
    try { raw = shown.code === 0 ? JSON.parse(shown.out) : undefined; } catch { raw = undefined; }
    const file = shown.code === 0 ? parseChecks(shown.out) : undefined;
    const r = repoOf(repo);
    const setting = r ? settingFor(r.scope) as any : undefined;
    const named = overlay(file, setting === undefined ? undefined : readChecks(setting));
    if (!named) return undefined;
    const land = readLand(setting?.land ?? raw?.land);
    return { pairs: fastChecks(named.checks, setting?.pairs ?? raw?.pairs), ...(land.setup ? { setup: land.setup } : {}), timeoutMs: land.timeoutMs };
  }

  // The files a branch changed since it left the base: null when git cannot say.
  private async changed(repo: string, tip: string, baseTip: string): Promise<string[] | null> {
    const key = `${tip} ${baseTip}`;
    if (this.changes.has(key)) return this.changes.get(key)!;
    let files: string[] | null = null;
    const mb = (await git(repo, ["merge-base", baseTip, tip], { read: true })).out.trim().split("\n")[0];
    if (mb) {
      const d = await git(repo, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", mb, tip], { read: true });
      if (d.code === 0) files = d.out.split("\0").filter(Boolean);
    }
    if (this.changes.size > 4096) this.changes.clear();
    this.changes.set(key, files);
    return files;
  }

  // The lines a branch changed in `files` since it left the base (the merge base's numbering).
  private hunkCache = new Map<string, Side["hunks"]>();
  private async hunks(repo: string, tip: string, baseTip: string, files: string[]): Promise<Side["hunks"]> {
    const key = `${tip} ${baseTip} ${files.join("\0")}`;
    if (this.hunkCache.has(key)) return this.hunkCache.get(key);
    const mb = (await git(repo, ["merge-base", baseTip, tip], { read: true })).out.trim().split("\n")[0];
    let out: Side["hunks"];
    if (mb) {
      const d = await git(repo, ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", mb, tip, "--", ...files.map((f) => `:(literal)${f}`)], { read: true, timeout: 60_000 });
      if (d.code === 0) out = hunksOf(d.out);
    }
    if (this.hunkCache.size > 4096) this.hunkCache.clear();
    this.hunkCache.set(key, out);
    return out;
  }

  // The import graph of the base's tree with each side's own import lines in place of the base's for
  // the files it changed. The base's lines are read once a base tip.
  private async graph(repo: string, baseTip: string, sides: Side[]): Promise<Graph> {
    const k = `${repo}\0${baseTip}`;
    let at = this.graphs.get(k);
    if (!at) {
      // (And the base's recent work, for its hub files: pairs.ts hubsOf.)
      at = await readTree(repo, baseTip);
      for (const key of this.graphs.keys()) if (key.startsWith(`${repo}\0`)) this.graphs.delete(key);
      this.graphs.set(k, at);
    }
    const changed = new Set(sides.flatMap((s) => s.files));
    const lines = at.lines.filter((l) => !changed.has(l.path));
    const known = new Set(at.known);
    for (const s of sides) {
      const mine = s.files.filter((f) => IMPORT_PATHS.some((p) => f.endsWith(p.slice(1))));
      if (mine.length) lines.push(...(await importLines(repo, s.tip, mine.map((f) => `:(literal)${f}`))));
      for (const f of s.files) known.add(f);
    }
    // (An import is resolved against every file either side may hold.)
    return graphOf(lines, known);
  }

  // ---- running

  private pump() {
    const cfg = config();
    while (this.running.size < cfg.at_once && this.line.length) {
      const j = this.line.shift()!;
      if (this.running.has(j.id)) continue;
      this.running.add(j.id);
      const p = this.run(j).catch((e) => this.d.error(e, "pair check")).finally(() => { this.running.delete(j.id); this.work.delete(p); this.pump(); });
      this.work.add(p);
    }
  }

  // The sessions whose boards show a side: its holder and every session above it.
  private viewers(repo: string, branches: string[]): string[] {
    const owners = this.ov.owners(repo);
    const out = new Set<string>();
    for (const b of branches) for (let id: string | null | undefined = owners.get(b), i = 0; id && i < 16; i++) { out.add(id); id = this.store.session(id)?.parent_id; }
    return [...out];
  }

  // Whether either side's head moved since the pair was put in line (or its branch went).
  private async moved(j: Job): Promise<boolean> {
    const now = await git(j.repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/heads/${j.a.branch}`, `refs/heads/${j.b.branch}`], { read: true });
    if (now.code !== 0) return true;
    const cur = new Map(now.out.split("\n").filter(Boolean).map((l) => l.split("\0") as [string, string]));
    return cur.get(`refs/heads/${j.a.branch}`) !== j.a.tip || cur.get(`refs/heads/${j.b.branch}`) !== j.b.tip;
  }

  private async run(j: Job) {
    // A head that moved while the pair waited: its answer would be of a head no longer there.
    if (await this.moved(j)) { this.stats.dropped++; return; }
    this.stats.ran++;
    const k = pairKey(j.repo, j.a.tip, j.b.tip);
    const [s1, s2] = k.tip1 === j.a.tip ? [j.a, j.b] : [j.b, j.a];
    this.store.db.query("INSERT OR REPLACE INTO pair_checks (repo, tip1, tip2, branch1, branch2, base, base_tip, rules, why, detail, state, started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(j.repo, k.tip1, k.tip2, s1.branch, s2.branch, j.base, j.baseTip, j.rules, j.rel.why, j.rel.detail, Date.now());
    const watchers = this.viewers(j.repo, [j.a.branch, j.b.branch]);
    this.d.changed(watchers);
    const set = (f: Partial<PairRow>) => {
      const keys = Object.keys(f);
      this.store.db.query(`UPDATE pair_checks SET ${keys.map((x) => `${x} = ?`).join(", ")} WHERE repo = ? AND tip1 = ? AND tip2 = ?`).run(...(Object.values(f) as any[]), j.repo, k.tip1, k.tip2);
    };
    // A head that moved between the runs: the row goes, and the new heads are a pair of their own.
    const gone = async () => {
      if (!(await this.moved(j))) return false;
      this.store.db.query("DELETE FROM pair_checks WHERE repo = ? AND tip1 = ? AND tip2 = ?").run(j.repo, k.tip1, k.tip2);
      this.stats.dropped++;
      return true;
    };
    const cfg = config();
    const runner = await this.runnerFor(j, cfg);
    const all: { on: string; ran: Ran[] }[] = [];
    try {
      const built = await runner.build();
      if ("error" in built) {
        // A setup that fails fails every pair of the repository: broken, told once.
        if (built.setup) { set({ state: "broken", error: built.error, ended: Date.now(), place: runner.place }); this.tellBroken(j, k, brokenText({ repo: j.repo, base: j.base, baseTip: j.baseTip, checks: [], setup: j.setup, why: built.error })); }
        else set({ state: "error", error: built.error, ended: Date.now(), place: runner.place });
        return;
      }
      const steps: Step[] = j.checks.flatMap((c) => { const cmd = commandOf(c, pairTests(j.rel, built.tree), homeDir()); return cmd ? [{ check: c, command: cmd }] : []; });
      if (!steps.length) { set({ state: "error", error: "none of the fast checks has anything to run for this pair", ended: Date.now(), place: runner.place }); return; }
      const together = await runner.run(built.together, steps);
      all.push({ on: "together", ran: together });
      // A run that says its test files were not found was built wrong: a failure of the setup, never a red
      // check (and not a broken base: the sides alone would say the same, and stop the repository's pairs).
      const unseen = together.filter((r) => r.exit !== 0).map((r) => ({ r, text: r.text ?? (r.log ? readTail(r.log) : "") })).find((x) => noTestFiles(x.text));
      if (unseen) {
        set({ state: "error", error: `${MISSING}${setupLineOf(unseen.text, unseen.r.exit) ?? "the test files were not found"}`.slice(0, 400), ended: Date.now(), place: runner.place });
        return;
      }
      let v = verdictOf(together);
      if (v.state !== "green") {
        if (await gone()) return;
        const red = steps.filter((s) => together.some((r) => r.check === s.check.name && r.exit !== 0));
        const a = await runner.run(built.a, red);
        const b = await runner.run(built.b, red);
        all.push({ on: j.a.branch, ran: a }, { on: j.b.branch, ran: b });
        v = verdictOf(together, { a, b });
        if (v.state === "red") {
          if (await gone()) return;
          const broke = v.checks;
          const again = await runner.run(built.together, steps.filter((s) => broke.some((c) => c.name === s.check.name)));
          all.push({ on: "together again", ran: again });
          v = verdictOf(together, { a, b }, again);
        }
      }
      // A side red alone is named by its branch.
      const said = v.state === "own" ? v.checks.map((c) => ({ name: c.name, branch: c.branch === "a" ? j.a.branch : c.branch === "b" ? j.b.branch : "both" })) : "checks" in v ? v.checks : [];
      set({ state: v.state, checks: JSON.stringify(said), runs: JSON.stringify(all.map((x) => ({ on: x.on, ran: x.ran.map((r) => ({ check: r.check, exit: r.exit, ms: r.ms, names: r.names.slice(0, 20), ...(r.answered ? { answered: true } : {}), ...(r.log ? { log: r.log } : {}) })) }))), place: runner.place, ended: Date.now() });
      if (v.state === "broken") {
        // Red alone on both sides because the checks could not start (a package, a type file, a program is not there):
        // the setup's, said with its first line; else the base or the setup is red.
        const missing = all.filter((x) => x.on !== "together").flatMap((x) => x.ran).filter((r) => r.exit !== 0).map((r) => setupLineOf(r.text ?? (r.log ? readTail(r.log) : ""), r.exit)).find(Boolean);
        if (missing) set({ error: `${MISSING}${missing}`.slice(0, 400) });
        this.tellBroken(j, k, brokenText({ repo: j.repo, base: j.base, baseTip: j.baseTip, checks: v.checks.map((c) => c.name), setup: j.setup, ...(missing ? { missing } : {}) }));
      }
      if (v.state === "red") {
        this.stats.red++;
        // (Told only of heads that are still the branches': an answer of a head that moved on is the board's, not news.)
        if (!(await this.moved(j))) this.tellRed(j, k, s1, s2, v.checks);
      }
    } catch (e) {
      if ((e as { setup?: true }).setup) {
        set({ state: "broken", error: (e as Error).message.slice(0, 400), ended: Date.now(), place: runner.place });
        this.tellBroken(j, k, brokenText({ repo: j.repo, base: j.base, baseTip: j.baseTip, checks: [], setup: cfg.host_setup ?? j.setup, why: (e as Error).message }));
        return;
      }
      set({ state: "error", error: (e as Error).message.slice(0, 400), ended: Date.now(), place: runner.place });
      throw e;
    } finally {
      await runner.done().catch((e) => this.d.error(e, "pair check cleanup"));
      this.d.changed(watchers);
    }
  }

  // A broken repository is told to the owner (the Errors panel) once: not again while its last told
  // answer before this one was broken too, until a pair of it gets an answer of its own.
  private tellBroken(j: Job, k: { tip1: string; tip2: string }, text: string) {
    const prior = this.store.db.query<{ state: string; told: number }, [string, string, string]>("SELECT state, told FROM pair_checks WHERE repo = ? AND state NOT IN ('running', 'error') AND NOT (tip1 = ? AND tip2 = ?) ORDER BY COALESCE(ended, started) DESC LIMIT 1").get(j.repo, k.tip1, k.tip2);
    this.store.db.query("UPDATE pair_checks SET told = 1 WHERE repo = ? AND tip1 = ? AND tip2 = ?").run(j.repo, k.tip1, k.tip2);
    if (prior?.state === "broken" && prior.told) return;
    this.d.broken(text);
  }

  // A red pair is told once to each side's parent: not when the same two branches were last told red
  // on the same checks and tests (a head that moved and still breaks the same way), and not when a head
  // moved while it ran (its answer is of a head no longer there: the caller checks).
  private tellRed(j: Job, k: { tip1: string; tip2: string }, s1: Side, s2: Side, checks: { name: string; tests: string[] }[]) {
    const owners = this.ov.owners(j.repo);
    const prior = this.store.db.query<{ checks: string | null }, [string, string, string, string, string]>("SELECT checks FROM pair_checks WHERE repo = ? AND branch1 = ? AND branch2 = ? AND told = 1 AND NOT (tip1 = ? AND tip2 = ?) ORDER BY ended DESC LIMIT 1").get(j.repo, s1.branch, s2.branch, k.tip1, k.tip2);
    const same = prior?.checks === JSON.stringify(checks);
    this.store.db.query("UPDATE pair_checks SET told = 1 WHERE repo = ? AND tip1 = ? AND tip2 = ?").run(j.repo, k.tip1, k.tip2);
    if (same) return;
    const text = redText({ a: { branch: s1.branch, tip: s1.tip }, b: { branch: s2.branch, tip: s2.tip }, base: j.base, baseTip: j.baseTip, checks });
    for (const b of [s1.branch, s2.branch]) {
      const s = owners.get(b);
      if (!s) continue;
      const sess = this.store.session(s);
      const to = sess?.parent_id && this.store.session(sess.parent_id) ? sess.parent_id : s;
      const a = this.d.agentOf(s);
      this.d.tell(to, { message: text, ...(a && to !== s ? { ref: { id: a.id, label: a.title } } : {}) });
    }
  }

  private prune() {
    this.store.db.query("DELETE FROM pair_checks WHERE state != 'running' AND COALESCE(ended, started) < ?").run(Date.now() - KEEP_MS);
    this.store.db.query(`DELETE FROM pair_checks WHERE state != 'running' AND rowid NOT IN (SELECT rowid FROM pair_checks ORDER BY started DESC LIMIT ${KEEP_ROWS})`).run();
  }

  // ---- where a pair runs

  private async runnerFor(j: Job, cfg: Config): Promise<Runner> {
    if (cfg.host) {
      const room = await hostRoom(cfg.host, cfg.load_share);
      if (room === true) return new HostRunner(this.store, j, cfg);
    }
    return new LocalRunner(this.store, j, this.d);
  }
}

// ---- runners

// (`setup`: the error is the repository's setup's.)
type Built = { together: string; a: string; b: string; tree: Set<string> } | { error: string; setup?: true };
interface Runner {
  place: string;
  build(): Promise<Built>;
  run(commit: string, steps: Step[]): Promise<Ran[]>;
  done(): Promise<void>;
}

// The three commits a pair is checked on, made in a worktree of Keel's own on the base: the base with
// both sides merged, and with each side alone. Their trees are what each side would land as.
async function merges(dir: string, j: Job): Promise<{ together: string; a: string; b: string } | { error: string }> {
  const sg = (args: string[], env?: Record<string, string>) => git(dir, args, { env: { ...NO_EDIT, ...env }, timeout: 300_000 });
  const ident = (await sg(["var", "GIT_COMMITTER_IDENT"])).code === 0 ? {} : KEEL_IDENT;
  const head = async () => (await sg(["rev-parse", "HEAD"])).out.trim();
  const on = async (tips: { branch: string; tip: string }[]): Promise<string | { error: string }> => {
    await sg(["checkout", "-q", "--detach", "--force", j.baseTip]);
    await sg(["clean", "-q", "-fd", "-e", "node_modules"]);
    for (const t of tips) {
      const r = await sg(["-c", "merge.ff=false", "merge", "--no-ff", "--no-edit", "-q", "-m", `Check ${t.branch} together`, t.tip], ident);
      if (r.code !== 0) { await sg(["merge", "--abort"]); return { error: `${tips.map((x) => x.branch).join(" and ")} do not merge on ${j.base}: ${(r.err || r.out).trim().split("\n").at(-1)?.slice(0, 200)}` }; }
    }
    return head();
  };
  const together = await on([j.a, j.b]);
  if (typeof together !== "string") return together;
  const a = await on([j.a]);
  if (typeof a !== "string") return a;
  const b = await on([j.b]);
  if (typeof b !== "string") return b;
  return { together, a, b };
}

async function treeFiles(dir: string, commit: string): Promise<Set<string>> {
  const r = await git(dir, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", commit], { read: true, timeout: 60_000 });
  return new Set(r.code === 0 ? r.out.split("\0").filter(Boolean) : []);
}

// Here, at a low priority, each command after a slot of the heavy-command pool.
class LocalRunner implements Runner {
  place = "here";
  private dir: string;
  private made = false;
  private logs: string;
  private id = newId();
  private held: string[] = [];
  // The packages linked into the tree from outside it, shown to a confined command read-only.
  private shown: string[] = [];
  // `packages`: the base's installed packages are given to the scratch tree (not where the checks run elsewhere).
  constructor(private store: Store, private j: Job, private d: TogetherDeps, private packages = true) {
    this.dir = join(store.stateDir, "pairs", "wt", hashOf(j.repo), this.id);
    this.logs = join(store.stateDir, "pairs", "logs");
  }
  async build(): Promise<Built> {
    mkdirSync(join(this.dir, ".."), { recursive: true });
    mkdirSync(this.logs, { recursive: true });
    // (A worktree of an earlier daemon's pair, its folder gone at start, is pruned before one is added.)
    await worktreeGit(this.j.repo, ["worktree", "prune"], { ok: true });
    await worktreeGit(this.j.repo, ["worktree", "add", "-q", "--detach", this.dir, this.j.baseTip]);
    this.made = true;
    if (this.j.setup) {
      const s = await this.sh(this.j.setup, this.dir, "setup");
      if (s.exit !== 0) return { error: `the repository's setup (land.setup) failed here: exit ${s.exit ?? "stopped"}`, setup: true };
    } else if (this.packages) {
      const bad = await this.provide();
      if (bad) return { error: bad, setup: true };
    }
    const m = await merges(this.dir, this.j);
    if ("error" in m) return m;
    return { ...m, tree: await treeFiles(this.dir, m.together) };
  }
  // A repository that names no land.setup gets the base's installed packages as a fails-before run does
  // (src/checks/before-run.ts packagesFor): linked from its main checkout when that holds them from the same
  // lockfile, else from the cache of installs, else installed here once. Undefined when they are there or not
  // needed; else why the install failed (the setup's failure, told as such).
  private async provide(): Promise<string | undefined> {
    const top = this.j.repo;
    const common = repoOf(this.dir)?.common ?? top;
    const env = tempEnv(this.d.env(this.j.who));
    // (A link is made only where the session's own sandbox reads what it points at; else the cache's, or an install.)
    const readable = (p: string) => readsIn((argv) => this.d.confine(argv, this.j.who, this.dir, this.shown), p, this.dir);
    for (const dir of new Set(this.j.checks.map((c) => c.dir))) {
      if (dir === "*") continue;
      const got = await packagesFor({ scratch: this.dir, checkDir: dir, sources: [top], path: env.PATH ?? process.env.PATH ?? "", common, again: false, readable, how: "pairs" }, async (cwd, command) => {
        const r = await this.sh(command, cwd, "install", INSTALL_MS);
        return { exit: r.exit, why: r.exit === null ? "it ran past its limit and was stopped" : "" };
      });
      if (got.held) this.held.push(got.held);
      for (const p of got.shown ?? []) if (!this.shown.includes(p)) this.shown.push(p);
      if (got.failed) return `the base's packages could not be installed here: ${got.why}`;
    }
    return undefined;
  }
  async run(commit: string, steps: Step[]): Promise<Ran[]> {
    const sg = (args: string[]) => git(this.dir, args, { env: NO_EDIT, timeout: 300_000 });
    await sg(["checkout", "-q", "--detach", "--force", commit]);
    await sg(["clean", "-q", "-fd", "-e", "node_modules"]);
    const tree = (await git(this.dir, ["rev-parse", `${commit}^{tree}`], { read: true })).out.trim();
    const at = repoOf(this.dir);
    const out: Ran[] = [];
    for (const s of steps) {
      const key = keyOf(s.check.dir, s.command);
      const inputs = inputsOf(this.dir, s.check.inputs) ?? null;
      if (s.check.cache && tree) {
        const runs = onTree(key, tree, inputs);
        if (runs[0]?.result === "pass" && !flakyOn(runs)) { out.push({ check: s.check.name, exit: 0, names: [], ms: 0, answered: true }); continue; }
      }
      const t0 = Date.now();
      const r = await this.sh(s.command, join(this.dir, s.check.dir === "." ? "" : s.check.dir), s.check.name);
      const text = readTail(r.log);
      out.push({ check: s.check.name, exit: r.exit, names: r.exit === 0 ? [] : failedNames(text), ms: Date.now() - t0, log: r.log });
      if (tree) record({ name: s.check.name, command: s.command, dir: s.check.dir, repo: at?.scope ?? this.j.repo, tree, head: commit, session_id: this.j.who, by: "queue", result: r.exit === null ? "stopped" : r.exit === 0 ? "pass" : "fail", exit: r.exit, pass: null, fail: null, started: t0, ended: Date.now(), log: r.log, from_run: null, inputs, top: this.dir, cpu_ms: r.cpu_ms });
    }
    return out;
  }
  async done() {
    for (const k of this.held) release(k);
    if (this.made) await worktreeGit(this.j.repo, ["worktree", "remove", "--force", this.dir], { ok: true });
    rmSync(this.dir, { recursive: true, force: true });
  }
  // A command in a process group of its own, niced (and its disk use too where ionice is), after a slot of the heavy pool.
  private async sh(command: string, cwd: string, name: string, limitMs = this.j.timeoutMs): Promise<{ exit: number | null; log: string; cpu_ms?: number | null }> {
    const log = join(this.logs, `${this.id}-${name.replace(/[^\w.-]/g, "_")}-${Date.now().toString(36)}.log`);
    const slot = await pool.take({ session: this.j.who ?? "pairs", who: "agent", command });
    const fd = openSync(log, "w");
    let pid = 0;
    try {
      writeSync(fd, `$ ${command}\n`);
      const low = ["nice", "-n", "10", ...(Bun.which("ionice") ? ["ionice", "-c2", "-n7"] : [])];
      const argv = this.d.confine([...low, "bash", "-c", command], this.j.who, cwd, this.shown);
      // What the landing queue gives its commands (queue.ts sh): the repository, for a setup that links from it.
      const p = Bun.spawn(argv, { cwd, env: { ...tempEnv(this.d.env(this.j.who)), KEEL_LAND_REPO: this.j.repo, KEEL_PAIR: "1", CI: "1" }, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
      pid = p.pid;
      groups.add(pid);
      let late = false;
      const timer = setTimeout(() => { late = true; killGroup(pid); }, limitMs);
      const code = await p.exited;
      clearTimeout(timer);
      killGroup(pid);
      return { exit: late || p.signalCode ? null : code, log, cpu_ms: cpuMsOf(p) };
    } catch (e) {
      writeSync(fd, `\n${(e as Error).message}\n`);
      return { exit: 127, log };
    } finally {
      if (pid) groups.delete(pid);
      closeSync(fd);
      if (slot && slot !== "aborted") slot.release();
    }
  }
}

// (Each ssh is given the environment as it is now: `ssh` is found on the PATH of the call.)
// Whether a host has room for a pair: its one-minute load under `share` of its processors. False when
// ssh cannot reach it in time.
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
async function hostRoom(host: string, share: number): Promise<boolean> {
  try {
    const p = Bun.spawn(["ssh", ...SSH, host, "cat /proc/loadavg; nproc"], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    const { out, code } = await outputOf(p, { where: "pair host room" });
    if (code !== 0) return false;
    const [load, , , , , cores] = out.split(/\s+/).map(Number);
    return Number.isFinite(load) && Number.isFinite(cores) && cores! > 0 && load! < share * cores!;
  } catch { return false; }
}

// On the owner's host: the pair's commits are made here, pushed to a bare repository of Keel's own
// there, and each run is one ssh call that checks the commit out in a worktree of its own there, runs
// the setup (together.host_setup, else land.setup) and the commands at a low priority, and prints
// each command's exit and the end of its output. Nothing of this machine but the commits goes there.
class HostRunner implements Runner {
  place: string;
  private local: LocalRunner;
  private bare: string;
  constructor(store: Store, private j: Job, private cfg: Config) {
    this.place = cfg.host!;
    this.bare = `${cfg.host_dir}/${hashOf(j.repo)}.git`;
    // The merges are made here, with no setup (nothing runs here).
    this.local = new LocalRunner(store, { ...j, setup: undefined }, { error: () => {}, changed: () => {}, tell: () => {}, broken: () => {}, agentOf: () => undefined, confine: (a) => a, env: () => ({}) }, false);
  }
  private pushed: string[] = [];
  async build(): Promise<Built> {
    const b = await this.local.build();
    if ("error" in b) return b;
    const mk = Bun.spawn(["ssh", ...SSH, this.cfg.host!, `mkdir -p ~/${this.cfg.host_dir} && { [ -d ~/${this.bare} ] || git init -q --bare ~/${this.bare}; }`], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 60_000 });
    if ((await mk.exited) !== 0) return { error: `could not make the repository on ${this.cfg.host}: ${(await readText(mk.stderr, "pair host repository")).trim().slice(0, 200)}` };
    const refs = [b.together, b.a, b.b].map((s) => `+${s}:refs/keel-pairs/${s}`);
    const r = await git(this.j.repo, ["push", "-q", `${this.cfg.host}:${this.bare}`, ...refs], { env: { GIT_SSH_COMMAND: `ssh ${SSH.join(" ")}` }, timeout: 600_000, fetch: "any" });
    if (r.code !== 0) return { error: `the push to ${this.cfg.host} failed: ${r.err.trim().split("\n").at(-1)?.slice(0, 200)}` };
    this.pushed = [b.together, b.a, b.b];
    return b;
  }
  async run(commit: string, steps: Step[]): Promise<Ran[]> {
    const id = newId();
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const setup = this.cfg.host_setup ?? this.j.setup;
    const secs = Math.ceil(this.j.timeoutMs / 1000);
    const lines = [
      "set -u",
      `b=~/${this.bare}; w=~/${this.cfg.host_dir}/wt/${id}`,
      `mkdir -p ~/${this.cfg.host_dir}/wt`,
      // (A worktree a cut run left is pruned first; the setup gets the repository as the queue's does, here the bare one.)
      `git -C "$b" worktree prune > /dev/null 2>&1; export KEEL_LAND_REPO="$b"`,
      `git -C "$b" worktree add -q --detach "$w" ${commit} > /dev/null 2>&1 || { echo "@@keel-pair setup 127"; exit 0; }`,
      `trap 'cd ~; git -C "$b" worktree remove --force "$w" > /dev/null 2>&1; rm -rf "$w"' EXIT`,
      `cd "$w"`,
      ...(setup ? [`bash -c "$(echo ${b64(setup)} | base64 -d)" > "$w.setup.log" 2>&1 || { e=$?; echo "@@keel-pair setup $e"; tail -n 40 "$w.setup.log"; rm -f "$w.setup.log"; exit 0; }`, `rm -f "$w.setup.log"`] : []),
      ...steps.flatMap((s, i) => [
        `( cd "$w/${s.check.dir === "." ? "" : s.check.dir}" && CI=1 KEEL_PAIR=1 timeout ${secs} nice -n 10 bash -c "$(echo ${b64(s.command)} | base64 -d)" ) > "$w.log" 2>&1; e=$?`,
        `echo "@@keel-pair ${i} $e"; tail -n 200 "$w.log"; echo "@@keel-pair-end ${i}"; rm -f "$w.log"`,
      ]),
    ];
    const out: Ran[] = steps.map((s) => ({ check: s.check.name, exit: null, names: [], ms: 0 }));
    const t0 = Date.now();
    const p = Bun.spawn(["ssh", ...SSH, this.cfg.host!, "bash -s"], { env: process.env, stdin: new TextEncoder().encode(lines.join("\n") + "\n"), stdout: "pipe", stderr: "ignore", timeout: this.j.timeoutMs * (steps.length + 1) + 120_000 });
    const { out: text } = await outputOf(p, { where: "pair host run" });
    const setupFail = /^@@keel-pair setup (\d+)$/m.exec(text);
    if (setupFail) throw Object.assign(new Error(`the setup on ${this.cfg.host} (together.host_setup, else land.setup) failed: exit ${setupFail[1]}`), { setup: true });
    for (const m of text.matchAll(/^@@keel-pair (\d+) (\d+)\n([\s\S]*?)^@@keel-pair-end \1$/gm)) {
      const i = Number(m[1]), exit = Number(m[2]);
      if (out[i]) { out[i]!.exit = exit === 124 || exit === 137 ? null : exit; out[i]!.names = exit === 0 ? [] : failedNames(m[3]!); out[i]!.text = m[3]; }
    }
    for (const r of out) r.ms = Date.now() - t0;
    return out;
  }
  // The pair's refs go from the host's repository when it ends (their commits with the next gc there).
  async done() {
    if (this.pushed.length) {
      const del = this.pushed.map((c) => `delete refs/keel-pairs/${c}`).join("\n") + "\n";
      const p = Bun.spawn(["ssh", ...SSH, this.cfg.host!, `git -C ~/${this.bare} update-ref --stdin && git -C ~/${this.bare} gc --auto --quiet`], { env: process.env, stdin: new TextEncoder().encode(del), stdout: "ignore", stderr: "ignore", timeout: 60_000 });
      await p.exited;
    }
    return this.local.done();
  }
}
