// The overlap forecast between live branches of one repository: worktrees
// Keel made, and branches its sessions committed to. Every two of them, and
// each with the base, are merged in memory by `git merge-tree --write-tree`
// (git-merge-tree(1)); a pair is checked again only when the tip of one of
// its sides moved, so a commit costs the checks of its own branch (one less
// than the live branches, and the base). No timer runs it: a session's tool
// call that moved a tip schedules it (src/server/routes/overlaps.ts), and so
// does the daemon's start and the owner's refresh.
//
// Nothing of the repository is written. The merges' objects go to a folder of
// Keel's own made for the pass and removed after it (the repository's objects
// are read through an alternate), the reads take no optional lock, and no ref
// or index of the repository changes.
//
// A new conflict is owed to the sessions on both sides, and to the parent of
// each that is an agent, as one harness note each; it is told while the
// session works (a steer at its next step) or at its next turn's start, never
// by starting a turn. A pair that merges clean says nothing; a conflict that
// went (a rebase) is told as gone, once, to whoever was told of it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, locate, type Where } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { clashes, clearedNote, conflictNote, decide, pairsOf, parseHunks, parseMergeTree, splitDiff, type ConflictFile, type Result, type Side } from "./overlap.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS overlap_branches (repo TEXT NOT NULL, branch TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seen INTEGER NOT NULL, PRIMARY KEY (repo, branch));
CREATE TABLE IF NOT EXISTS overlap_pairs (repo TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, base INTEGER NOT NULL, a_tip TEXT NOT NULL, b_tip TEXT NOT NULL, conflict INTEGER NOT NULL, error TEXT, files TEXT NOT NULL, checked INTEGER NOT NULL, PRIMARY KEY (repo, a, b));
CREATE TABLE IF NOT EXISTS overlap_told (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, repo TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, told TEXT, owed TEXT, PRIMARY KEY (session_id, repo, a, b));
CREATE INDEX IF NOT EXISTS overlap_told_owed ON overlap_told(session_id) WHERE owed IS NOT NULL;
`;

type PairRow = { repo: string; a: string; b: string; base: number; a_tip: string; b_tip: string; conflict: number; error: string | null; files: string; checked: number };
type ToldRow = { session_id: string; repo: string; a: string; b: string; told: string | null; owed: "conflict" | "cleared" | null };
export type Pair = { a: string; b: string; base: boolean; a_tip: string; b_tip: string; conflict: boolean; error?: string; files: ConflictFile[]; checked: number; a_session?: string; b_session?: string };
// `checked`: it has commits of its own and its pairs were checked (a branch with none has nothing to land).
export type Branch = { branch: string; tip: string; session_id: string; title: string; managed: boolean; checked: boolean };
export type View = { repo: string | null; base: string | null; base_tip: string | null; mine: string | null; branches: Branch[]; pairs: Pair[]; clean: number; checked: number | null; last?: Pass };
// What the last pass of a repository cost: the merges it ran and their time.
export type Pass = { at: number; ms: number; merges: number; reused: number; diffs: number };

// The files of one conflict whose meeting lines are worked out (two diffs a
// file); past these the files are named only.
const PLACED = 40;
// A tool call that moved a tip is followed by its scan after this, so the
// calls of one step (a commit, then a push) make one pass.
const SETTLE_MS = 750;

export type Teller = { running: (id: string) => boolean; steer: (id: string, text: string, meta: Record<string, unknown>) => boolean; changed: (sessionIds: string[]) => void; failed: (e: unknown, at: string) => void };

export const rootOf = (w: Where) => (w.common.endsWith("/.git") ? dirname(w.common) : w.top ?? dirname(w.common));

// A ref's commit read from the files, without running git: its loose file,
// else its line in packed-refs. Undefined when neither has it (a reftable
// repository, a ref that does not exist).
const packed = new Map<string, { mtime: number; size: number; refs: Map<string, string> }>();
export function refTip(common: string, ref: string): string | undefined {
  try { return readFileSync(join(common, ref), "utf8").trim() || undefined; } catch {}
  const file = join(common, "packed-refs");
  let st;
  try { st = statSync(file); } catch { return undefined; }
  let p = packed.get(file);
  if (!p || p.mtime !== st.mtimeMs || p.size !== st.size) {
    const refs = new Map<string, string>();
    try { for (const line of readFileSync(file, "utf8").split("\n")) { const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line); if (m) refs.set(m[2]!, m[1]!); } } catch {}
    p = { mtime: st.mtimeMs, size: st.size, refs };
    packed.set(file, p);
  }
  return p.refs.get(ref);
}
// The branch a checkout is on, read from its HEAD file (none when detached).
export function headBranch(w: Where): string | undefined {
  try { return /^ref: refs\/heads\/(.+)$/.exec(readFileSync(join(w.gitDir, "HEAD"), "utf8").trim())?.[1]; } catch { return undefined; }
}

export class Overlaps {
  private bases = new Map<string, string | null>(); // repo → the base's full ref name
  private aheadOf = new Map<string, number>(); // `${tip} ${baseTip}` → commits over the base
  private passes = new Map<string, Pass>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanning = new Map<string, Promise<void>>();
  private again = new Set<string>();

  constructor(private store: Store, private teller: Teller) {
    store.migrate(SCHEMA);
    // A pass a stop cut left its folder: no pass runs yet, so none is in use.
    rmSync(join(store.stateDir, "overlap-objects"), { recursive: true, force: true });
  }

  // ---- who holds which branch ----

  // The live branches of a repository and the session that holds each: an
  // active worktree Keel made, else a branch a session committed to.
  owners(repo: string): Map<string, string> {
    const out = new Map<string, string>();
    const live = (id: string) => { const s = this.store.session(id); return !!s && !s.archived; };
    let managed: { branch: string; session_id: string }[] = [];
    try { managed = this.store.db.query<{ branch: string; session_id: string }, [string]>("SELECT branch, session_id FROM worktrees WHERE repo_root = ? AND state = 'active' ORDER BY created").all(repo); } catch {} // no worktree was ever made
    for (const r of managed) if (live(r.session_id)) out.set(r.branch, r.session_id);
    for (const r of this.store.db.query<{ branch: string; session_id: string }, [string]>("SELECT branch, session_id FROM overlap_branches WHERE repo = ?").all(repo)) {
      if (!out.has(r.branch) && live(r.session_id)) out.set(r.branch, r.session_id);
    }
    return out;
  }
  private managedBranches(repo: string): Set<string> {
    try { return new Set(this.store.db.query<{ branch: string }, [string]>("SELECT branch FROM worktrees WHERE repo_root = ? AND state = 'active'").all(repo).map((r) => r.branch)); } catch { return new Set(); }
  }
  // The repositories with a branch Keel's sessions hold.
  repos(): string[] {
    const set = new Set(this.store.db.query<{ repo: string }, []>("SELECT DISTINCT repo FROM overlap_branches").all().map((r) => r.repo));
    try { for (const r of this.store.db.query<{ repo_root: string }, []>("SELECT DISTINCT repo_root FROM worktrees WHERE state = 'active'").all()) set.add(r.repo_root); } catch {}
    return [...set];
  }

  // A session committed to `branch` (its tip moved under one of its calls).
  committed(repo: string, branch: string, sessionId: string) {
    this.store.db.query("INSERT INTO overlap_branches (repo, branch, session_id, seen) VALUES (?, ?, ?, ?) ON CONFLICT(repo, branch) DO UPDATE SET session_id = excluded.session_id, seen = excluded.seen").run(repo, branch, sessionId, Date.now());
  }

  // The base the repository's branches land on: what origin/HEAD names, else
  // a local main or master. Nothing is fetched. Kept until a pass finds it gone.
  async baseOf(repo: string): Promise<string | null> {
    if (this.bases.has(repo)) return this.bases.get(repo)!;
    const origin = (await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { read: true })).out.trim();
    let base: string | null = origin || null;
    if (!base) for (const b of ["main", "master"]) if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { read: true })).code === 0) { base = `refs/heads/${b}`; break; }
    this.bases.set(repo, base);
    return base;
  }
  baseKnown = (repo: string) => this.bases.get(repo);

  // ---- the pass ----

  // A pass of `repo` after SETTLE_MS; calls meanwhile make it one.
  schedule(repo: string, ms = SETTLE_MS) {
    if (this.timers.has(repo)) return;
    const t = setTimeout(() => { this.timers.delete(repo); this.scan(repo).catch((e) => this.teller.failed(e, "overlap scan")); }, ms);
    t.unref?.();
    this.timers.set(repo, t);
  }

  // One pass at a time a repository; a pass asked for while one runs follows it.
  scan(repo: string): Promise<void> {
    const cur = this.scanning.get(repo);
    if (cur) { this.again.add(repo); return cur; }
    const run = this.pass(repo).finally(() => {
      this.scanning.delete(repo);
      if (this.again.delete(repo)) this.scan(repo).catch((e) => this.teller.failed(e, "overlap scan"));
    });
    this.scanning.set(repo, run);
    return run;
  }

  private async pass(repo: string) {
    const t0 = performance.now();
    const stat: Pass = { at: Date.now(), ms: 0, merges: 0, reused: 0, diffs: 0 };
    const w = locate(repo);
    const owners = this.owners(repo);
    if (!w || !owners.size) return this.settle(repo, new Set(), owners, stat, t0);
    this.bases.delete(repo); // read again each pass: origin/HEAD may have been set or changed
    const base = await this.baseOf(repo);
    const names = [...owners.keys()];
    const listed = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...names.map((b) => `refs/heads/${b}`), ...(base ? [base] : [])], { read: true });
    if (listed.code !== 0) throw new Error(`git for-each-ref: ${listed.err.trim()}`);
    const tips = new Map<string, string>();
    for (const line of listed.out.split("\n")) { const [ref, sha] = line.split("\0"); if (ref && sha) tips.set(ref, sha); }
    const baseTip = base ? tips.get(base) : undefined;
    // A branch that is gone, and one a session committed to that landed, is no longer held.
    const managed = this.managedBranches(repo);
    const live: string[] = [];
    for (const b of names) {
      const tip = tips.get(`refs/heads/${b}`);
      if (!tip) { if (!managed.has(b)) this.store.db.query("DELETE FROM overlap_branches WHERE repo = ? AND branch = ?").run(repo, b); continue; }
      if (baseTip && (await this.ahead(repo, tip, baseTip)) === 0) continue; // nothing of its own to land
      live.push(b);
    }
    const shortBase = base?.replace(/^refs\/(heads|remotes)\//, "") ?? null;
    const want: { a: string; b: string; base: boolean; ta: string; tb: string }[] = pairsOf(live).map(([a, b]) => ({ a, b, base: false, ta: tips.get(`refs/heads/${a}`)!, tb: tips.get(`refs/heads/${b}`)! }));
    if (shortBase && baseTip) for (const a of live) want.push({ a, b: shortBase, base: true, ta: tips.get(`refs/heads/${a}`)!, tb: baseTip });
    const keep = new Set(want.map((p) => `${p.a}\0${p.b}`));
    const old = new Map(this.store.db.query<PairRow, [string]>("SELECT * FROM overlap_pairs WHERE repo = ?").all(repo).map((r) => [`${r.a}\0${r.b}`, r]));
    let objects: string | undefined;
    const changed = new Set<string>();
    try {
      for (const p of want) {
        const row = old.get(`${p.a}\0${p.b}`);
        if (row && row.a_tip === p.ta && row.b_tip === p.tb && !row.error) { stat.reused++; continue; }
        if (!objects) {
          const dir = join(this.store.stateDir, "overlap-objects");
          mkdirSync(dir, { recursive: true });
          objects = mkdtempSync(join(dir, "pass-"));
          mkdirSync(join(objects, "info"), { recursive: true });
        }
        const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(w.common, "objects") };
        const mt = await git(repo, ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", p.ta, p.tb], { read: true, env });
        stat.merges++;
        const r = parseMergeTree(mt.out, mt.code, mt.err);
        const files = "conflict" in r && r.conflict ? await this.place(repo, p.ta, p.tb, r.files, stat) : [];
        const was = row ? { conflict: !!row.conflict, files: row.files, error: row.error } : undefined;
        const now = { conflict: "conflict" in r && r.conflict, files: JSON.stringify(files), error: "error" in r ? r.error : null };
        this.store.db.query(`INSERT INTO overlap_pairs (repo, a, b, base, a_tip, b_tip, conflict, error, files, checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo, a, b) DO UPDATE SET base = excluded.base, a_tip = excluded.a_tip, b_tip = excluded.b_tip, conflict = excluded.conflict, error = excluded.error, files = excluded.files, checked = excluded.checked`)
          .run(repo, p.a, p.b, p.base ? 1 : 0, p.ta, p.tb, now.conflict ? 1 : 0, now.error, now.files, Date.now());
        if (!was || was.conflict !== now.conflict || was.files !== now.files || was.error !== now.error) changed.add(`${p.a}\0${p.b}`);
        this.owe(repo, p.a, p.b, p.base, r, owners);
      }
    } finally {
      if (objects) rmSync(objects, { recursive: true, force: true });
    }
    for (const k of old.keys()) if (!keep.has(k)) changed.add(k);
    return this.settle(repo, keep, owners, stat, t0, changed.size > 0);
  }

  // Pairs no longer checked go with what was owed of them (a branch that
  // landed or went is not told as resolved); the sessions of the repository's
  // branches hear of a change; what is owed to a working session goes now.
  private settle(repo: string, keep: Set<string>, owners: Map<string, string>, stat: Pass, t0: number, changed = false) {
    for (const r of this.store.db.query<{ a: string; b: string }, [string]>("SELECT a, b FROM overlap_pairs WHERE repo = ?").all(repo)) {
      if (keep.has(`${r.a}\0${r.b}`)) continue;
      this.store.db.query("DELETE FROM overlap_pairs WHERE repo = ? AND a = ? AND b = ?").run(repo, r.a, r.b);
      this.store.db.query("DELETE FROM overlap_told WHERE repo = ? AND a = ? AND b = ?").run(repo, r.a, r.b);
      changed = true;
    }
    stat.ms = Math.round(performance.now() - t0);
    this.passes.set(repo, stat);
    if (changed) this.teller.changed([...new Set(owners.values())]);
    const due = this.store.db.query<{ session_id: string }, [string]>("SELECT DISTINCT session_id FROM overlap_told WHERE repo = ? AND owed IS NOT NULL").all(repo);
    for (const { session_id } of due) if (this.teller.running(session_id)) this.tell(session_id);
  }

  private async ahead(repo: string, tip: string, baseTip: string): Promise<number> {
    const key = `${tip} ${baseTip}`;
    const known = this.aheadOf.get(key);
    if (known !== undefined) return known;
    const r = await git(repo, ["rev-list", "--count", `${baseTip}..${tip}`], { read: true });
    const n = r.code === 0 ? Number(r.out.trim()) || 0 : 1;
    if (this.aheadOf.size > 4096) this.aheadOf.clear();
    this.aheadOf.set(key, n);
    return n;
  }

  // Where the two sides' changes of each conflicted file meet: each side's
  // `git diff -U0` from their merge base, compared (overlap.ts clashes).
  private async place(repo: string, ta: string, tb: string, files: string[], stat: Pass): Promise<ConflictFile[]> {
    const mb = (await git(repo, ["merge-base", ta, tb], { read: true })).out.trim().split("\n")[0];
    const placed = mb ? files.slice(0, PLACED) : [];
    // One diff a side for all the files; a file whose part is not found there is diffed alone.
    const raw = async (tip: string, paths: string[]) => {
      stat.diffs++;
      const r = await git(repo, ["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-renames", mb!, tip, "--", ...paths.map((p) => `:(literal)${p}`)], { read: true });
      return r.code === 0 ? r.out : undefined;
    };
    const diff = async (tip: string) => splitDiff((await raw(tip, placed)) ?? "");
    const [da, db] = placed.length ? await Promise.all([diff(ta), diff(tb)]) : [new Map<string, string>(), new Map<string, string>()];
    const out: ConflictFile[] = [];
    for (const path of files) {
      if (!placed.includes(path)) { out.push({ path, clashes: [] }); continue; }
      let a = da.get(path), b = db.get(path);
      if (a === undefined && b === undefined && /["\\\t\n]/.test(path)) [a, b] = await Promise.all([raw(ta, [path]), raw(tb, [path])]);
      out.push({ path, clashes: a && b ? clashes(parseHunks(a), parseHunks(b)) : [] });
    }
    return out;
  }

  // ---- what each session is owed ----

  // The sessions told of a pair: the holder of each side and, for one that is
  // an agent, its parent.
  private recipients(owners: Map<string, string>, a: string, b: string, base: boolean): string[] {
    const out: string[] = [];
    for (const br of base ? [a] : [a, b]) {
      const id = owners.get(br);
      if (!id) continue;
      out.push(id);
      const parent = this.store.session(id)?.parent_id;
      if (parent && this.store.session(parent) && !this.store.session(parent)!.archived) out.push(parent);
    }
    return [...new Set(out)];
  }

  private owe(repo: string, a: string, b: string, base: boolean, r: Result, owners: Map<string, string>) {
    for (const sid of this.recipients(owners, a, b, base)) {
      const row = this.store.db.query<ToldRow, [string, string, string, string]>("SELECT * FROM overlap_told WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").get(sid, repo, a, b);
      const told = row?.told ? (JSON.parse(row.told) as string[]) : undefined;
      const d = decide(told, r);
      if (d.notice === "conflict") {
        this.store.db.query("INSERT INTO overlap_told (session_id, repo, a, b, told, owed) VALUES (?, ?, ?, ?, NULL, 'conflict') ON CONFLICT(session_id, repo, a, b) DO UPDATE SET owed = 'conflict'").run(sid, repo, a, b);
      } else if (d.notice === "cleared") {
        this.store.db.query("UPDATE overlap_told SET owed = 'cleared' WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(sid, repo, a, b);
      } else if (row && !("error" in r)) {
        // Owed and no longer so: a conflict never told that went, or a gone one that came back as it was.
        if (!r.conflict && !told) this.store.db.query("DELETE FROM overlap_told WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(sid, repo, a, b);
        else if (r.conflict && row.owed === "cleared") this.store.db.query("UPDATE overlap_told SET owed = NULL WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(sid, repo, a, b);
      }
    }
  }

  // How a recipient stands to a side.
  private who(recipient: string, owner: string | undefined): string {
    if (!owner) return "a branch no session holds now";
    if (owner === recipient) return "your branch";
    const s = this.store.session(owner);
    const name = s?.title ? `"${s.title.replace(/["\n]/g, " ").slice(0, 80)}" ` : "";
    return s?.parent_id === recipient ? `the branch of your agent ${name}(${owner})` : `the branch of session ${name}(${owner})`;
  }

  // What is owed to a session, as one note steered into its turn. Returns
  // whether anything was told. Each pair is read as it is now: a conflict
  // that went before it was told is not told at all.
  tell(sessionId: string): boolean {
    const rows = this.store.db.query<ToldRow, [string]>("SELECT * FROM overlap_told WHERE session_id = ? AND owed IS NOT NULL").all(sessionId);
    if (!rows.length) return false;
    const parts: string[] = [], settled: (() => void)[] = [], pairs: string[] = [];
    for (const row of rows) {
      const p = this.store.db.query<PairRow, [string, string, string]>("SELECT * FROM overlap_pairs WHERE repo = ? AND a = ? AND b = ?").get(row.repo, row.a, row.b);
      const where = [sessionId, row.repo, row.a, row.b] as const;
      if (!p) { settled.push(() => this.store.db.query("DELETE FROM overlap_told WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(...where)); continue; }
      const owners = this.owners(row.repo);
      // The recipient's own side comes first; a parent reads the pair as it is ordered.
      const flip = !p.base && owners.get(p.b) === sessionId && owners.get(p.a) !== sessionId;
      const [mb, ob, mt, ot] = flip ? [p.b, p.a, p.b_tip, p.a_tip] : [p.a, p.b, p.a_tip, p.b_tip];
      const mine: Side = { branch: mb, tip: mt, who: this.who(sessionId, owners.get(mb)) };
      const other: Side = { branch: ob, tip: ot, who: p.base ? "the base" : this.who(sessionId, owners.get(ob)) };
      const files = (JSON.parse(p.files) as ConflictFile[]).map((f) => (flip ? { ...f, clashes: f.clashes.map((c) => ({ a: c.b, b: c.a })) } : f));
      if (row.owed === "conflict" && p.conflict) {
        const told = row.told ? (JSON.parse(row.told) as string[]) : [];
        parts.push(conflictNote(mine, other, files.filter((f) => !told.includes(f.path)), files.length, !!p.base));
        settled.push(() => this.store.db.query("UPDATE overlap_told SET told = ?, owed = NULL WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(JSON.stringify(files.map((f) => f.path)), ...where));
      } else if (row.owed === "cleared" && !p.conflict && !p.error) {
        parts.push(clearedNote(mine, other, !!p.base));
        settled.push(() => this.store.db.query("DELETE FROM overlap_told WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(...where));
      } else {
        settled.push(() => this.store.db.query("UPDATE overlap_told SET owed = NULL WHERE session_id = ? AND repo = ? AND a = ? AND b = ?").run(...where));
      }
      pairs.push(`${p.a} ${p.b}`);
    }
    // The note and what it settles are one write.
    return this.store.atomic(sessionId, () => {
      const sent = parts.length ? this.teller.steer(sessionId, parts.join("\n\n"), { kind: "harness", about: "overlap", pairs }) : true;
      if (sent) for (const f of settled) f();
      return sent && parts.length > 0;
    });
  }

  // ---- what the page reads ----

  view(sessionId: string): View {
    const at = this.whereOf(sessionId);
    if (!at) return { repo: null, base: null, base_tip: null, mine: null, branches: [], pairs: [], clean: 0, checked: null };
    const { repo, branch } = at;
    const owners = this.owners(repo);
    const base = this.bases.get(repo) ?? null;
    const rows = this.store.db.query<PairRow, [string]>("SELECT * FROM overlap_pairs WHERE repo = ? ORDER BY a, b").all(repo);
    const tipOf = new Map<string, string>();
    for (const r of rows) { tipOf.set(r.a, r.a_tip); if (!r.base) tipOf.set(r.b, r.b_tip); }
    const managed = this.managedBranches(repo);
    const branches: Branch[] = [...owners].map(([b, id]) => ({ branch: b, tip: tipOf.get(b) ?? "", session_id: id, title: this.store.session(id)?.title ?? "", managed: managed.has(b), checked: tipOf.has(b) }));
    const pairs: Pair[] = rows.filter((r) => r.conflict || r.error).map((r) => ({
      a: r.a, b: r.b, base: !!r.base, a_tip: r.a_tip, b_tip: r.b_tip, conflict: !!r.conflict, ...(r.error ? { error: r.error } : {}), files: JSON.parse(r.files), checked: r.checked,
      ...(owners.get(r.a) ? { a_session: owners.get(r.a) } : {}), ...(!r.base && owners.get(r.b) ? { b_session: owners.get(r.b) } : {}),
    }));
    const baseTip = rows.find((r) => r.base)?.b_tip ?? null;
    return { repo, base: base?.replace(/^refs\/(heads|remotes)\//, "") ?? rows.find((r) => r.base)?.b ?? null, base_tip: baseTip, mine: branch ?? null, branches, pairs, clean: rows.filter((r) => !r.conflict && !r.error).length, checked: rows.length ? Math.max(...rows.map((r) => r.checked)) : null, ...(this.passes.get(repo) ? { last: this.passes.get(repo) } : {}) };
  }

  // The repository and branch a session works on: its managed worktree's, else its folder's.
  whereOf(sessionId: string): { repo: string; branch?: string } | null {
    let wt: { repo_root: string; branch: string } | null = null;
    try { wt = this.store.db.query<{ repo_root: string; branch: string }, [string]>("SELECT repo_root, branch FROM worktrees WHERE session_id = ? AND state = 'active'").get(sessionId); } catch {}
    if (wt) return { repo: wt.repo_root, branch: wt.branch };
    const s = this.store.session(sessionId);
    if (!s || s.machine) return null;
    const w = locate(s.workspace);
    return w ? { repo: rootOf(w), branch: headBranch(w) } : null;
  }
}

// What a tool call could move, read from the files before and after it: the
// branch the session's checkout is on with its tip, and the base's tip.
export type Mark = { repo: string; branch?: string; tip?: string; base?: string };
const whereCache = new Map<string, { at: number; w: Where | null }>();
export function markOf(s: Session, baseRef: (repo: string) => string | null | undefined): Mark | undefined {
  if (s.machine) return undefined;
  const now = Date.now();
  let c = whereCache.get(s.workspace);
  if (!c || now - c.at > 10_000) {
    c = { at: now, w: locate(s.workspace) };
    whereCache.set(s.workspace, c);
    if (whereCache.size > 1024) whereCache.clear();
  }
  const w = c.w;
  if (!w) return undefined;
  const repo = rootOf(w);
  const branch = headBranch(w);
  const base = baseRef(repo);
  return { repo, branch, tip: branch ? refTip(w.common, `refs/heads/${branch}`) : undefined, base: base ? refTip(w.common, base) : undefined };
}
