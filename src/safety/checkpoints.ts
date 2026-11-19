// File checkpoints per turn. Before the first call of a turn that can change
// files, the workspace is snapshotted ("start"); when the turn ends, again
// ("end"). A turn's diff is start..end; a rewind puts files back as they were
// at a turn's start, and skips files changed outside the session's turns
// since (the owner's or another session's edits) unless told otherwise.
import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { contains } from "../core/paths.ts";
import { classifyCall } from "./gate.ts";
import { Shadow, type DiffResult, type FileChange } from "./shadow.ts";
import { hunkPatch } from "./patch.ts";

export type Checkpoint = {
  id: string;
  session_id: string;
  turn: number;               // seq of the turn_start event
  at: "start" | "end" | "undo" | "after"; // undo: before a rewind; after: its result
  tree: string;               // "" once retention let it go (the row stays, so a rewind to it is refused, not redirected)
  paths: string[] | null;     // written mode: the files it covers; null = whole workspace
  skipped: string[] | null;   // files over the size cap left out of this snapshot (not captured is not absent)
  of_id: string | null;       // an "after" row: the undo checkpoint of the same operation
  outside: string[] | null;   // an "end" row: files changed between the turn's own tool calls (someone else's edits)
  created: number;
};

export type TurnSummary = { turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written"; incomplete?: boolean };
export type RewindResult = {
  files: string[]; failed: { path: string; error: string }[]; skipped: string[]; outside: string[];
  removes: string[]; uncaptured: string[]; versions: Record<string, string>; incomplete: boolean; undo: string | null; scope: "tree" | "written";
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, at TEXT NOT NULL, tree TEXT NOT NULL, paths TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, turn, created);
`;
const list = (v: unknown): string[] | null => (typeof v === "string" && v ? JSON.parse(v) : null);
const row = (r: any): Checkpoint => ({ ...r, paths: list(r.paths), skipped: list(r.skipped), outside: list(r.outside), of_id: r.of_id ?? null });
const expired = (turn: number) => new Bad(`the snapshot from before that turn (${turn}) was let go by retention (only the newest checkpoints are kept); rewind to a later turn`, 410);

// Retention: the newest KEEP checkpoints of a session (Claude Code keeps the
// 100 most recent), and a store no larger than the budget (default the
// smaller of 10 GB and 5% of the disk it is on), oldest first.
const KEEP = Number(process.env.KEEL_CHECKPOINT_KEEP ?? 100);
function budget(root: string): number {
  if (process.env.KEEL_CHECKPOINT_BUDGET_MB) return Number(process.env.KEEL_CHECKPOINT_BUDGET_MB) * 1024 * 1024;
  try {
    mkdirSync(root, { recursive: true });
    const st = statfsSync(root);
    return Math.min(10 * 1024 ** 3, st.blocks * st.bsize * 0.05);
  } catch {
    return 10 * 1024 ** 3;
  }
}
function sizeOf(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const x of names) {
      const p = join(d, x);
      try { const st = lstatSync(p); if (st.isDirectory()) walk(p); else n += st.size; } catch {}
    }
  };
  walk(dir);
  return n;
}

// mark: the workspace right after the turn's last call that could change
// files; outside: what changed between those calls (not the session's work).
type Live = { turn: number; start: Promise<Checkpoint>; written: Set<string>; dirty: boolean; mark: Promise<string | null> | null; outside: Set<string> };

export class Checkpoints {
  private shadows = new Map<string, Shadow>();
  private live = new Map<string, Live>();

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, private root: string) {
    store.migrate(SCHEMA);
    for (const col of ["skipped", "of_id", "outside"]) if (!store.columnExists("checkpoints", col)) store.migrate(`ALTER TABLE checkpoints ADD COLUMN ${col} TEXT`);
  }

  shadow(workspace: string): Shadow {
    let s = this.shadows.get(workspace);
    if (!s) this.shadows.set(workspace, (s = new Shadow(this.root, workspace)));
    return s;
  }

  // Every row of a session, the ones retention let go (tree "") included.
  list(sessionId: string): Checkpoint[] {
    return this.store.db.query<any, [string]>("SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created").all(sessionId).map(row);
  }

  get(id: string): Checkpoint | undefined {
    const r = this.store.db.query<any, [string]>("SELECT * FROM checkpoints WHERE id = ?").get(id);
    return r ? row(r) : undefined;
  }

  private save(c: Omit<Checkpoint, "id" | "created" | "skipped" | "of_id" | "outside"> & Partial<Pick<Checkpoint, "skipped" | "of_id" | "outside">>): Checkpoint {
    const cp: Checkpoint = { skipped: null, of_id: null, outside: null, ...c, id: crypto.randomUUID(), created: Date.now() };
    const j = (v: string[] | null) => (v && v.length ? JSON.stringify(v) : null);
    this.store.db.query("INSERT INTO checkpoints (id, session_id, turn, at, tree, paths, skipped, of_id, outside, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(cp.id, cp.session_id, cp.turn, cp.at, cp.tree, cp.paths ? JSON.stringify(cp.paths) : null, j(cp.skipped), cp.of_id, j(cp.outside), cp.created);
    return cp;
  }

  private drop(id: string) {
    this.store.db.query("DELETE FROM checkpoints WHERE id = ?").run(id);
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

  // Files left out of the snapshot just taken (tree mode: over the size cap).
  private skippedOf(sh: Shadow): string[] | null {
    return sh.mode === "tree" && sh.skipped.length ? [...sh.skipped] : null;
  }

  // beforeTool: the turn's start snapshot exists before anything changes.
  async before(s: Session, call: ToolCall) {
    const cls = classifyCall(call);
    if (cls.kind === "read") return;
    const sh = this.shadow(s.workspace);
    const turn = this.currentTurn(s.id);
    let live = this.live.get(s.id);
    if (!live || live.turn !== turn) {
      const written = new Set<string>();
      const first = cls.kind === "edit" ? rel(s.workspace, cls.paths) : [];
      for (const p of first) written.add(p);
      const start = sh.snapshot(first).then((tree) => this.save({ session_id: s.id, turn, at: "start", tree, paths: sh.mode === "written" ? first : null, skipped: this.skippedOf(sh) }));
      // A snapshot that fails never stops the tool: the turn just has no checkpoint.
      start.catch((e) => this.errors.capture("server", e, { at: "checkpoint", session: s.id, workspace: s.workspace }));
      live = { turn, start, written, dirty: false, mark: null, outside: new Set() };
      this.live.set(s.id, live);
      await start.catch(() => {});
      return;
    }
    const cp = await live.start.catch(() => null);
    if (!cp) return;
    // What changed since the turn's last call ended was not this session's tools.
    if (sh.mode === "tree" && live.mark) {
      const mark = live.mark;
      live.mark = null;
      try {
        const m = await mark;
        if (m) for (const p of await sh.changed(m, await sh.snapshot())) live.outside.add(p);
      } catch (e) {
        this.errors.capture("server", e, { at: "checkpoint between calls", session: s.id });
      }
    }
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

  // The workspace as this call left it, taken before the turn goes on: the
  // next call (or the turn's end) compares with it. With calls in parallel
  // the last one to end sets it.
  async after(s: Session, call: ToolCall) {
    const live = this.live.get(s.id);
    if (!live || classifyCall(call).kind === "read") return;
    live.dirty = true;
    const sh = this.shadow(s.workspace);
    if (sh.mode !== "tree") return;
    const mark = live.start.then(() => sh.snapshot()).catch((e) => {
      this.errors.capture("server", e, { at: "checkpoint after call", session: s.id });
      return null;
    });
    live.mark = mark;
    await mark;
  }

  // turnEnd: the end snapshot of a turn that ran something that can change files.
  async end(s: Session) {
    const live = this.live.get(s.id);
    if (!live) return;
    this.live.delete(s.id);
    const start = await live.start.catch(() => null);
    if (!start) return;
    const sh = this.shadow(s.workspace);
    const mark = live.mark ? await live.mark : null;
    const tree = await sh.snapshot(start.paths ?? undefined);
    if (mark) for (const p of await sh.changed(mark, tree)) live.outside.add(p);
    this.save({ session_id: s.id, turn: live.turn, at: "end", tree, paths: start.paths, skipped: this.skippedOf(sh), outside: [...live.outside].sort() });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { turn: live.turn } });
    this.maybeMaintain(s.workspace);
  }

  // Every 20 turn ends of a workspace, or when the last pass was an hour ago:
  // retention, then the store is repacked and what no checkpoint holds goes.
  private ends = new Map<string, { n: number; at: number }>();
  private maybeMaintain(workspace: string) {
    const e = this.ends.get(workspace) ?? { n: 0, at: Date.now() };
    e.n++;
    this.ends.set(workspace, e);
    if (e.n < 20 && Date.now() - e.at < 3600_000) return;
    this.ends.set(workspace, { n: 0, at: Date.now() });
    this.maintain().catch((err) => this.errors.capture("server", err, { at: "checkpoint maintenance" }));
  }

  // A checkpoint retention lets go keeps its row with no tree when it is a
  // turn's start (a rewind to that turn then says it expired instead of
  // landing on the next turn); other rows go.
  async maintain(): Promise<{ removed: number; bytes: number }> {
    const db = this.store.db;
    let removed = 0;
    const settle = () => db.query("DELETE FROM checkpoints WHERE tree = '' AND at != 'start'").run();
    // Rows of sessions that are gone, and past the newest KEEP of each session.
    removed += db.query("DELETE FROM checkpoints WHERE session_id NOT IN (SELECT id FROM sessions)").run().changes;
    removed += db.query(`UPDATE checkpoints SET tree = '' WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created DESC) AS r FROM checkpoints WHERE tree != '') WHERE r > ?)`).run(KEEP).changes;
    settle();
    const gcAll = async () => {
      const rows = db.query<{ id: string; tree: string; workspace: string }, []>("SELECT c.id, c.tree, s.workspace FROM checkpoints c JOIN sessions s ON s.id = c.session_id WHERE c.tree != ''").all();
      const by = new Map<string, Map<string, string>>();
      for (const r of rows) (by.get(r.workspace) ?? by.set(r.workspace, new Map()).get(r.workspace)!).set(r.id, r.tree);
      for (const ws of new Set([...this.shadows.keys(), ...by.keys()])) await this.shadow(ws).maintain(by.get(ws) ?? new Map());
    };
    await gcAll();
    // Over the budget: the oldest tenth goes, until it fits.
    const cap = budget(this.root);
    let bytes = sizeOf(this.root);
    for (let i = 0; i < 6 && bytes > cap; i++) {
      const n = Math.max(1, Math.ceil((db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM checkpoints WHERE tree != ''").get()?.n ?? 0) / 10));
      removed += db.query("UPDATE checkpoints SET tree = '' WHERE id IN (SELECT id FROM checkpoints WHERE tree != '' ORDER BY created LIMIT ?)").run(n).changes;
      settle();
      await gcAll();
      bytes = sizeOf(this.root);
    }
    return { removed, bytes };
  }

  // The turns with checkpoints, each with what it changed. A turn with no end
  // snapshot (the daemon stopped during it) is marked incomplete.
  async turns(s: Session): Promise<{ turns: TurnSummary[]; expired: number }> {
    const cps = this.list(s.id);
    const sh = this.shadow(s.workspace);
    const out: TurnSummary[] = [];
    const starts = cps.filter((c) => c.at === "start");
    for (const start of starts.filter((c) => c.tree)) {
      const turn = start.turn;
      const end = cps.find((c) => c.turn === turn && c.at === "end" && c.tree);
      const d = end ? await sh.diff(start.tree, end.tree) : { files: [] as FileChange[] };
      const files = d.files.map((f) => (end?.outside?.includes(f.path) ? { ...f, outside: true } : f));
      out.push({
        turn, prompt: this.promptOf(s.id, turn), created: start.created, files, scope: start.paths ? "written" : "tree",
        added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
        ...(!end && this.live.get(s.id)?.turn !== turn ? { incomplete: true } : {}),
      });
    }
    return { turns: out, expired: starts.filter((c) => !c.tree).length };
  }

  private promptOf(sessionId: string, turn: number): string {
    const r = this.store.db.query<{ data: string }, [string, number]>("SELECT data FROM events WHERE session_id = ? AND kind = 'user' AND seq < ? ORDER BY seq DESC LIMIT 1").get(sessionId, turn);
    return r ? String(JSON.parse(r.data).text ?? "").slice(0, 200) : "";
  }

  // A tree of the workspace now (in written mode: of every file the session wrote).
  private async now(s: Session): Promise<{ tree: string; paths: string[] | null; skipped: string[] | null }> {
    const sh = this.shadow(s.workspace);
    const paths = sh.mode === "written" ? this.coveredPaths(s.id) : null;
    const tree = await sh.snapshot(paths ?? undefined);
    return { tree, paths, skipped: this.skippedOf(sh) };
  }

  // What one turn changed (turn given), or everything from a turn's start to
  // now (from given); `paths` holds the result to those files (one file's diff
  // when the whole one was cut to fit).
  async diff(s: Session, q: { turn?: number; from?: number; paths?: string[] }): Promise<DiffResult & { scope: "tree" | "written"; incomplete?: boolean }> {
    const cps = this.list(s.id);
    const sh = this.shadow(s.workspace);
    const only = (scope: string[] | null) => (q.paths ? (scope ? q.paths.filter((p) => scope.includes(p)) : q.paths) : scope ?? undefined);
    if (q.turn !== undefined) {
      const start = cps.find((c) => c.turn === q.turn && c.at === "start");
      if (!start) throw new Bad("no checkpoint for that turn");
      if (!start.tree) throw expired(q.turn);
      const end = cps.find((c) => c.turn === q.turn && c.at === "end" && c.tree);
      // No end snapshot: the start against the files now, which may hold later edits.
      const incomplete = !end && this.live.get(s.id)?.turn !== q.turn;
      const to = end?.tree ?? (await this.now(s)).tree;
      const d = await sh.diff(start.tree, to, only(start.paths));
      return { ...d, files: d.files.map((f) => (end?.outside?.includes(f.path) ? { ...f, outside: true } : f)), scope: start.paths ? "written" : "tree", ...(incomplete ? { incomplete } : {}) };
    }
    const from = q.from ?? cps.find((c) => c.at === "start" && c.tree)?.turn;
    if (from === undefined) return { files: [], diff: "", truncated: false, scope: sh.mode };
    const { target, paths } = await this.targetAt(s, from);
    const now = await this.now(s);
    const d = await sh.diff(target, now.tree, only(paths));
    // Mark what changed outside the session's turns (the owner's edits, another session's).
    const outside = await this.outside(s, from, now.tree);
    return { ...d, files: d.files.map((f) => (outside.has(f.path) ? { ...f, outside: true } : f)), scope: paths ? "written" : "tree" };
  }

  // The tree to restore for "back to the start of turn `turn`". In written
  // mode a file the session first wrote in a later turn comes back as it was
  // before the session first wrote it. A turn whose start snapshot expired is
  // refused, never answered with a later turn's.
  private async targetAt(s: Session, turn: number): Promise<{ target: string; paths: string[] | null; skipped: Set<string> }> {
    const rows = this.list(s.id);
    const cps = rows.filter((c) => c.at === "start" && c.turn >= turn);
    if (!cps.length) throw new Bad("no checkpoint at or after that turn");
    if (rows.some((c) => c.turn === turn && c.at === "start" && !c.tree)) throw expired(turn);
    const first = cps[0]!;
    if (!first.tree) throw expired(first.turn);
    if (!first.paths) return { target: first.tree, paths: null, skipped: new Set(first.skipped ?? []) };
    const sh = this.shadow(s.workspace);
    const index = join(sh.dir, `keel-target-${crypto.randomUUID()}`);
    const covered: string[] = [];
    try {
      for (const c of cps) {
        const fresh = (c.paths ?? []).filter((p) => !covered.includes(p));
        if (!fresh.length) continue;
        if (!c.tree) throw expired(c.turn);
        const ls = await sh.git(["ls-tree", "-r", c.tree, "--", ...fresh]);
        if (ls.trim()) await sh.git(["update-index", "--add", "--index-info"], { index, input: ls });
        covered.push(...fresh);
      }
      const tree = (await sh.git(["write-tree"], { index })).trim();
      return { target: tree, paths: covered, skipped: new Set() };
    } finally {
      rmSync(index, { force: true });
    }
  }

  // Paths changed outside the session's own work since the start of turn
  // `turn`: in the gaps between a turn's end (or a rewind's result) and the
  // next turn's start (or the next rewind), between a turn's own calls, and
  // since the last of them.
  private async outside(s: Session, turn: number, nowTree: string): Promise<Set<string>> {
    const all = this.list(s.id).filter((c) => c.tree);
    const from = all.find((c) => c.at === "start" && c.turn >= turn)?.created ?? 0;
    const cps = all.filter((c) => c.created >= from);
    const sh = this.shadow(s.workspace);
    const out = new Set<string>();
    for (let i = 0; i < cps.length; i++) {
      const a = cps[i]!;
      for (const p of a.at === "end" ? a.outside ?? [] : []) out.add(p);
      if (a.at !== "end" && a.at !== "after") continue;
      const b = cps.slice(i + 1).find((c) => c.at === "start" || c.at === "undo");
      const both = a.paths && b?.paths ? a.paths.filter((p) => b.paths!.includes(p)) : a.paths ?? undefined;
      for (const p of await sh.changed(a.tree, b?.tree ?? nowTree, both)) out.add(p);
    }
    return out;
  }

  // A note for the model after files were put back: the conversation still
  // describes the files before, so it hears what changed (appended, so the
  // cached prefix stays).
  private tell(s: Session, what: string, r: { files: string[]; removes: string[]; skipped: string[]; uncaptured: string[]; failed: { path: string }[] }) {
    if (!r.files.length) return;
    const removed = new Set(r.removes);
    const list = (xs: string[]) => xs.slice(0, 30).join(", ") + (xs.length > 30 ? ` and ${xs.length - 30} more` : "");
    const back = r.files.filter((f) => !removed.has(f));
    const gone = r.files.filter((f) => removed.has(f));
    const kept = [...r.skipped, ...r.uncaptured];
    const text = [
      `[harness] The owner ${what}. The conversation above is unchanged; these files are not as it describes them now.`,
      back.length ? `Restored: ${list(back)}.` : "",
      gone.length ? `Removed (they did not exist then): ${list(gone)}.` : "",
      kept.length ? `Left as they are: ${list(kept)}.` : "",
      r.failed.length ? `Could not be restored: ${list(r.failed.map((f) => f.path))}.` : "",
    ].filter(Boolean).join(" ");
    const short = `Files restored: ${r.files.length}${r.failed.length ? `, ${r.failed.length} could not be` : ""}`;
    this.bus.emit({ t: "event", event: this.store.append(s.id, "note", { kind: "rewind", model: true, short, text }) });
  }

  // Take back one hunk of what the session changed in a file since the start
  // of `from` (the daemon's own diff, applied in reverse). The hunk must still
  // read as the owner saw it (`body`: its lines), not only start at the same
  // header: an edit since then would otherwise be taken back unseen. An undo point first.
  async revertHunk(s: Session, o: { from: number; path: string; index: number; header: string; body: string }): Promise<RewindResult> {
    const sh = this.shadow(s.workspace);
    const d = await this.diff(s, { from: o.from, paths: [o.path] });
    const patch = hunkPatch(d.diff, o.path, o.index, o.header);
    const shown = patch?.slice(patch.indexOf(`\n${o.header}\n`) + o.header.length + 2).replace(/\n+$/, "");
    if (!patch || shown !== o.body.replace(/\n+$/, "")) throw new Bad("that hunk is no longer as shown: look at the diff again", 409);
    const now = await this.now(s);
    const undo = this.save({ session_id: s.id, turn: this.currentTurn(s.id), at: "undo", tree: now.tree, paths: now.paths, skipped: now.skipped });
    try {
      await sh.git(["apply", "-R", "--whitespace=nowarn", "-"], { input: patch });
    } catch (e) {
      this.drop(undo.id); // git apply checks before it writes: nothing changed
      throw new Bad(`the hunk does not apply to the file as it is now: ${(e as Error).message.slice(0, 200)}`, 409);
    }
    const after = await this.now(s);
    this.save({ session_id: s.id, turn: undo.turn, at: "after", tree: after.tree, paths: after.paths, of_id: undo.id });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { rewind: true } });
    const r: RewindResult = { files: [o.path], failed: [], skipped: [], outside: [], removes: [], uncaptured: [], versions: {}, incomplete: false, undo: undo.id, scope: sh.mode };
    this.tell(s, `took back one hunk of ${o.path}`, r);
    return r;
  }

  // Put files back as they were at the start of `turn` (all the files that
  // changed since, or only `paths`), or as an undo checkpoint holds them.
  // `confirm` is what the owner saw in the preview: only those paths go back,
  // and only while each is still the version the preview showed.
  async rewind(s: Session, opts: { turn?: number; checkpoint?: string; paths?: string[]; preview?: boolean; includeOutside?: boolean; confirm?: { paths: string[]; versions: Record<string, string> } }): Promise<RewindResult> {
    const sh = this.shadow(s.workspace);
    let target: string;
    let scopePaths: string[] | null;
    let skippedAt = new Set<string>();
    let outsideFrom: number | null = null;
    let incomplete = false;
    // Undo of a rewind: only the files that rewind changed go back, and one
    // edited since it (the owner's hand edit) is outside work, kept by default.
    let undoOf: { after: Checkpoint; touched: Set<string> } | null = null;
    if (opts.checkpoint) {
      const cp = this.get(opts.checkpoint);
      if (!cp || cp.session_id !== s.id) throw new Bad("no such checkpoint", 404);
      if (cp.at !== "undo") throw new Bad("give a turn, or the undo point of a restore");
      if (!cp.tree) throw new Bad("that undo point was let go by retention", 410);
      target = cp.tree;
      scopePaths = cp.paths;
      skippedAt = new Set(cp.skipped ?? []);
      // Paired by operation: the after row that names this undo point. Without
      // it (the restore was cut before its result was recorded) what it changed
      // is unknown, and nothing goes back unless the owner picks it.
      const after = this.list(s.id).find((c) => c.at === "after" && c.of_id === cp.id && c.tree);
      if (after) undoOf = { after, touched: new Set(await sh.changed(cp.tree, after.tree, scopePaths ?? undefined)) };
      else incomplete = true;
    } else {
      if (opts.turn === undefined) throw new Bad("give a turn or a checkpoint");
      let skipped: Set<string>;
      ({ target, paths: scopePaths, skipped } = await this.targetAt(s, opts.turn));
      skippedAt = skipped;
      outsideFrom = opts.turn;
    }
    const now = await this.now(s);
    let files = await sh.changed(target, now.tree, scopePaths ?? undefined);
    if (opts.paths) {
      const want = new Set(rel(s.workspace, opts.paths.map((p) => (isAbsolute(p) ? p : join(s.workspace, p)))));
      files = files.filter((f) => want.has(f));
    }
    if (undoOf) files = files.filter((f) => undoOf!.touched.has(f));
    const inTarget = await sh.blobs(target, files);
    // A file the snapshot left out (over the size cap) was there, not absent: never removed.
    const uncaptured = files.filter((f) => !inTarget.get(f) && skippedAt.has(f));
    files = files.filter((f) => !uncaptured.includes(f));
    const outsideSet = outsideFrom !== null ? await this.outside(s, outsideFrom, now.tree)
      : undoOf ? new Set(await sh.changed(undoOf.after.tree, now.tree, files.length ? files : undefined))
      : new Set(files);
    const outside = files.filter((f) => outsideSet.has(f));
    let restore = opts.includeOutside ? files : files.filter((f) => !outsideSet.has(f));
    const skipped = opts.includeOutside ? [] : outside;
    const versions = Object.fromEntries(await sh.blobs(now.tree, files));
    const removes = files.filter((f) => !inTarget.get(f));
    const scope = scopePaths ? "written" as const : "tree" as const;
    if (opts.preview) return { files: restore, failed: [], skipped, outside, removes, uncaptured, versions, incomplete, undo: null, scope };
    if (opts.confirm) {
      const seen = new Set(opts.confirm.paths);
      const stale = files.filter((f) => seen.has(f) && versions[f] !== (opts.confirm!.versions[f] ?? ""));
      if (stale.length) throw new Bad(`changed since the preview: ${stale.slice(0, 10).join(", ")}; look at it again`, 409);
      restore = restore.filter((f) => seen.has(f));
    }
    const undo = this.save({ session_id: s.id, turn: this.currentTurn(s.id), at: "undo", tree: now.tree, paths: now.paths, skipped: now.skipped });
    let res: Awaited<ReturnType<Shadow["restore"]>>;
    try {
      res = await sh.restore(target, restore);
    } catch (e) {
      this.drop(undo.id);
      throw new Error(`nothing was restored, every file is as it was: ${(e as Error).message.slice(0, 300)}`);
    }
    const after = await this.now(s);
    this.save({ session_id: s.id, turn: undo.turn, at: "after", tree: after.tree, paths: after.paths, of_id: undo.id });
    if (res.failed.length) this.errors.capture("server", new Error(`rewind: ${res.failed.length} of ${restore.length} files could not be restored`), { at: "rewind", session: s.id, failed: res.failed });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { rewind: true } });
    const r: RewindResult = { files: res.restored, failed: res.failed, skipped: opts.includeOutside ? [] : outside.filter((f) => !restore.includes(f)), outside, removes: removes.filter((f) => res.restored.includes(f)), uncaptured, versions: {}, incomplete, undo: undo.id, scope };
    const turnText = outsideFrom !== null ? this.promptOf(s.id, outsideFrom).split("\n")[0]!.slice(0, 80) : "";
    this.tell(s, undoOf || incomplete ? "undid an earlier file restore" : `put files back as they were before the turn that began with "${turnText}"`, r);
    return r;
  }
}

export class Bad extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function rel(workspace: string, paths: string[]): string[] {
  return paths.filter((p) => contains(workspace, p)).map((p) => relative(workspace, p)).filter(Boolean);
}
