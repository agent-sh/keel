// Before and after pictures of a branch that changes the page. For a branch head whose tree names
// pictures (.keel/pictures.json, src/pictures/config.ts) and changes a page file that is not a test, the
// specs that reach the changed files (src/pictures/select.ts) are run twice through the repository's own
// picture command: on a checkout of the merge base with the branch's harness laid over it (its specs and
// helpers, the files `harness` names), and on a checkout of the head. Each side runs in the agent's own
// sandbox, at a low priority, after a slot of the heavy pool that every other command in line goes
// before (who "background"), one run at a time in the daemon. The pictures are paired by name and
// compared on a thread of their own (src/pictures/diff-worker.ts); the files of pairs that are the same
// are not kept. Once per head: a head that has a run is answered by it, unless the owner asks again.
// Never in the session's own folder or the owner's checkout: the scratch checkouts are Keel's own,
// under its state folder, and go when the side ends.
//
// Taken when someone looks: the Review panel, the tree review or a work board card's pictures opening a head
// whose tree names pictures starts its run (startFor gives back the one it has), and so does Take again.
// Nothing of it is told to the agent's parent; the board's line says what it found to whoever asks.
//
// Each side's result is kept in the row as it ends (src/pictures/sides.ts): a run a restart cut goes on at the
// side it was on. The command runs with KEEL_PICTURES_FIXED, the run's own instant: the scripted daemon this
// repository's command starts fixes its ids and clock from it (src/core/fixed-world.ts), and every side has
// the same scratch path, so two runs of one commit draw the same page. What still differs is found by taking
// the base again with the specs whose pictures differ, and a pair that moves only where the base moves too is
// unstable, not changed.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import type { Bus } from "../core/bus.ts";
import { FIXED_ENV } from "../core/fixed-world.ts";
import { git } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { baseOf, repoOf, type Repo } from "../checks/ledger.ts";
import { howToRun, needsOf } from "../checks/before.ts";
import { mainTop, openLayers, packagesFor, runOne, type Packages } from "../checks/before-run.ts";
import * as cache from "../checks/package-cache.ts";
import { config as heavyConfig, pool } from "../tools/heavy.ts";
import { toolEnv } from "../tools/jobs.ts";
import { git as worktreeGit } from "../worktree/manager.ts";
import { FILE, readPictures, sizeWord, type PicturesConfig } from "./config.ts";
import { pairsOf, type Pair, type PairState } from "./pairs.ts";
import { selectSpecs, type Selection } from "./select.ts";
import { againSpecs, finished, readTookBy, resumed, type Side, type SideName, type Sides, type SideState } from "./sides.ts";

export type { Side, SideState } from "./sides.ts";

declare const __KEEL_PICTURES_JS__: string | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pictures (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  common TEXT NOT NULL,
  branch TEXT,
  head TEXT NOT NULL,
  base TEXT,
  merge_base TEXT,
  session_id TEXT,
  agent_id TEXT,
  state TEXT NOT NULL,
  why TEXT,
  selection TEXT,
  sides TEXT NOT NULL,
  pairs TEXT,
  kept INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  started INTEGER,
  ended INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pictures_head ON pictures(common, head);
CREATE INDEX IF NOT EXISTS pictures_branch ON pictures(common, branch, id);
CREATE INDEX IF NOT EXISTS pictures_by_head ON pictures(head);
`;

export type RunState = "queued" | "running" | "done" | "skipped" | "failed";
export type Counts = Record<PairState, number>;
export type PictureRun = {
  id: number; repo: string; common: string; branch: string | null; head: string; base: string | null; merge_base: string | null;
  session_id: string | null; agent_id: string | null;
  state: RunState; why: string | null;
  selection: Selection | null;
  sides: Sides;
  pairs: Pair[];
  counts: Counts;
  kept: boolean;            // its pictures are still on disk
  created: number; started: number | null; ended: number | null;
  sizes?: string[]; themes?: string[];
};
type Row = Omit<PictureRun, "selection" | "sides" | "pairs" | "counts" | "kept"> & { selection: string | null; sides: string; pairs: string | null; kept: number };

type Deps = {
  store: Store; bus: Bus; capture: (e: unknown, ctx: object) => void;
  perm: (sessionId: string) => { mode: string; sandbox: string } | undefined;
  confine: (sessionId: string, workspace: string, tool: string, shown?: string[]) => { wrap: (argv: string[]) => string[]; sandbox: string; network?: boolean; layered?: boolean } | undefined;
  // The sessions whose views read a run (the agent's own, its tree's root).
  viewers?: (run: PictureRun) => string[];
};
let d: Deps | undefined;
const dir = () => join(d!.store.stateDir, "pictures");
export const filesOf = (id: number, side: SideName) => join(dir(), String(id), side);

// What is kept of the pictures of every run together: past it the oldest runs' files go (their rows stay, with
// their counts and areas). A run of three browser specs at two sizes and two themes kept 12 MB (54 pairs that
// differ, both sides; the 22 that were the same dropped): this holds about 170 such runs.
registerSettings("pictures", { keep_mb: 2048 }, (v: any) => (Number.isInteger(v.keep_mb) && v.keep_mb >= 16 ? undefined : "keep_mb is a whole number of megabytes, at least 16"));
const keepBytes = () => ((settings().pictures?.keep_mb as number | undefined) ?? 2048) * 1024 * 1024;

const kept = ((globalThis as any).__keelPictures ??= { chain: Promise.resolve(), going: new Map() }) as { chain: Promise<unknown>; going: Map<number, Promise<PictureRun>> };

const toRun = (r: Row): PictureRun => {
  const pairs = r.pairs ? JSON.parse(r.pairs) as Pair[] : [];
  return { ...r, selection: r.selection ? JSON.parse(r.selection) : null, sides: JSON.parse(r.sides), pairs, counts: countsOf(pairs), kept: !!r.kept };
};
export function countsOf(pairs: readonly Pair[]): Counts {
  const c: Counts = { changed: 0, unstable: 0, new: 0, gone: 0, unread: 0, same: 0 };
  for (const p of pairs) c[p.state]++;
  return c;
}

export function bindPictures(deps: Deps): Promise<void> {
  d = deps;
  d.store.migrate(SCHEMA);
  // A run a restart cut goes on at the side it was on: what a side ended with is kept in the row.
  const cut = d.store.db.query<Row, []>("SELECT * FROM pictures WHERE state IN ('queued', 'running') ORDER BY id").all().filter((r) => !kept.going.has(r.id));
  return sweep().then(() => {
    for (const r of cut) {
      const run = toRun(r);
      run.state = "queued";
      run.sides = resumed(run.sides, (s) => shotsIn(filesOf(run.id, s)).length);
      save(run);
      void enqueue(run);
    }
  }, (e) => d!.capture(e, { at: "pictures sweep" }));
}

// Scratch checkouts an earlier daemon left: removed, and their repositories' lists pruned.
async function sweep() {
  const work = join(dir(), "work");
  let names: string[] = [];
  try { names = readdirSync(work); } catch { return; }
  for (const n of names) { try { if (n.endsWith(".tool")) openLayers(join(work, n)); rmSync(join(work, n), { recursive: true, force: true }); } catch (e) { d!.capture(e, { at: "pictures sweep", path: n }); } }
  const commons = d!.store.db.query<{ common: string }, []>("SELECT DISTINCT common FROM pictures").all().map((r) => r.common);
  for (const c of commons) if (existsSync(c)) await git(c, ["worktree", "prune"], { timeout: 30_000 }).catch(() => {});
}

function save(r: PictureRun) {
  // (Who is owed its answer is written by owe and followed alone: a run going holds no word of it.)
  d!.store.db.query("UPDATE pictures SET state = ?, why = ?, sides = ?, pairs = ?, kept = ?, started = ?, ended = ? WHERE id = ?")
    .run(r.state, r.why, JSON.stringify(r.sides), r.pairs.length ? JSON.stringify(r.pairs) : null, r.kept ? 1 : 0, r.started, r.ended, r.id);
  r.counts = countsOf(r.pairs);
  for (const sid of new Set([...(r.session_id ? [r.session_id] : []), ...(d!.viewers?.(r) ?? [])])) d!.bus.emit({ t: "feature", name: "pictures", session_id: sid, data: brief(r) });
}

// A run as a list shows it: without its pairs, which a view reads by its id.
export const brief = (r: PictureRun) => ({ ...r, pairs: r.pairs.filter((p) => p.state !== "same").slice(0, 6) });

export const byId = (id: number): PictureRun | undefined => { const r = d?.store.db.query<Row, [number]>("SELECT * FROM pictures WHERE id = ?").get(id); return r ? toRun(r) : undefined; };
export const ofHead = (common: string, head: string): PictureRun | undefined => { const r = d?.store.db.query<Row, [string, string]>("SELECT * FROM pictures WHERE common = ? AND head = ?").get(common, head); return r ? toRun(r) : undefined; };
export const whenDone = (run: PictureRun): Promise<PictureRun> | undefined => kept.going.get(run.id);

// --- reading a tree

const SHA = /^[0-9a-f]{40}$/;
const TEXT_MAX = 512 * 1024;
const CODE = /\.(m?[jt]sx?|cjs|css|html?|json|svelte|vue)$/i;

// The blobs of some paths at a commit, as text (none for one over TEXT_MAX), in one call.
async function blobs(top: string, commit: string, paths: readonly string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (!paths.length) return out;
  const r = await git(top, ["cat-file", "--batch"], { read: true, raw: true, input: paths.map((x) => `${commit}:${x}`).join("\n") + "\n", timeout: 60_000 });
  const buf = Buffer.from(r.bytes ?? new Uint8Array());
  let at = 0;
  for (const path of paths) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const head = buf.toString("utf8", at, nl).split(" ");
    at = nl + 1;
    if (head[1] === "missing" || head.length < 3) continue;
    const size = Number(head[2]);
    if (head[1] === "blob" && size <= TEXT_MAX) out.set(path, new Uint8Array(buf.subarray(at, at + size)));
    at += size + 1;
  }
  return out;
}

const readText = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

// The pictures a head's tree names, read from that tree; undefined: it names none.
async function configAt(top: string, head: string): Promise<{ config?: PicturesConfig; problems: string[] } | undefined> {
  const r = await git(top, ["cat-file", "-p", `${head}:${FILE}`], { read: true, timeout: 15_000 });
  if (r.code !== 0) return undefined;
  if (r.out.length > 64_000) return { problems: ["it is over 64 KB"] };
  return readPictures(r.out);
}

// The harness a side runs with that is not the page: the spec folder's files, the command and what else
// the repository names (`harness` globs), from the head, laid over the base's checkout.
const harnessOf = (cfg: PicturesConfig, paths: readonly string[], specs: readonly string[]): string[] => {
  const globs = cfg.harness.map((g) => new Bun.Glob(g));
  const n = needsOf(cfg.run);
  const run = (n.script ?? n.program).replace(/^\.\//, "");
  return paths.filter((p) => specs.includes(p) || p === run || globs.some((g) => g.match(p)));
};

// --- starting

export type StartIn = { folder: string; head?: string; branch?: string | null; session_id: string | null; agent_id?: string | null; again?: boolean };

// The run of a branch head's pictures: the one it has, else a new one queued. Undefined: the tree names no
// pictures (or the folder is not in a repository).
export async function startFor(o: StartIn): Promise<PictureRun | undefined> {
  if (!d) return undefined;
  const repo = repoOf(o.folder);
  if (!repo) return undefined;
  const head = o.head ?? (await git(o.folder, ["rev-parse", "HEAD"], { read: true, timeout: 15_000 })).out.trim();
  if (!SHA.test(head)) return undefined;
  const had = ofHead(repo.common, head);
  if (had && (!o.again || had.state === "queued" || had.state === "running")) return had;
  const cfg = await configAt(repo.top, head);
  if (!cfg) return undefined;
  const branch = o.branch ?? ((await git(o.folder, ["symbolic-ref", "-q", "--short", "HEAD"], { read: true, timeout: 15_000 })).out.trim() || null);
  const base = (await baseOf(repo))?.name ?? null;
  const mb = base ? (await git(repo.top, ["merge-base", head, base], { read: true, timeout: 30_000 })).out.trim() || null : null;
  // (Kept by the repository's main checkout: the folder may be an agent's worktree, gone after its end.)
  const fresh = { repo: mainTop(repo), common: repo.common, branch, head, base, merge_base: mb, session_id: o.session_id, agent_id: o.agent_id ?? null };
  if (had) { await dropFiles(had.id); d.store.db.query("DELETE FROM pictures WHERE id = ?").run(had.id); }
  const insert = (state: RunState, why: string | null, selection: Selection | null) => {
    const sides = { before: { state: (state === "queued" ? "waiting" : "none") as SideState, commit: mb }, after: { state: (state === "queued" ? "waiting" : "none") as SideState, commit: head } };
    const id = Number(d!.store.db.query("INSERT INTO pictures (repo, common, branch, head, base, merge_base, session_id, agent_id, state, why, selection, sides, created, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(fresh.repo, fresh.common, branch, head, base, mb, fresh.session_id, fresh.agent_id, state, why, selection ? JSON.stringify(selection) : null, JSON.stringify(sides), Date.now(), state === "queued" ? null : Date.now()).lastInsertRowid);
    const run = byId(id)!;
    save(run);
    return run;
  };
  if (!cfg.config) return insert("failed", `its ${FILE}: ${cfg.problems[0]}`, null);
  if (!mb) return insert("skipped", base ? `no merge base with ${base}` : "no base branch to compare with", null);
  const [diff, listed] = await Promise.all([
    git(repo.top, ["diff", "--name-only", "-z", "--no-renames", mb, head, "--"], { read: true, timeout: 30_000 }),
    git(repo.top, ["ls-tree", "-r", "-z", "--name-only", head], { read: true, timeout: 30_000 }),
  ]);
  if (diff.code !== 0 || listed.code !== 0) return insert("failed", `git could not read the change: ${(diff.err || listed.err).trim().slice(0, 160)}`, null);
  const changed = diff.out.split("\0").filter(Boolean);
  const paths = listed.out.split("\0").filter(Boolean);
  const cfgc = cfg.config;
  // (Only what the selection reads: code, styles and markup, never a page's images or fonts.)
  const wanted = paths.filter((p) => CODE.test(p) && (cfgc.pages.some((x) => p.startsWith(x)) || cfgc.specs.some((g) => new Bun.Glob(g).match(p))));
  const texts = await blobs(repo.top, head, wanted);
  const selection = selectSpecs({ changed, paths, text: (p) => readText(texts.get(p)), config: cfgc });
  if (selection.skip) return insert("skipped", selection.skip, selection);
  if (!selection.specs.length) return insert("skipped", `no spec that takes pictures reaches ${selection.unmatched.slice(0, 3).join(", ")}${selection.unmatched.length > 3 ? ` and ${selection.unmatched.length - 3} more` : ""}`, selection);
  const run = insert("queued", null, selection);
  void enqueue(run, { cfg: cfgc, paths });
  return run;
}

// One run at a time in the daemon: two runs of browser specs each.
function enqueue(run: PictureRun, known?: { cfg: PicturesConfig; paths: string[] }): Promise<PictureRun> {
  const p = kept.chain.then(() => execute(run, known))
    .catch((e) => { d!.capture(e, { at: "pictures", run: run.id }); run.state = "failed"; run.why = `Keel failed: ${(e as Error).message}`; return run; })
    .finally(() => { if (run.state === "running" || run.state === "queued") run.state = "done"; run.ended = Date.now(); save(run); kept.going.delete(run.id); void prune(run).catch((e) => d!.capture(e, { at: "pictures prune" })); });
  kept.chain = p.catch(() => {});
  kept.going.set(run.id, p);
  return p;
}

// --- running

async function execute(run: PictureRun, known?: { cfg: PicturesConfig; paths: string[] }): Promise<PictureRun> {
  const repo = repoOf(run.repo) ?? { top: run.repo, gitDir: run.common, common: run.common, scope: run.repo };
  const cfg = known?.cfg ?? (await configAt(repo.top, run.head))?.config;
  if (!cfg) { run.state = "failed"; run.why = `the head's ${FILE} could not be read again`; return run; }
  const paths = known?.paths ?? (await git(repo.top, ["ls-tree", "-r", "-z", "--name-only", run.head], { read: true, timeout: 30_000 })).out.split("\0").filter(Boolean);
  run.state = "running";
  run.started = Date.now();
  run.sizes = cfg.sizes.map(sizeWord);
  run.themes = cfg.themes;
  save(run);
  const specs = run.selection!.specs.map((s) => s.path);
  const harness = await blobs(repo.top, run.head, harnessOf(cfg, paths, specs));
  const has = (s: SideName) => shotsIn(filesOf(run.id, s)).length;
  const sides = ["before", "after"] as const;
  for (const [k, side] of sides.entries()) {
    if (finished(run.sides[side], has(side))) continue;
    const commit = side === "before" ? run.merge_base! : run.head;
    run.sides[side] = { state: "running", commit };
    save(run);
    run.sides[side] = { ...run.sides[side], ...(await takeSide(run, repo as Repo, cfg, side, commit, specs, side === "before" ? harness : undefined, k)) };
    save(run);
  }
  const before = shotsIn(filesOf(run.id, "before")), after = shotsIn(filesOf(run.id, "after"));
  if (!after.length && !before.length) {
    run.state = "failed";
    run.why = run.sides.after.why ?? run.sides.before.why ?? "the command took no picture";
    return run;
  }
  run.pairs = await compareOff(filesOf(run.id, "before"), filesOf(run.id, "after"), before, after);
  // A pair that still differs is checked against a second run of the base, with only the specs that took such a
  // pair: what differs between two runs of the same commit is not the branch's change (src/pictures/diff.ts).
  const differ = run.pairs.filter((p) => p.state === "changed").map((p) => p.name);
  if (before.length && differ.length) {
    const again = run.sides.again?.specs ?? againSpecs(differ, tookBy(filesOf(run.id, "before")), specs);
    if (!finished(run.sides.again, has("again"))) {
      run.sides.again = { state: "running", commit: run.merge_base, specs: again };
      save(run);
      run.sides.again = { ...run.sides.again, ...(await takeSide(run, repo as Repo, cfg, "again", run.merge_base!, again, harness, 2)) };
      save(run);
    }
    const names = shotsIn(filesOf(run.id, "again"));
    if (names.length) run.pairs = await compareOff(filesOf(run.id, "before"), filesOf(run.id, "after"), before, after, { dir: filesOf(run.id, "again"), names });
    await rm(filesOf(run.id, "again"), { recursive: true, force: true });
    save(run);
  }
  // The pairs that are the same are counted, not kept.
  for (const p of run.pairs) if (p.state === "same") for (const s of sides) rmSync(join(filesOf(run.id, s), p.name), { force: true });
  run.state = "done";
  return run;
}

// Which spec took each picture of a side, as the command listed it (KEEL_PICTURES_OUT/shots.tsv; none: unknown).
const tookBy = (at: string): Map<string, string> => { try { return readTookBy(readFileSync(join(at, TOOK), "utf8")); } catch { return new Map(); } };
const TOOK = "shots.tsv";

const shotsIn = (at: string): string[] => { try { return readdirSync(at).filter((n) => n.endsWith(".png")).sort(); } catch { return []; } };

// One side: a scratch checkout of the commit (the head's harness laid over a base), its packages, and the
// picture command with the chosen specs, in the session's sandbox, after a slot of the heavy pool.
async function takeSide(run: PictureRun, repo: Repo, cfg: PicturesConfig, side: SideName, commit: string, specs: string[], harness: Map<string, Uint8Array> | undefined, k: number): Promise<Partial<Side>> {
  const work = join(dir(), "work");
  // (The same path on every side of a run: a path the page shows is the same on both.)
  const scratch = join(work, String(run.id));
  const tool = `${scratch}.tool`;
  const shots = join(tool, "shots");
  const sid = run.session_id ?? "";
  const confined = sid ? d!.confine(sid, scratch, tool) : undefined;
  const how = howToRun(d!.perm(sid), confined);
  if ("refused" in how) return { state: "failed", why: how.refused };
  mkdirSync(work, { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  mkdirSync(join(tool, "tmp"), { recursive: true });
  const top = mainTop(repo);
  const held: string[] = [];
  try {
    try { await worktreeGit(top, ["worktree", "add", "--detach", scratch, commit]); }
    catch (e) { return { state: "failed", why: `${commit.slice(0, 9)} could not be checked out: ${(e as Error).message.slice(0, 160)}` }; }
    if (harness) for (const [p, bytes] of harness) { mkdirSync(join(scratch, p, ".."), { recursive: true }); await Bun.write(join(scratch, p), bytes); }
    const env: Record<string, string> = {
      ...(sid ? toolEnv(sid) : toolEnv("pictures")), CI: "1",
      KEEL_PICTURES_OUT: shots, KEEL_SHOT_SIZES: cfg.sizes.map(sizeWord).join(","), KEEL_SHOT_THEMES: cfg.themes.join(","),
      // The run's instant, to the minute: the same on every side (src/core/fixed-world.ts).
      [FIXED_ENV]: String(Math.floor(run.created / 60_000) * 60_000),
      // A temporary folder of the side's own, at the same path on every side (a scratch path the page shows).
      TMPDIR: join(tool, "tmp"),
    };
    let wrap = confined?.wrap;
    const command = [cfg.run, ...specs.map(quote)].join(" ");
    // (Its scope ends by its own time limit too: one a killed daemon left goes by itself.)
    const unit = (n: number) => `keel-pictures-${process.pid}-${run.id}-${n}`;
    // The side's packages (linked when a checkout here has them for the same lockfile, else the cache's, else installed).
    const pk: Packages = await packagesFor({ scratch, checkDir: ".", sources: [repo.top, top], path: env.PATH ?? "", common: repo.common, again: false, how: confined ? `${confined.sandbox}${confined.network ? "+network" : ""}` : "unconfined" },
      (cwd, c) => runOne({ cwd, tool, env, command: c, limitMs: 600_000, wrap, unit: unit(k * 2) }));
    if (pk.held) held.push(pk.held);
    if (pk.failed) return { state: "failed", why: pk.why ?? "its packages could not be installed" };
    if (confined && pk.shown?.length) { const c = d!.confine(sid, scratch, tool, pk.shown); if (c) wrap = c.wrap; }
    const slot = await pool.take({ session: sid || "pictures", who: "background", command, as: heavyConfig().cost });
    let r: Awaited<ReturnType<typeof runOne>>;
    try { r = await runOne({ cwd: scratch, tool, env, command, limitMs: cfg.timeout_s * 1000, wrap, unit: unit(k * 2 + 1), ...(sid ? { session: sid } : {}) }); }
    finally { if (slot && slot !== "aborted") slot.release(); }
    const got = shotsIn(shots);
    const to = filesOf(run.id, side);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    for (const n of got) renameSync(join(shots, n), join(to, n));
    if (existsSync(join(shots, TOOK))) renameSync(join(shots, TOOK), join(to, TOOK));
    const note = [how.confined ? "" : `outside the sandbox: ${how.why}`, pk.note ?? "", pk.why && !pk.failed ? `packages: ${pk.why}` : ""].filter(Boolean).join("; ");
    const failedRun = r.exit !== 0;
    return {
      state: got.length ? "done" : "failed", exit: r.exit ?? null, ms: r.ms ?? null, cpu_ms: r.cpu_ms ?? null, shots: got.length,
      ...(failedRun ? { why: (r.why || `exit ${r.exit}`).replace(/ on the base/g, side === "after" ? " on the head" : " on the base") } : got.length ? {} : { why: "the command took no picture" }),
      ...(note ? { note } : {}),
    };
  } finally {
    for (const key of held) cache.release(key);
    await worktreeGit(top, ["worktree", "remove", "--force", scratch], { ok: true }).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    openLayers(tool);
    rmSync(tool, { recursive: true, force: true });
  }
}

const quote = (w: string) => (/^[\w./@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// The pairs, compared on a thread of their own (on the loop under a test, or where no thread starts).
let program: string | undefined;
const programUrl = () => (program ??= typeof __KEEL_PICTURES_JS__ === "string" ? URL.createObjectURL(new Blob([__KEEL_PICTURES_JS__], { type: "application/javascript" })) : new URL("./diff-worker.ts", import.meta.url).href);
function compareOff(beforeDir: string, afterDir: string, before: string[], after: string[], again?: { dir: string; names: string[] }): Promise<Pair[]> {
  let w: Worker;
  try { w = new Worker(programUrl()); } catch { return Promise.resolve(pairsOf(beforeDir, afterDir, before, after, again)); }
  return new Promise<Pair[]>((resolve, reject) => {
    w.onmessage = (ev: MessageEvent) => { w.terminate(); const m = ev.data as { pairs?: Pair[]; error?: string }; if (m.pairs) resolve(m.pairs); else reject(new Error(m.error ?? "the compare thread failed")); };
    w.onerror = (e) => { w.terminate(); reject(new Error((e as ErrorEvent).message || "the compare thread failed")); };
    w.postMessage({ beforeDir, afterDir, before, after, again });
  });
}

// --- keeping

async function dropFiles(id: number) { await rm(join(dir(), String(id)), { recursive: true, force: true }); }
const bytesIn = (at: string) => { let n = 0; for (const s of ["before", "after"]) for (const f of shotsIn(join(at, s))) try { n += statSync(join(at, s, f)).size; } catch {} return n; };

// After a run: the files of earlier runs of the same branch go (their head is not the branch's any more), and the
// oldest runs' files while all of them are over the budget.
async function prune(run: PictureRun) {
  if (run.branch) {
    const older = d!.store.db.query<{ id: number }, [string, string, number]>("SELECT id FROM pictures WHERE common = ? AND branch = ? AND id < ? AND kept = 1").all(run.common, run.branch, run.id);
    for (const o of older) { await dropFiles(o.id); d!.store.db.query("UPDATE pictures SET kept = 0 WHERE id = ?").run(o.id); }
  }
  const rows = d!.store.db.query<{ id: number }, []>("SELECT id FROM pictures WHERE kept = 1 AND state = 'done' ORDER BY id DESC").all();
  let total = 0;
  const budget = keepBytes();
  for (const r of rows) {
    total += bytesIn(join(dir(), String(r.id)));
    if (total > budget && r.id !== run.id) { await dropFiles(r.id); d!.store.db.query("UPDATE pictures SET kept = 0 WHERE id = ?").run(r.id); }
  }
}
