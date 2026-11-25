// A shadow git repository per workspace, kept in Keel's state directory: it
// snapshots the workspace's files as trees without touching the workspace's
// own repository (its index, refs and objects stay as they were). Every
// operation on one shadow runs one at a time.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { addAll, git, gitEach, gitSync, innerHead } from "../core/git.ts";
import { capPatch } from "./patch.ts";
import { timed } from "../admin/stall.ts";
import { homeDir } from "../core/paths";

export type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };
// truncated: the patch was cut at DIFF_CAP bytes after a whole line; partial
// names the file the cut ends inside (files after it have no patch shown).
export type DiffResult = { files: FileChange[]; diff: string; truncated: boolean; partial?: string };

const DIFF_CAP = 400_000;
// A file over this is left out of a snapshot (model weights, archives, media);
// a snapshot that would add more than the snapshot cap falls back to the files the
// session's tools write. Both are owner-settable.
// Read when used, so a setting made after this module loaded applies.
export const fileCap = () => Number(process.env.KEEL_CHECKPOINT_FILE_MB ?? 10) * 1024 * 1024;
const snapCap = () => Number(process.env.KEEL_CHECKPOINT_SNAPSHOT_MB ?? 1024) * 1024 * 1024;
// Never snapshotted, in any folder: dependency, cache and build trees that are
// rebuilt, not written by hand (most are gitignored anyway; a folder without a
// .gitignore still holds them).
const ALWAYS_OUT = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".cache/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/", ".tox/", ".gradle/", ".next/", ".nuxt/", ".turbo/", ".parcel-cache/", "target/"];
// A folder found too large for whole-tree mode is remembered in the shadow's own state, so the next
// daemon start does not walk its listing again (one to five seconds of a child's CPU for a folder of
// hundreds of thousands of files). It is walked again when the folder's top level changed (names and
// mtimes), when the caps differ, or after a week.
const LARGE_FILE = "keel-large.json";
const LARGE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
type Large = { reason: string; listed: number; top: string; entries: number; file_cap: number; snap_cap: number; at: number };
// What the last maintenance pass of a store found (see Shadow.maintain), and how long a full pass waits
// after the last one when a tree was let go; past MAX_PACKS packs a full pass rolls them up whatever.
type GcState = { refs: string; full_at: number; owed: boolean };
const GC_FILE = "keel-gc.json";
const FULL_EVERY_MS = 6 * 3600 * 1000;
const MAX_PACKS = 40;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class Shadow {
  readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  // "tree": the whole workspace is snapshotted; "written": only the files the
  // session's tools write (a workspace too large to snapshot, like the home).
  mode: "tree" | "written" = "tree";
  reason?: string;
  skipped: string[] = []; // files over fileCap() left out of the last snapshot
  // Keel's own state folder, when it sits inside the workspace: never snapshotted
  // (the checkpoint store would copy itself on every turn).
  private own: string | null = null;

  // `gitDir` given: snapshot a real repository's working tree (a branch diff
  // that includes uncommitted and untracked files) through a private index.
  constructor(root: string, readonly workspace: string, private gitDir?: string) {
    this.dir = gitDir ?? join(root, createHash("sha256").update(workspace).digest("hex").slice(0, 16) + ".git");
    if (!gitDir && root) {
      const state = relative(workspace, dirname(root));
      if (state === "" || state === ".") { this.mode = "written"; this.reason = "the workspace is Keel's own state folder"; }
      else if (!state.startsWith("..") && !isAbsolute(state)) this.own = `/${state.split(sep).join("/")}/`;
    }
    const huge = workspace === homeDir() || workspace === "/" || dirname(workspace) === workspace;
    if (this.mode !== "written") this.mode = huge ? "written" : "tree";
    if (huge) this.reason = "the workspace is the home or root directory, too large to snapshot whole";
  }

  private lock<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => {});
    return run;
  }

  async git(args: string[], opts: { index?: string; input?: string; timeout?: number; ok?: number[]; low?: boolean } = {}): Promise<string> {
    const here = existsSync(this.workspace);
    // Through the one place that runs git (src/core/git.ts). The store's own
    // bare directory has Keel's config. A real repository's git directory
    // (`gitDir` given) is read through its view, its own config left out.
    // A work tree only while the folder is there: git refuses a missing one
    // even for what reads only the shadow (refs, trees, gc).
    const r = await git(here ? this.workspace : this.dir, ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
      ...(this.gitDir ? {} : { mode: "own" as const, gitDir: this.dir, workTree: here ? this.workspace : undefined }),
      index: opts.index, input: opts.input, timeout: opts.timeout ?? 60_000, low: opts.low,
    });
    if (r.code !== 0 && !(opts.ok ?? []).includes(r.code)) throw new Error(`git ${args[0]} failed (${r.code}): ${r.err.trim().slice(0, 500)}`);
    return r.out;
  }

  // A -z listing read as it comes (gitEach): `each` takes a chunk's entries and returns false to stop.
  async listEach(args: string[], opts: { index?: string; timeout?: number }, each: (entries: string[]) => boolean): Promise<void> {
    const here = existsSync(this.workspace);
    const r = await gitEach(here ? this.workspace : this.dir, ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
      ...(this.gitDir ? {} : { mode: "own" as const, gitDir: this.dir, workTree: here ? this.workspace : undefined }),
      index: opts.index, timeout: opts.timeout ?? 60_000,
    }, each);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.err.trim().slice(0, 500)}`);
  }

  // The top level of the workspace as one digest: each entry's name and mtime, and the folder's own
  // mtime. What the shadow never snapshots (its own state folder, the rebuilt trees) is left out.
  private async topPrint(): Promise<{ top: string; entries: number }> {
    const skip = new Set(ALWAYS_OUT.map((o) => o.slice(0, -1)));
    const own = this.own ? this.own.split("/").filter(Boolean)[0] : undefined;
    const names = (await readdir(this.workspace)).filter((n) => !skip.has(n) && n !== own).sort();
    const stamps = await Promise.all(names.map(async (n) => { try { return `${n}\0${(await lstat(join(this.workspace, n))).mtimeMs}`; } catch { return `${n}\0gone`; } }));
    const here = (await lstat(this.workspace)).mtimeMs;
    return { top: createHash("sha256").update(`${here}\n${stamps.join("\n")}`).digest("hex"), entries: names.length };
  }

  // What an earlier start found too large, when it still holds: same top level, same caps, under a week.
  private async remembered(): Promise<Large | undefined> {
    let m: Large;
    try { m = JSON.parse(readFileSync(join(this.dir, LARGE_FILE), "utf8")); } catch { return undefined; }
    if (!m || typeof m.reason !== "string" || Date.now() - m.at > LARGE_MAX_AGE_MS || Date.now() < m.at) return undefined;
    if (m.file_cap !== fileCap() || m.snap_cap !== snapCap()) return undefined;
    try { return (await this.topPrint()).top === m.top ? m : undefined; } catch { return undefined; }
  }

  private remember(reason: string, listed: number, print?: { top: string; entries: number }) {
    try {
      if (!reason || !print) { rmSync(join(this.dir, LARGE_FILE), { force: true }); return; }
      const m: Large = { reason, listed, top: print.top, entries: print.entries, file_cap: fileCap(), snap_cap: snapCap(), at: Date.now() };
      writeFileSync(join(this.dir, LARGE_FILE), JSON.stringify(m));
    } catch {}
  }

  private inited = false;
  private async init() {
    if (this.gitDir || this.inited) return;
    if (!existsSync(join(this.dir, "HEAD"))) {
      mkdirSync(dirname(this.dir), { recursive: true });
      const r = timed(() => "running git init for a checkpoint store", () => gitSync(dirname(this.dir), ["init", "--bare", "-q", this.dir], { mode: "plain" }));
      if (r.code !== 0) throw new Error(`git init failed: ${r.err.trim()}`);
      await this.git(["config", "gc.auto", "0"]);
    }
    this.writeExcludes([]);
    // A snapshot keeps the work tree's bytes as they are: no clean filter of
    // the owner's git config runs on them. The files' own .gitattributes would
    // otherwise choose one (a pull request's author choosing which of the
    // owner's programs runs, outside any sandbox). The store's own attributes
    // come before the work tree's (gitattributes(5)) and unset it for every file.
    writeFileSync(join(this.dir, "info", "attributes"), "* -filter\n");
    this.inited = true;
  }

  // The exclude file as this process last wrote it: every snapshot asks for
  // it, and the same text is not written again (a file write on a busy disk
  // holds the loop).
  private excludes?: string;
  // What the owner hid from git in this folder's own repository: its .git/info/exclude (a linked
  // worktree's is the shared repository's). git reads that file only for the repository it belongs
  // to, and the store is another one, so its lines are copied in. The global excludes file needs
  // nothing: the store's git reads the owner's own config. Ours follow these lines, so a negation
  // here cannot bring back a folder that is always left out.
  private ownerExcludes(): string[] {
    if (this.gitDir) return [];
    try {
      let dir = join(this.workspace, ".git");
      if (lstatSync(dir).isFile()) {
        const at = /^gitdir:\s*(.+)$/m.exec(readFileSync(dir, "utf8"))?.[1]?.trim();
        if (!at) return [];
        dir = resolve(this.workspace, at);
        try { dir = resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()); } catch {} // no commondir: its own
      }
      return readFileSync(join(dir, "info", "exclude"), "utf8").split("\n").filter((l) => l.trim() !== "");
    } catch { return []; }
  }
  private writeExcludes(big: string[]) {
    const lines = ["# written by Keel", ...this.ownerExcludes(), ...ALWAYS_OUT, ...(this.own ? [this.own] : []), ...big.map((p) => `/${p.replace(/([*?[\\])/g, "\\$1")}`)];
    const text = lines.join("\n") + "\n";
    if (text === this.excludes) return;
    mkdirSync(join(this.dir, "info"), { recursive: true });
    writeFileSync(join(this.dir, "info", "exclude"), text);
    this.excludes = text;
  }

  // The tree the private index was last written out as, while the index is
  // still the one that tree was written from.
  private last?: string;

  // Before a whole-workspace snapshot: files over the cap are left out (and
  // dropped if an earlier snapshot held them); a snapshot that would add too
  // much falls back to written mode. Returns false for that fallback, and
  // "same" when nothing in the workspace differs from the private index (no
  // file new to it, changed or gone): the snapshot is the tree that index was
  // last written out as, and nothing more is run for it. Most snapshots are
  // that one: a turn takes one before its first call that can change files,
  // one after each such call and one at its end, and most calls change none.
  //
  // The listing is read as it comes and sized a chunk at a time, and it stops
  // once what it would add passes the snapshot cap: a folder that holds many
  // repositories lists hundreds of thousands of files (48 MB of names), and
  // holding that whole, then a stat of every file in one pass, held the loop
  // for seconds at a session's first call after each start.
  private async sizeUp(index: string, print?: { top: string; entries: number }): Promise<boolean | "same"> {
    this.writeExcludes([]);
    const cap = fileCap(), most = snapCap();
    // What the last snapshot left out stays listed for good: a file over the cap, an inner repository
    // with no commit yet. When the listing is those and nothing else, and each is still what it was,
    // the snapshot is the last one's tree, and what it skipped is what that one skipped.
    const was = new Set(this.skipped), unborn = new Set(this.unborn);
    let leftOut = !!this.last, listed = 0, total = 0, over = false;
    const repos: string[] = [];
    const big: string[] = [];
    await this.listEach(["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard"], { index, timeout: 30_000 }, (entries) => timed(() => "sizing up a checkpoint's new files", () => {
      for (const p of entries) {
        if (!p) continue;
        listed++;
        if (leftOut && p.endsWith("/") && unborn.has(p.slice(0, -1))) { repos.push(p.slice(0, -1)); continue; }
        if (leftOut && !was.has(p)) leftOut = false;
        let size = -1;
        try { const st = lstatSync(join(this.workspace, p)); if (st.isFile()) size = st.size; } catch {}
        if (size > cap) { big.push(p); continue; }
        if (leftOut) leftOut = false; // listed before as over the cap, and gone or under it now
        if (size > 0) total += size;
        if (total > most) { over = true; return false; }
      }
      return true;
    }));
    if (!listed && this.last) { this.skipped = []; return "same"; }
    // (Asked as the whole snapshot asks: one that has a commit by now is recorded by it.)
    if (leftOut && this.last) {
      let same = true;
      for (const r of repos) if (await innerHead(this.workspace, r)) { same = false; break; }
      if (same) { this.writeExcludes(this.skipped); return "same"; }
    }
    this.last = undefined;
    if (over) {
      this.mode = "written";
      this.reason = `the workspace would add more than ${Math.round(most / 1024 / 1024)} MB to its checkpoints, so only the files the session writes are kept`;
      this.remember(this.reason, listed, print);
      return false;
    }
    this.skipped = big;
    if (big.length) {
      this.writeExcludes(big);
      // Drop a grown file even if its version in the private index differs.
      await this.git(["--literal-pathspecs", "rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...big], { index });
    }
    return true;
  }

  // The inner repositories the last whole snapshot found with no commit to record.
  private unborn: string[] = [];

  // Snapshot to a tree. Whole workspace in tree mode (the workspace's
  // .gitignore files apply); in written mode only `paths` (relative).
  snapshot(paths?: string[]): Promise<string> {
    return this.lock(async () => {
      await this.init();
      if (this.mode === "tree") {
        if (this.gitDir) return this.realTree();
        const index = join(this.dir, "keel-index");
        const known = this.last ? undefined : await this.remembered();
        if (known) {
          this.mode = "written";
          this.reason = known.reason;
          return this.writtenTree(paths ?? []);
        }
        let print: { top: string; entries: number } | undefined;
        try {
          // Taken before the walk: a change made during it is seen by the next start.
          print = await this.topPrint().catch(() => undefined);
          const sized = await this.sizeUp(index, print);
          if (!sized) return this.writtenTree(paths ?? []);
          if (sized === "same") return this.last!;
          this.remember("", 0); // whole-tree mode again: nothing is remembered
          this.unborn = (await this.addAll(index, 30_000)).filter((i) => !i.tracked && !i.head).map((i) => i.path);
        } catch (e) {
          // Too large or too slow to snapshot whole: fall back to the files the tools write.
          this.mode = "written";
          this.reason = `the whole workspace could not be snapshotted (${(e as Error).message.slice(0, 160)})`;
          this.remember(this.reason, 0, print);
          return this.writtenTree(paths ?? []);
        }
        return (this.last = (await this.git(["write-tree"], { index })).trim());
      }
      return this.writtenTree(paths ?? []);
    });
  }

  // Every file of the work tree into `index`. A repository inside it (a
  // submodule that is checked out, a folder with a .git of its own) is
  // recorded by the commit it has out, as git records it, and git is not run
  // inside it from here (src/core/git.ts): so a snapshot never held the
  // uncommitted work inside such a repository, and a rewind does not put it
  // back.
  private addAll(index: string, timeout?: number) {
    return addAll(this.workspace, (args, input) => this.git(args, { index, input, timeout, ok: [1] }), ["--ignore-errors"]);
  }

  // A real repository's working tree as a tree, through a copy of its own
  // index (its stat cache spares hashing unchanged files); its index is not touched.
  private async realTree(): Promise<string> {
    const index = join(this.dir, `keel-snap-${crypto.randomUUID()}`);
    try {
      if (existsSync(join(this.dir, "index"))) copyFileSync(join(this.dir, "index"), index);
      await this.addAll(index);
      return (await this.git(["write-tree"], { index })).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  private async writtenTree(paths: string[]): Promise<string> {
    if (!paths.length) return EMPTY_TREE;
    const index = join(this.dir, `keel-written-${crypto.randomUUID()}`);
    try {
      const present = paths.filter((p) => { try { return lstatSync(join(this.workspace, p)).isFile(); } catch { return false; } });
      if (present.length) {
        const shas = (await this.git(["hash-object", "-w", "--stdin-paths"], { input: present.join("\n") + "\n" })).trim().split("\n");
        // The file's mode as git records it: executable or not.
        const mode = (p: string) => (statSync(join(this.workspace, p)).mode & 0o111 ? "100755" : "100644");
        const info = present.map((p, i) => `${mode(p)} ${shas[i]}\t${p}`).join("\n") + "\n";
        await this.git(["update-index", "--add", "--index-info"], { index, input: info });
      } else return EMPTY_TREE;
      return (await this.git(["write-tree"], { index })).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  // The change from tree a to tree b, optionally limited to some paths.
  diff(a: string, b: string, paths?: string[]): Promise<DiffResult> {
    return this.lock(async () => {
      if (a === b) return { files: [], diff: "", truncated: false };
      const spec = paths ? ["--", ...paths] : [];
      if (paths && !paths.length) return { files: [], diff: "", truncated: false };
      // NUL-separated lists: a path is never quoted or escaped there.
      const ns = await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b, ...spec]);
      // The counts and the patch read the files' contents. A partial clone
      // does not have every one, and the daemon's git fetches nothing: the
      // list of files is shown then, without the patch.
      const [num, patch] = await Promise.all([
        this.git(["diff-tree", "-r", "-z", "--no-renames", "--numstat", a, b, ...spec]),
        this.git(["diff-tree", "-r", "--no-renames", "-p", a, b, ...spec]),
      ]).catch((e) => {
        if (/promisor|lazy fetching disabled|could not fetch|missing blob/i.test((e as Error).message)) return [null, null] as const;
        throw e;
      });
      const counts = new Map((num ?? "").split("\0").filter(Boolean).map((l) => {
        const [ad, rm, ...p] = l.split("\t");
        return [p.join("\t"), { added: Number(ad) || 0, removed: Number(rm) || 0 }];
      }));
      const parts = ns.split("\0");
      const files: FileChange[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i]!, path = parts[i + 1]!;
        if (!status) break;
        files.push({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
      }
      return patch === null ? { files, diff: "", truncated: true } : { files, ...capPatch(patch, DIFF_CAP) };
    });
  }

  // Keep exactly these trees (one ref each), and tidy the store only as far as it needs:
  // - nothing changed since the last pass (the same trees, no loose object):
  //   nothing runs after the one read of the object counts;
  // - something changed: the new objects are packed beside the old packs and the packs are
  //   rolled up by size (a geometric repack), which writes only what is new;
  // - a full `gc` (everything rewritten, what no checkpoint holds dropped once an hour old, as
  //   the cruft pack's expiry) when a tree was let go and `full` is set (the root is over its
  //   budget) or the last full pass was a while ago, because only a full one frees what the
  //   let-go trees held.
  // A store with no record of a last pass is read the same way: tidy stays as it is. Returns what it did.
  maintain(trees: Map<string, string>, full = false): Promise<"skipped" | "packed" | "full"> {
    return this.lock(async () => {
      if (this.gitDir || !existsSync(join(this.dir, "HEAD"))) return "skipped";
      const sorted = [...trees].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const refs = createHash("sha1").update(sorted.map(([id, t]) => `${id} ${t}`).join("\n")).digest("hex");
      const last = this.gcState();
      const counts = await this.counts();
      const same = last?.refs === refs;
      const fullAt = last?.full_at ?? Date.now(); // (a store with no record was packed by the pass before this one)
      const due = Date.now() - fullAt > FULL_EVERY_MS;
      const clean = counts.loose === 0; // (a few packs are a geometric repack's own shape and a gc's cruft pack)
      let owed = last?.owed ?? false; // a tree was let go and no full pass has freed what it held yet
      if (same && clean && !(owed && (full || due))) return "skipped";
      if (!same) {
        const have = (await this.git(["for-each-ref", "--format=%(refname)", "refs/keel/cp/"])).split("\n").filter(Boolean);
        const gone = have.filter((r) => !trees.has(r.slice("refs/keel/cp/".length)));
        if (gone.length) owed = true;
        const lines = [...gone.map((r) => `delete ${r}`), ...sorted.map(([id, t]) => `update refs/keel/cp/${id} ${t}`)];
        if (lines.length) await this.git(["update-ref", "--stdin"], { input: lines.join("\n") + "\n", timeout: 120_000 });
      }
      const doFull = (owed && (full || due)) || counts.packs > MAX_PACKS;
      // Tidy already (no loose object) and not due for a full pass: only the record is made.
      if (!doFull && clean) { this.gcState({ refs, full_at: fullAt, owed }); return "skipped"; }
      if (doFull) await this.git(["-c", "pack.threads=2", "gc", "--quiet", "--prune=1.hour.ago"], { timeout: 600_000, low: true });
      else await this.git(["-c", "pack.threads=2", "repack", "-d", "-l", "-q", "--geometric=2"], { timeout: 600_000, low: true });
      this.gcState({ refs, full_at: doFull ? Date.now() : fullAt, owed: doFull ? false : owed });
      return doFull ? "full" : "packed";
    });
  }

  // The last pass of maintain, kept with the store: the trees it held (a digest), when the last full pass ran, and whether a tree was let go since.
  private gcState(set?: GcState): GcState | undefined {
    const file = join(this.dir, GC_FILE);
    if (set) { try { writeFileSync(file, JSON.stringify(set)); } catch {} return set; }
    try {
      const m = JSON.parse(readFileSync(file, "utf8"));
      return typeof m?.refs === "string" && typeof m.full_at === "number" ? { refs: m.refs, full_at: m.full_at, owed: m.owed === true } : undefined;
    } catch { return undefined; }
  }

  // Loose objects and packs, as `git count-objects -v` says.
  private async counts(): Promise<{ loose: number; packs: number }> {
    const out = await this.git(["count-objects", "-v"], { low: true });
    const n = (k: string) => Number(new RegExp(`^${k}: (\\d+)$`, "m").exec(out)?.[1] ?? 0);
    return { loose: n("count"), packs: n("packs") };
  }

  // Paths that differ between two trees.
  changed(a: string, b: string, paths?: string[]): Promise<string[]> {
    if (a === b || (paths && !paths.length)) return Promise.resolve([]);
    return this.lock(async () => (await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-only", a, b, ...(paths ? ["--", ...paths] : [])])).split("\0").filter(Boolean));
  }

  private async treeValues(tree: string, paths: string[], absent: string, value: (mode: string, oid: string) => string): Promise<Map<string, string>> {
    const out = new Map(paths.map((p) => [p, absent]));
    if (!paths.length) return out;
    const ls = await this.lock(() => this.git(["ls-tree", "-r", "-z", tree, "--", ...paths]));
    for (const rec of ls.split("\0").filter(Boolean)) {
      const tab = rec.indexOf("\t");
      const [mode, , oid] = rec.slice(0, tab).split(" ");
      out.set(rec.slice(tab + 1), value(mode!, oid!));
    }
    return out;
  }

  // The object ID each path has in `tree` ("" for a path it does not hold).
  blobs(tree: string, paths: string[]): Promise<Map<string, string>> {
    return this.treeValues(tree, paths, "", (_mode, oid) => oid);
  }

  // Opaque preview tokens include Git's tree mode, not full Unix permissions.
  // Neither a bare object ID nor "" from an older preview matches these.
  versions(tree: string, paths: string[]): Promise<Map<string, string>> {
    return this.treeValues(tree, paths, "v1:absent", (mode, oid) => `v1:${mode}:${oid}`);
  }

  // Put the files at `paths` back as they are in `tree`; a path the tree does
  // not hold is removed. Nothing is written before the tree is read and its
  // index prepared, so a failure there leaves every file as it was; a failure
  // while writing is reported per path (each one checked against the tree).
  restore(tree: string, paths: string[]): Promise<{ restored: string[]; failed: { path: string; error: string }[] }> {
    return this.lock(async () => {
      if (!paths.length) return { restored: [], failed: [] };
      const listed = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean));
      const back = paths.filter((p) => listed.has(p));
      const gone = paths.filter((p) => !listed.has(p));
      const index = join(this.dir, `keel-restore-${crypto.randomUUID()}`);
      const errs = new Map<string, string>();
      try {
        if (back.length) await this.git(["read-tree", tree], { index });
        if (back.length) {
          try {
            await this.git(["checkout-index", "-f", "-z", "--stdin"], { index, input: back.join("\0") + "\0" });
          } catch (e) {
            // Which ones did not come back: compare each with the tree.
            const want = await this.git(["ls-files", "-s", "-z", "--", ...back], { index });
            const sha = new Map(want.split("\0").filter(Boolean).map((r) => [r.slice(r.indexOf("\t") + 1), r.split(" ")[1]!]));
            for (const p of back) {
              let now = "";
              try { now = (await this.git(["hash-object", "--", p])).trim(); } catch {}
              if (now !== sha.get(p)) errs.set(p, (e as Error).message.slice(0, 300));
            }
          }
        }
      } finally {
        rmSync(index, { force: true });
      }
      for (const p of gone) {
        try { rmSync(join(this.workspace, p), { force: true }); } catch (e) { errs.set(p, (e as Error).message.slice(0, 300)); }
      }
      return { restored: paths.filter((p) => !errs.has(p)), failed: [...errs].map(([path, error]) => ({ path, error })) };
    });
  }

  // A three-way merge of one file: the change base..other applied to the file
  // as it is now (git merge-file). null when it cannot apply as text (no
  // change between base and other, a side missing, a binary file); clean false
  // when the two overlap. Nothing is written.
  merge3(path: string, base: string, other: string): Promise<{ clean: boolean; text: string } | null> {
    return this.lock(async () => {
      const cur = join(this.workspace, path);
      try { if (!lstatSync(cur).isFile()) return null; } catch { return null; }
      const sha = async (tree: string) => (await this.git(["ls-tree", "-z", tree, "--", path])).split("\0")[0]?.split(/\s/)[2] ?? "";
      const [b, o] = [await sha(base), await sha(other)];
      if (!b || !o || b === o) return null;
      const tmp = join(this.dir, `keel-merge-${crypto.randomUUID()}`);
      mkdirSync(tmp);
      try {
        const [bt, ot] = [await this.git(["cat-file", "blob", b]), await this.git(["cat-file", "blob", o])];
        if (bt.includes("\0") || ot.includes("\0")) return null;
        writeFileSync(join(tmp, "base"), bt);
        writeFileSync(join(tmp, "other"), ot);
        // (Run in the scratch folder: a merge of three files needs no repository.)
        const { out: text, code } = await git(tmp, ["merge-file", "-p", "--quiet", cur, join(tmp, "base"), join(tmp, "other")], { mode: "plain", timeout: 30_000 });
        if (code < 0 || code > 127) return null;
        return { clean: code === 0, text };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}
