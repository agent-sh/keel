// A shadow git repository per workspace, kept in Keel's state directory: it
// snapshots the workspace's files as trees without touching the workspace's
// own repository (its index, refs and objects stay as they were). Every
// operation on one shadow runs one at a time.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { addAll, git, gitSync } from "../core/git.ts";
import { capPatch } from "./patch.ts";
import { timed } from "../admin/stall.ts";

export type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };
// truncated: the patch was cut at DIFF_CAP bytes after a whole line; partial
// names the file the cut ends inside (files after it have no patch shown).
export type DiffResult = { files: FileChange[]; diff: string; truncated: boolean; partial?: string };

const DIFF_CAP = 400_000;
// A file over this is left out of a snapshot (model weights, archives, media);
// a snapshot that would add more than SNAP_CAP falls back to the files the
// session's tools write. Both are owner-settable.
// Read when used, so a setting made after this module loaded applies.
export const fileCap = () => Number(process.env.KEEL_CHECKPOINT_FILE_MB ?? 10) * 1024 * 1024;
const SNAP_CAP = Number(process.env.KEEL_CHECKPOINT_SNAPSHOT_MB ?? 1024) * 1024 * 1024;
// Never snapshotted, in any folder: dependency, cache and build trees that are
// rebuilt, not written by hand (most are gitignored anyway; a folder without a
// .gitignore still holds them).
const ALWAYS_OUT = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".cache/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/", ".tox/", ".gradle/", ".next/", ".nuxt/", ".turbo/", ".parcel-cache/", "target/"];
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
    const huge = workspace === homedir() || workspace === "/" || dirname(workspace) === workspace;
    if (this.mode !== "written") this.mode = huge ? "written" : "tree";
    if (huge) this.reason = "the workspace is the home or root directory, too large to snapshot whole";
  }

  private lock<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => {});
    return run;
  }

  async git(args: string[], opts: { index?: string; input?: string; timeout?: number; ok?: number[] } = {}): Promise<string> {
    const here = existsSync(this.workspace);
    // Through the one place that runs git (src/core/git.ts). The store's own
    // bare directory has Keel's config. A real repository's git directory
    // (`gitDir` given) is read through its view, its own config left out.
    // A work tree only while the folder is there: git refuses a missing one
    // even for what reads only the shadow (refs, trees, gc).
    const r = await git(here ? this.workspace : this.dir, ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
      ...(this.gitDir ? {} : { mode: "own" as const, gitDir: this.dir, workTree: here ? this.workspace : undefined }),
      index: opts.index, input: opts.input, timeout: opts.timeout ?? 60_000,
    });
    if (r.code !== 0 && !(opts.ok ?? []).includes(r.code)) throw new Error(`git ${args[0]} failed (${r.code}): ${r.err.trim().slice(0, 500)}`);
    return r.out;
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
    this.inited = true;
  }

  // The exclude file as this process last wrote it: every snapshot asks for
  // it, and the same text is not written again (a file write on a busy disk
  // holds the loop).
  private excludes?: string;
  private writeExcludes(big: string[]) {
    const lines = ["# written by Keel", ...ALWAYS_OUT, ...(this.own ? [this.own] : []), ...big.map((p) => `/${p.replace(/([*?[\\])/g, "\\$1")}`)];
    const text = lines.join("\n") + "\n";
    if (text === this.excludes) return;
    mkdirSync(join(this.dir, "info"), { recursive: true });
    writeFileSync(join(this.dir, "info", "exclude"), text);
    this.excludes = text;
  }

  // Before a whole-workspace snapshot: files over the cap are left out (and
  // dropped if an earlier snapshot held them); a snapshot that would add too
  // much falls back to written mode. Returns false for that fallback.
  private async sizeUp(index: string): Promise<boolean> {
    this.writeExcludes([]);
    const list = (await this.git(["ls-files", "-z", "--others", "--modified", "--exclude-standard"], { index, timeout: 30_000 })).split("\0").filter(Boolean);
    const big: string[] = [];
    const cap = fileCap();
    let total = 0;
    for (const p of list) {
      let size = 0;
      try { const st = lstatSync(join(this.workspace, p)); if (!st.isFile()) continue; size = st.size; } catch { continue; }
      if (size > cap) big.push(p);
      else total += size;
    }
    this.skipped = big;
    if (big.length) {
      this.writeExcludes(big);
      // Drop a grown file even if its version in the private index differs.
      await this.git(["--literal-pathspecs", "rm", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...big], { index });
    }
    if (total > SNAP_CAP) {
      this.mode = "written";
      this.reason = `the workspace would add ${Math.round(total / 1024 / 1024)} MB to its checkpoints (over ${Math.round(SNAP_CAP / 1024 / 1024)} MB), so only the files the session writes are kept`;
      return false;
    }
    return true;
  }

  // Snapshot to a tree. Whole workspace in tree mode (the workspace's
  // .gitignore files apply); in written mode only `paths` (relative).
  snapshot(paths?: string[]): Promise<string> {
    return this.lock(async () => {
      await this.init();
      if (this.mode === "tree") {
        if (this.gitDir) return this.realTree();
        const index = join(this.dir, "keel-index");
        try {
          if (!(await this.sizeUp(index))) return this.writtenTree(paths ?? []);
          await this.addAll(index, 30_000);
        } catch (e) {
          // Too large or too slow to snapshot whole: fall back to the files the tools write.
          this.mode = "written";
          this.reason = `the whole workspace could not be snapshotted (${(e as Error).message.slice(0, 160)})`;
          return this.writtenTree(paths ?? []);
        }
        return (await this.git(["write-tree"], { index })).trim();
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

  // Keep exactly these trees (one ref each), repack, and let git drop what no
  // checkpoint holds any more. Objects younger than an hour stay: a snapshot
  // in flight is not yet recorded.
  maintain(trees: Map<string, string>): Promise<void> {
    return this.lock(async () => {
      if (this.gitDir || !existsSync(join(this.dir, "HEAD"))) return;
      const have = (await this.git(["for-each-ref", "--format=%(refname)", "refs/keel/cp/"])).split("\n").filter(Boolean);
      const lines = [...have.filter((r) => !trees.has(r.slice("refs/keel/cp/".length))).map((r) => `delete ${r}`), ...[...trees].map(([id, t]) => `update refs/keel/cp/${id} ${t}`)];
      if (lines.length) await this.git(["update-ref", "--stdin"], { input: lines.join("\n") + "\n", timeout: 120_000 });
      await this.git(["-c", "pack.threads=2", "gc", "--quiet", "--prune=1.hour.ago"], { timeout: 600_000 });
    });
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
