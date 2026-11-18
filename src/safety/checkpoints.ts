// File checkpoints per turn. Before the first call of a turn that can change
// files, the workspace is snapshotted ("start"); when the turn ends, again
// ("end"). A turn's diff is start..end; a rewind puts files back as they were
// at a turn's start, and skips files changed outside the session's turns
// since (the owner's or another session's edits) unless told otherwise.
import { rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { classify, inside } from "./policy.ts";
import { Shadow, type DiffResult, type FileChange } from "./shadow.ts";

export type Checkpoint = {
  id: string;
  session_id: string;
  turn: number;               // seq of the turn_start event
  at: "start" | "end" | "undo" | "after"; // undo: before a rewind; after: its result
  tree: string;
  paths: string[] | null;     // written mode: the files it covers; null = whole workspace
  created: number;
};

export type TurnSummary = { turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written" };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, at TEXT NOT NULL, tree TEXT NOT NULL, paths TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, turn, created);
`;

type Live = { turn: number; start: Promise<Checkpoint>; written: Set<string>; dirty: boolean };

export class Checkpoints {
  private shadows = new Map<string, Shadow>();
  private live = new Map<string, Live>();

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, private root: string) {
    store.migrate(SCHEMA);
  }

  shadow(workspace: string): Shadow {
    let s = this.shadows.get(workspace);
    if (!s) this.shadows.set(workspace, (s = new Shadow(this.root, workspace)));
    return s;
  }

  list(sessionId: string): Checkpoint[] {
    return this.store.db.query<any, [string]>("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created").all(sessionId)
      .map((r) => ({ ...r, paths: r.paths ? JSON.parse(r.paths) : null }));
  }

  get(id: string): Checkpoint | undefined {
    const r = this.store.db.query<any, [string]>("SELECT * FROM checkpoints WHERE id = ?").get(id);
    return r ? { ...r, paths: r.paths ? JSON.parse(r.paths) : null } : undefined;
  }

  private save(c: Omit<Checkpoint, "id" | "created">): Checkpoint {
    const cp: Checkpoint = { ...c, id: crypto.randomUUID(), created: Date.now() };
    this.store.db.query("INSERT INTO checkpoints (id, session_id, turn, at, tree, paths, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(cp.id, cp.session_id, cp.turn, cp.at, cp.tree, cp.paths ? JSON.stringify(cp.paths) : null, cp.created);
    return cp;
  }

  private update(cp: Checkpoint) {
    this.store.db.query("UPDATE checkpoints SET tree = ?, paths = ? WHERE id = ?").run(cp.tree, cp.paths ? JSON.stringify(cp.paths) : null, cp.id);
  }

  private currentTurn(sessionId: string): number {
    return this.store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ? AND kind = 'turn_start'").get(sessionId)?.n ?? 0;
  }

  // Every file the session's tools wrote, relative to the workspace (written mode).
  private coveredPaths(sessionId: string): string[] {
    const all = new Set<string>();
    for (const c of this.list(sessionId)) for (const p of c.paths ?? []) all.add(p);
    for (const p of this.live.get(sessionId)?.written ?? []) all.add(p);
    return [...all].sort();
  }

  // beforeTool: the turn's start snapshot exists before anything changes.
  async before(s: Session, call: ToolCall) {
    const cls = classify(call.tool, call.input, call.ctx.cwd);
    if (cls.kind === "read") return;
    const sh = this.shadow(s.workspace);
    const turn = this.currentTurn(s.id);
    let live = this.live.get(s.id);
    if (!live || live.turn !== turn) {
      const written = new Set<string>();
      const first = cls.kind === "edit" ? rel(s.workspace, cls.paths) : [];
      for (const p of first) written.add(p);
      const start = sh.snapshot(first).then((tree) => this.save({ session_id: s.id, turn, at: "start", tree, paths: sh.mode === "written" ? first : null }));
      // A snapshot that fails never stops the tool: the turn just has no checkpoint.
      start.catch((e) => this.errors.capture("server", e, { at: "checkpoint", session: s.id, workspace: s.workspace }));
      live = { turn, start, written, dirty: false };
      this.live.set(s.id, live);
      await start.catch(() => {});
      return;
    }
    const cp = await live.start.catch(() => null);
    if (!cp) return;
    if (sh.mode !== "written" || cls.kind !== "edit") return;
    const add = rel(s.workspace, cls.paths).filter((p) => !live!.written.has(p));
    if (!add.length) return;
    for (const p of add) live.written.add(p);
    // Grow the start snapshot by the files about to be written, as they are now.
    const index = join(sh.dir, `keel-grow-${crypto.randomUUID()}`);
    try {
      await sh.git(["read-tree", cp.tree], { index });
      const ls = await sh.git(["ls-tree", "-r", await sh.snapshot(add)]);
      if (ls.trim()) await sh.git(["update-index", "--add", "--index-info"], { index, input: ls });
      cp.tree = (await sh.git(["write-tree"], { index })).trim();
      cp.paths = [...(cp.paths ?? []), ...add];
      this.update(cp);
    } finally {
      rmSync(index, { force: true });
    }
  }

  after(s: Session, call: ToolCall) {
    if (call.tool.readOnly) return;
    const live = this.live.get(s.id);
    if (live) live.dirty = true;
  }

  // turnEnd: the end snapshot of a turn that ran something that can change files.
  async end(s: Session) {
    const live = this.live.get(s.id);
    if (!live) return;
    this.live.delete(s.id);
    const start = await live.start.catch(() => null);
    if (!start) return;
    const sh = this.shadow(s.workspace);
    const tree = await sh.snapshot(start.paths ?? undefined);
    this.save({ session_id: s.id, turn: live.turn, at: "end", tree, paths: start.paths });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { turn: live.turn } });
  }

  // The turns with checkpoints, each with what it changed.
  async turns(s: Session): Promise<TurnSummary[]> {
    const cps = this.list(s.id);
    const sh = this.shadow(s.workspace);
    const out: TurnSummary[] = [];
    const turns = [...new Set(cps.filter((c) => c.at === "start").map((c) => c.turn))];
    for (const turn of turns) {
      const start = cps.find((c) => c.turn === turn && c.at === "start")!;
      const end = cps.find((c) => c.turn === turn && c.at === "end");
      const d = end ? await sh.diff(start.tree, end.tree) : { files: [] as FileChange[] };
      out.push({
        turn, prompt: this.promptOf(s.id, turn), created: start.created, files: d.files, scope: start.paths ? "written" : "tree",
        added: d.files.reduce((n, f) => n + f.added, 0), removed: d.files.reduce((n, f) => n + f.removed, 0),
      });
    }
    return out;
  }

  private promptOf(sessionId: string, turn: number): string {
    const r = this.store.db.query<{ data: string }, [string, number]>("SELECT data FROM events WHERE session_id = ? AND kind = 'user' AND seq < ? ORDER BY seq DESC LIMIT 1").get(sessionId, turn);
    return r ? String(JSON.parse(r.data).text ?? "").slice(0, 200) : "";
  }

  // A tree of the workspace now (in written mode: of every file the session wrote).
  private async now(s: Session): Promise<{ tree: string; paths: string[] | null }> {
    const sh = this.shadow(s.workspace);
    const paths = sh.mode === "written" ? this.coveredPaths(s.id) : null;
    return { tree: await sh.snapshot(paths ?? undefined), paths };
  }

  // What one turn changed (turn given), or everything from a turn's start to now (from given).
  async diff(s: Session, q: { turn?: number; from?: number }): Promise<DiffResult & { scope: "tree" | "written" }> {
    const cps = this.list(s.id);
    const sh = this.shadow(s.workspace);
    if (q.turn !== undefined) {
      const start = cps.find((c) => c.turn === q.turn && c.at === "start");
      if (!start) throw new Bad("no checkpoint for that turn");
      const end = cps.find((c) => c.turn === q.turn && c.at === "end");
      const to = end?.tree ?? (await this.now(s)).tree;
      return { ...(await sh.diff(start.tree, to, start.paths ?? undefined)), scope: start.paths ? "written" : "tree" };
    }
    const from = q.from ?? cps.find((c) => c.at === "start")?.turn;
    if (from === undefined) return { files: [], diff: "", truncated: false, scope: sh.mode };
    const { target, paths } = await this.targetAt(s, from);
    const now = await this.now(s);
    const d = await sh.diff(target, now.tree, paths ?? undefined);
    // Mark what changed outside the session's turns (the owner's edits, another session's).
    const outside = await this.outside(s, from, now.tree);
    return { ...d, files: d.files.map((f) => (outside.has(f.path) ? { ...f, outside: true } : f)), scope: paths ? "written" : "tree" };
  }

  // The tree to restore for "back to the start of turn `turn`". In written
  // mode a file the session first wrote in a later turn comes back as it was
  // before the session first wrote it.
  private async targetAt(s: Session, turn: number): Promise<{ target: string; paths: string[] | null }> {
    const cps = this.list(s.id).filter((c) => c.at === "start" && c.turn >= turn);
    if (!cps.length) throw new Bad("no checkpoint at or after that turn");
    const first = cps[0]!;
    if (!first.paths) return { target: first.tree, paths: null };
    const sh = this.shadow(s.workspace);
    const index = join(sh.dir, `keel-target-${crypto.randomUUID()}`);
    const covered: string[] = [];
    try {
      for (const c of cps) {
        const fresh = (c.paths ?? []).filter((p) => !covered.includes(p));
        if (!fresh.length) continue;
        const ls = await sh.git(["ls-tree", "-r", c.tree, "--", ...fresh]);
        if (ls.trim()) await sh.git(["update-index", "--add", "--index-info"], { index, input: ls });
        covered.push(...fresh);
      }
      const tree = (await sh.git(["write-tree"], { index })).trim();
      return { target: tree, paths: covered };
    } finally {
      rmSync(index, { force: true });
    }
  }

  // Paths changed outside the session's own work since the start of turn
  // `turn`: in the gaps between a turn's end (or a rewind's result) and the
  // next turn's start (or the next rewind), and since the last of them.
  private async outside(s: Session, turn: number, nowTree: string): Promise<Set<string>> {
    const all = this.list(s.id);
    const from = all.find((c) => c.at === "start" && c.turn >= turn)?.created ?? 0;
    const cps = all.filter((c) => c.created >= from);
    const sh = this.shadow(s.workspace);
    const out = new Set<string>();
    for (let i = 0; i < cps.length; i++) {
      const a = cps[i]!;
      if (a.at !== "end" && a.at !== "after") continue;
      const b = cps.slice(i + 1).find((c) => c.at === "start" || c.at === "undo");
      const both = a.paths && b?.paths ? a.paths.filter((p) => b.paths!.includes(p)) : a.paths ?? undefined;
      for (const p of await sh.changed(a.tree, b?.tree ?? nowTree, both)) out.add(p);
    }
    return out;
  }

  // Put files back as they were at the start of `turn` (all the files that
  // changed since, or only `paths`), or as an undo checkpoint holds them.
  async rewind(s: Session, opts: { turn?: number; checkpoint?: string; paths?: string[]; preview?: boolean; includeOutside?: boolean }) {
    const sh = this.shadow(s.workspace);
    let target: string;
    let scopePaths: string[] | null;
    let outsideFrom: number | null = null;
    if (opts.checkpoint) {
      const cp = this.get(opts.checkpoint);
      if (!cp || cp.session_id !== s.id) throw new Bad("no such checkpoint", 404);
      target = cp.tree;
      scopePaths = cp.paths;
    } else {
      if (opts.turn === undefined) throw new Bad("give a turn or a checkpoint");
      ({ target, paths: scopePaths } = await this.targetAt(s, opts.turn));
      outsideFrom = opts.turn;
    }
    const now = await this.now(s);
    let files = await sh.changed(target, now.tree, scopePaths ?? undefined);
    if (opts.paths) {
      const want = new Set(rel(s.workspace, opts.paths.map((p) => (isAbsolute(p) ? p : join(s.workspace, p)))));
      files = files.filter((f) => want.has(f));
    }
    const outsideSet = outsideFrom !== null ? await this.outside(s, outsideFrom, now.tree) : new Set<string>();
    const outside = files.filter((f) => outsideSet.has(f));
    const restore = opts.includeOutside ? files : files.filter((f) => !outsideSet.has(f));
    const skipped = opts.includeOutside ? [] : outside;
    if (opts.preview) return { files: restore, skipped, outside, undo: null, scope: scopePaths ? "written" : "tree" };
    const undo = this.save({ session_id: s.id, turn: this.currentTurn(s.id), at: "undo", tree: now.tree, paths: now.paths });
    await sh.restore(target, restore);
    const after = await this.now(s);
    this.save({ session_id: s.id, turn: undo.turn, at: "after", tree: after.tree, paths: after.paths });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { rewind: true } });
    return { files: restore, skipped, outside, undo: undo.id, scope: scopePaths ? "written" : "tree" };
  }
}

export class Bad extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function rel(workspace: string, paths: string[]): string[] {
  return paths.filter((p) => inside(p, workspace)).map((p) => relative(workspace, p)).filter(Boolean);
}
