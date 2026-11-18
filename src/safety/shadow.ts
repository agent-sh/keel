// A shadow git repository per workspace, kept in Keel's state directory: it
// snapshots the workspace's files as trees without touching the workspace's
// own repository (its index, refs and objects stay as they were). Every
// operation on one shadow runs one at a time.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };
export type DiffResult = { files: FileChange[]; diff: string; truncated: boolean };

const DIFF_CAP = 400_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class Shadow {
  readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  // "tree": the whole workspace is snapshotted; "written": only the files the
  // session's tools write (a workspace too large to snapshot, like the home).
  mode: "tree" | "written";
  reason?: string;

  // `gitDir` given: snapshot a real repository's working tree (a branch diff
  // that includes uncommitted and untracked files) through a private index.
  constructor(root: string, readonly workspace: string, private gitDir?: string) {
    this.dir = gitDir ?? join(root, createHash("sha256").update(workspace).digest("hex").slice(0, 16) + ".git");
    const huge = workspace === homedir() || workspace === "/" || dirname(workspace) === workspace;
    this.mode = huge ? "written" : "tree";
    if (huge) this.reason = "the workspace is the home or root directory, too large to snapshot whole";
  }

  private lock<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => {});
    return run;
  }

  async git(args: string[], opts: { index?: string; input?: string; timeout?: number; ok?: number[] } = {}): Promise<string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), GIT_DIR: this.dir, GIT_WORK_TREE: this.workspace };
    delete env.GIT_INDEX_FILE;
    if (opts.index) env.GIT_INDEX_FILE = opts.index;
    const p = Bun.spawn(["git", "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...args], {
      // Reads still work while a parked worktree's folder is off disk.
      cwd: existsSync(this.workspace) ? this.workspace : this.dir, env,
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe", stderr: "pipe", timeout: opts.timeout ?? 60_000, killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0 && !(opts.ok ?? []).includes(code)) throw new Error(`git ${args[0]} failed (${p.signalCode ?? code}): ${err.trim().slice(0, 500)}`);
    return out;
  }

  private async init() {
    if (this.gitDir) return;
    if (existsSync(join(this.dir, "HEAD"))) return;
    mkdirSync(dirname(this.dir), { recursive: true });
    const r = Bun.spawnSync(["git", "init", "--bare", "-q", this.dir], { stdout: "ignore", stderr: "pipe" });
    if (!r.success) throw new Error(`git init failed: ${r.stderr.toString().trim()}`);
    await this.git(["config", "gc.auto", "0"]);
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
          await this.git(["add", "-A", "--ignore-errors", "--", "."], { index, timeout: 30_000, ok: [1] });
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

  // A real repository's working tree as a tree, through a copy of its own
  // index (its stat cache spares hashing unchanged files); its index is not touched.
  private async realTree(): Promise<string> {
    const index = join(this.dir, `keel-snap-${crypto.randomUUID()}`);
    try {
      if (existsSync(join(this.dir, "index"))) copyFileSync(join(this.dir, "index"), index);
      await this.git(["add", "-A", "--ignore-errors", "--", "."], { index, ok: [1] });
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
        const info = present.map((p, i) => `100644 ${shas[i]}\t${p}`).join("\n") + "\n";
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
      const [ns, num, patch] = await Promise.all([
        this.git(["diff-tree", "-r", "--no-renames", "--name-status", a, b, ...spec]),
        this.git(["diff-tree", "-r", "--no-renames", "--numstat", a, b, ...spec]),
        this.git(["diff-tree", "-r", "--no-renames", "-p", a, b, ...spec]),
      ]);
      const counts = new Map(num.trim().split("\n").filter(Boolean).map((l) => {
        const [ad, rm, ...p] = l.split("\t");
        return [p.join("\t"), { added: Number(ad) || 0, removed: Number(rm) || 0 }];
      }));
      const files = ns.trim().split("\n").filter(Boolean).map((l) => {
        const [status, ...p] = l.split("\t");
        const path = p.join("\t");
        return { path, status: status!, ...(counts.get(path) ?? { added: 0, removed: 0 }) };
      });
      const truncated = patch.length > DIFF_CAP;
      return { files, diff: truncated ? patch.slice(0, DIFF_CAP) : patch, truncated };
    });
  }

  // Paths that differ between two trees.
  async changed(a: string, b: string, paths?: string[]): Promise<string[]> {
    return (await this.diff(a, b, paths)).files.map((f) => f.path);
  }

  // Put the files at `paths` back as they are in `tree`; a path the tree does
  // not hold is removed.
  restore(tree: string, paths: string[]): Promise<void> {
    return this.lock(async () => {
      if (!paths.length) return;
      const listed = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean));
      const back = paths.filter((p) => listed.has(p));
      for (const p of paths.filter((p) => !listed.has(p))) rmSync(join(this.workspace, p), { force: true });
      if (!back.length) return;
      const index = join(this.dir, `keel-restore-${crypto.randomUUID()}`);
      try {
        await this.git(["read-tree", tree], { index });
        await this.git(["checkout-index", "-f", "-z", "--stdin"], { index, input: back.join("\0") + "\0" });
      } finally {
        rmSync(index, { force: true });
      }
    });
  }
}
