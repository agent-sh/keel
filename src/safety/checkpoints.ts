// File checkpoints per turn. Before the first call of a turn that can change
// files, the workspace is snapshotted ("start"); when the turn ends, again
// ("end"). A turn's diff is start..end; a rewind puts files back as they were
// at a turn's start, and skips files changed outside the session's turns
// since (the owner's or another session's edits) unless told otherwise.
import { lstatSync, mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Bus } from "../core/bus.ts";
import { detached, type ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { contains, realOf } from "../core/paths.ts";
import { classifyCall } from "./gate.ts";
import type { CallClass } from "./policy.ts";
import { Shadow, type DiffResult, type FileChange } from "./shadow.ts";
import { hunkPatch } from "./patch.ts";
import { branchNote, leftTurns } from "./branch-note.ts";
import type { StoredEvent } from "../core/types.ts";

// A read, and a tool that acts on what Keel keeps for the session (ToolKind "own"), touch no file of the workspace.
export const changesNoFiles = (cls: CallClass) => cls.kind === "read" || (cls.kind === "control" && !!cls.own);

export type Checkpoint = {
  id: string;
  session_id: string;
  turn: number;               // seq of the turn_start event
  at: "start" | "end" | "undo" | "after" | "step"; // undo: before a rewind; after: its result; step: before one call that changed files
  tree: string;               // "" once retention let it go (the row stays, so a rewind to it is refused, not redirected)
  paths: string[] | null;     // written mode: the files it covers; null = whole workspace
  skipped: string[] | null;   // files over the size cap left out of this snapshot (not captured is not absent)
  of_id: string | null;       // an "after" row: the undo checkpoint of the same operation
  outside: string[] | null;   // an "end" row: files changed between the turn's own tool calls (someone else's edits)
  workspace: string | null;   // the folder it was taken of (a session can move); its trees live in that folder's shadow
  label: string | null;       // a "step" row: the call it stands before, in a few words (its `of_id` is the call's id)
  created: number;
};

// elsewhere: the turn ran in another folder (the session moved since); its
// diff still reads, a rewind to it is refused. unavailable: its diff could not be read.
export type Step = { id: string; call: string; label: string; created: number };
export type TurnSummary = { steps?: Step[]; turn: number; prompt: string; created: number; files: FileChange[]; added: number; removed: number; scope: "tree" | "written"; incomplete?: boolean; elsewhere?: string; unavailable?: string };
// merged: files changed outside the session whose turn change is taken back
// around that edit (a clean three-way merge); conflicts: ones where the two overlap (kept as they are).
export type RewindResult = {
  files: string[]; failed: { path: string; error: string }[]; skipped: string[]; outside: string[]; merged: string[]; conflicts: string[];
  blocked: { path: string; uncaptured: string }[];
  removes: string[]; uncaptured: string[]; versions: Record<string, string>; incomplete: boolean; undo: string | null; scope: "tree" | "written";
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, at TEXT NOT NULL, tree TEXT NOT NULL, paths TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, turn, created);
`;
const list = (v: unknown): string[] | null => (typeof v === "string" && v ? JSON.parse(v) : null);
const row = (r: any): Checkpoint => ({ ...r, paths: list(r.paths), skipped: list(r.skipped), outside: list(r.outside), of_id: r.of_id ?? null, workspace: r.workspace ?? null, label: r.label ?? null });
const expired = (turn: number) => new Bad(`the snapshot from before that turn (${turn}) was let go by retention (only the newest checkpoints are kept); rewind to a later turn`, 410);

// Retention: the newest KEEP checkpoints of a session (Claude Code keeps the
// 100 most recent), and a store no larger than the budget (default the
// smaller of 10 GB and 5% of the disk it is on), oldest first.
// Read when a store is tended, not when this file loads: a setting made after that counts too.
const keep = () => Number(process.env.KEEL_CHECKPOINT_KEEP ?? 100);
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
// calls (tree mode): each call still running. `writes`: the files it names
// (null for a shell or other call, which may write anything); `pre`: the
// workspace as it began; `may`: every file it or a call beside it may write;
// `blind` once a shell call ran beside it (nothing in its window can be told apart).
type Running = { before: Promise<string | null>; writes: Set<string> | null; pre: Promise<string | null> | null; may: Set<string>; blind: boolean };
type Live = { began: Promise<string | null>; turn: number; start: Promise<Checkpoint>; written: Set<string>; dirty: boolean; mark: Promise<string | null> | null; outside: Set<string>; calls: Map<string, Running> };

export class Checkpoints {
  private shadows = new Map<string, Shadow>();
  private live = new Map<string, Live>();

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker, private root: string) {
    store.migrate(SCHEMA);
    for (const col of ["skipped", "of_id", "outside", "workspace", "label"]) if (!store.columnExists("checkpoints", col)) store.migrate(`ALTER TABLE checkpoints ADD COLUMN ${col} TEXT`);
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

  // The rows of the folder the session is in now: what a rewind or the
  // session diff works on (a row from before a move belongs to its own folder).
  private here(s: Session): Checkpoint[] {
    return this.list(s.id).filter((c) => !c.workspace || c.workspace === s.workspace);
  }

  private save(s: Session, c: Omit<Checkpoint, "id" | "created" | "skipped" | "of_id" | "outside" | "workspace" | "label" | "session_id"> & Partial<Pick<Checkpoint, "skipped" | "of_id" | "outside" | "label">>): Checkpoint {
    const cp: Checkpoint = { skipped: null, of_id: null, outside: null, label: null, ...c, session_id: s.id, workspace: s.workspace, id: crypto.randomUUID(), created: Date.now() };
    const j = (v: string[] | null) => (v && v.length ? JSON.stringify(v) : null);
    this.store.db.query("INSERT INTO checkpoints (id, session_id, turn, at, tree, paths, skipped, of_id, outside, workspace, label, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(cp.id, cp.session_id, cp.turn, cp.at, cp.tree, cp.paths ? JSON.stringify(cp.paths) : null, j(cp.skipped), cp.of_id, j(cp.outside), cp.workspace, cp.label, cp.created);
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
  private coveredPaths(s: Session): string[] {
    const all = new Set<string>();
    for (const c of this.here(s)) for (const p of c.paths ?? []) all.add(p);
    for (const p of this.live.get(s.id)?.written ?? []) all.add(p);
    return [...all].sort();
  }

  // Files left out of the snapshot just taken (tree mode: over the size cap).
  private skippedOf(sh: Shadow): string[] | null {
    return sh.mode === "tree" && sh.skipped.length ? [...sh.skipped] : null;
  }

  // beforeTool: the turn's start snapshot exists before anything changes.
  async before(s: Session, call: ToolCall) {
    const cls = classifyCall(call);
    if (changesNoFiles(cls)) return;
    const sh = this.shadow(s.workspace);
    const turn = this.currentTurn(s.id);
    let live = this.live.get(s.id);
    if (!live || live.turn !== turn) {
      const written = new Set<string>();
      const first = cls.kind === "edit" ? rel(s.workspace, cls.paths) : [];
      for (const p of first) written.add(p);
      const start = sh.snapshot(first).then((tree) => this.save(s, { turn, at: "start", tree, paths: sh.mode === "written" ? first : null, skipped: this.skippedOf(sh) }));
      // A snapshot that fails never stops the tool: the turn just has no checkpoint.
      start.catch((e) => this.errors.capture("server", e, { at: "checkpoint", session: s.id, workspace: s.workspace }));
      live = { began: start.then((c) => c.tree, () => null), turn, start, written, dirty: false, mark: null, outside: new Set(), calls: new Map() };
      this.live.set(s.id, live);
      if (sh.mode === "tree") this.track(live, s, call, cls, start.then((c) => c.tree, () => null), live.began);
      await start.catch(() => {});
      return;
    }
    const cp = await live.start.catch(() => null);
    if (!cp) return;
    // What changed since the turn's last call ended was not this session's tools.
    if (sh.mode === "tree") {
      const mark = live.mark;
      live.mark = null;
      let now: Promise<string | null> | null = null;
      // Where this call begins: the files as the last call that changed some left them (an edit from outside
      // in between included, so a step restore keeps it); the turn's start while no call has; the same as
      // the call before it when that one is still running; unknown when the last snapshot failed.
      let began: Promise<string | null> = live.began;
      try {
        const m = mark && (await mark);
        if (mark && !m) began = Promise.resolve(null);
        if (m) {
          now = sh.snapshot();
          began = now;
          for (const p of await sh.changed(m, (await now)!)) live.outside.add(p);
        }
      } catch (e) {
        this.errors.capture("server", e, { at: "checkpoint between calls", session: s.id });
      }
      live.began = began = began.catch(() => null);
      this.track(live, s, call, cls, cls.kind === "edit" ? (now ?? sh.snapshot()).catch(() => null) : null, began);
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
    if (!live || changesNoFiles(classifyCall(call))) return;
    live.dirty = true;
    const sh = this.shadow(s.workspace);
    if (sh.mode !== "tree") return;
    const mark = live.start.then(() => sh.snapshot()).catch((e) => {
      this.errors.capture("server", e, { at: "checkpoint after call", session: s.id });
      return null;
    });
    live.mark = mark;
    const run = live.calls.get(call.id);
    live.calls.delete(call.id);
    // A file edit tool writes only the files it names: anything else that
    // changed while it ran is someone else's edit. A shell command can write
    // anything, so what changes while one runs stays the session's work.
    try {
      const [pre, post] = await Promise.all([run && !run.blind ? run.pre : null, mark]);
      if (pre && post) for (const p of await sh.changed(pre, post)) if (!run!.may.has(p)) live.outside.add(p);
      // A call that changed files keeps the tree it began on: "revert from here" on that step.
      const began = run ? await run.before : null;
      if (began && post && began !== post) this.save(s, { turn: live.turn, at: "step", tree: began, paths: null, skipped: this.skippedOf(sh), of_id: call.id, label: labelOf(call) });
    } catch (e) {
      this.errors.capture("server", e, { at: "checkpoint during call", session: s.id });
    }
  }

  // A call starting (tree mode): what each call already running may see
  // written beside it, and what this one may.
  private track(live: Live, s: Session, call: ToolCall, cls: ReturnType<typeof classifyCall>, pre: Promise<string | null> | null, before: Promise<string | null>) {
    const writes = cls.kind === "edit" ? new Set(rel(s.workspace, cls.paths)) : null;
    const run: Running = { before, writes, pre: writes ? pre : null, may: new Set(writes), blind: false };
    for (const o of live.calls.values()) {
      if (writes) for (const p of writes) o.may.add(p);
      else o.blind = true;
      if (o.writes) for (const p of o.writes) run.may.add(p);
      else run.blind = true;
    }
    live.calls.set(call.id, run);
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
    this.save(s, { turn: live.turn, at: "end", tree, paths: start.paths, skipped: this.skippedOf(sh), outside: [...live.outside].sort() });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { turn: live.turn } });
    this.maybeMaintain();
  }

  // One pass covers every store under the root, so one count of turn ends serves them all: a pass
  // starts at the 20th end since the last one, or an hour after it. Never two at once.
  private ends = { n: 0, at: Date.now() };
  private maybeMaintain() {
    this.ends.n++;
    if (this.ends.n < 20 && Date.now() - this.ends.at < 3600_000) return;
    if (this.pass) return;
    // The store's upkeep, not this turn's work: it runs and fails in no turn.
    detached(() => this.maintain().catch((err) => this.errors.capture("server", err, { at: "checkpoint maintenance" })));
  }

  // A checkpoint retention lets go keeps its row with no tree when it is a
  // turn's start (a rewind to that turn then says it expired instead of
  // landing on the next turn); other rows go.
  private pass: Promise<{ removed: number; bytes: number }> | null = null;
  private next: Promise<{ removed: number; bytes: number }> | null = null;
  maintain(): Promise<{ removed: number; bytes: number }> {
    // A pass runs one at a time. One asked for while another runs waits for it and is one pass for
    // every asker, since it reads the rows when it starts.
    if (this.pass) return (this.next ??= this.pass.catch(() => {}).then(() => { this.next = null; return this.maintain(); }));
    this.ends = { n: 0, at: Date.now() };
    const run = this.run().finally(() => { this.pass = null; });
    this.pass = run;
    return run;
  }

  private async run(): Promise<{ removed: number; bytes: number }> {
    const db = this.store.db;
    let removed = 0;
    // The steps of a turn go with it: when its start was let go, or the step's own tree was.
    const settle = () => {
      db.query("DELETE FROM checkpoints WHERE tree = '' AND at != 'start'").run();
      return db.query("DELETE FROM checkpoints WHERE at = 'step' AND NOT EXISTS (SELECT 1 FROM checkpoints st WHERE st.session_id = checkpoints.session_id AND st.turn = checkpoints.turn AND st.at = 'start' AND st.tree != '')").run().changes;
    };
    // Rows of sessions that are gone, and past the newest KEEP of each session.
    removed += db.query("DELETE FROM checkpoints WHERE session_id NOT IN (SELECT id FROM sessions)").run().changes;
    removed += db.query(`UPDATE checkpoints SET tree = '' WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created DESC) AS r FROM checkpoints WHERE tree != '' AND at != 'step') WHERE r > ?)`).run(keep()).changes;
    removed += settle();
    const gcAll = async (full = false) => {
      // Each tree is kept in the shadow of the folder it was taken of.
      const rows = db.query<{ id: string; tree: string; workspace: string }, []>("SELECT c.id, c.tree, COALESCE(c.workspace, s.workspace) AS workspace FROM checkpoints c JOIN sessions s ON s.id = c.session_id WHERE c.tree != ''").all();
      const by = new Map<string, Map<string, string>>();
      for (const r of rows) (by.get(r.workspace) ?? by.set(r.workspace, new Map()).get(r.workspace)!).set(r.id, r.tree);
      for (const ws of new Set([...this.shadows.keys(), ...by.keys()])) await this.shadow(ws).maintain(by.get(ws) ?? new Map(), full);
    };
    await gcAll();
    // Over the budget: the oldest tenth goes, until it fits.
    const cap = budget(this.root);
    let bytes = sizeOf(this.root);
    for (let i = 0; i < 6 && bytes > cap; i++) {
      const n = Math.max(1, Math.ceil((db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM checkpoints WHERE tree != ''").get()?.n ?? 0) / 10));
      removed += db.query("UPDATE checkpoints SET tree = '' WHERE id IN (SELECT id FROM checkpoints WHERE tree != '' ORDER BY created LIMIT ?)").run(n).changes;
      removed += settle();
      await gcAll(true); // only a full pass gives back what the let-go trees held
      bytes = sizeOf(this.root);
    }
    return { removed, bytes };
  }

  // The turns with checkpoints, each with what it changed. A turn with no end
  // snapshot (the daemon stopped during it) is marked incomplete.
  async turns(s: Session): Promise<{ turns: TurnSummary[]; expired: number }> {
    const cps = this.list(s.id);
    const out: TurnSummary[] = [];
    const starts = cps.filter((c) => c.at === "start");
    for (const start of starts.filter((c) => c.tree)) {
      const turn = start.turn;
      const ws = start.workspace ?? s.workspace;
      const end = cps.find((c) => c.turn === turn && c.at === "end" && c.tree && (c.workspace ?? s.workspace) === ws);
      const base = { turn, prompt: this.promptOf(s.id, turn), created: start.created, scope: start.paths ? "written" as const : "tree" as const, ...(ws !== s.workspace ? { elsewhere: ws } : {}) };
      // One turn whose trees cannot be read does not take the list with it.
      let files: FileChange[] = [];
      try {
        files = end ? (await this.shadow(ws).diff(start.tree, end.tree)).files.map((f) => (end.outside?.includes(f.path) ? { ...f, outside: true } : f)) : [];
      } catch (e) {
        out.push({ ...base, files: [], added: 0, removed: 0, unavailable: (e as Error).message.slice(0, 200) });
        continue;
      }
      const steps = cps.filter((c) => c.at === "step" && c.turn === turn && c.tree && c.of_id).map((c): Step => ({ id: c.id, call: c.of_id!, label: c.label ?? "", created: c.created }));
      out.push({
        ...base, ...(steps.length ? { steps } : {}), files,
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
    const paths = sh.mode === "written" ? this.coveredPaths(s) : null;
    const tree = await sh.snapshot(paths ?? undefined);
    return { tree, paths, skipped: this.skippedOf(sh) };
  }

  // What one turn changed (turn given), or everything from a turn's start to
  // now (from given); `paths` holds the result to those files (one file's diff
  // when the whole one was cut to fit).
  async diff(s: Session, q: { turn?: number; from?: number; paths?: string[] }): Promise<DiffResult & { scope: "tree" | "written"; incomplete?: boolean }> {
    const cps = this.list(s.id);
    const here = this.here(s);
    const sh = this.shadow(s.workspace);
    const only = (scope: string[] | null) => (q.paths ? (scope ? q.paths.filter((p) => scope.includes(p)) : q.paths) : scope ?? undefined);
    if (q.turn !== undefined) {
      const start = cps.find((c) => c.turn === q.turn && c.at === "start");
      if (!start) throw new Bad("no checkpoint for that turn");
      if (!start.tree) throw expired(q.turn);
      // A turn from before a move reads from its own folder's shadow.
      const ws = start.workspace ?? s.workspace;
      const end = cps.find((c) => c.turn === q.turn && c.at === "end" && c.tree && (c.workspace ?? s.workspace) === ws);
      // No end snapshot: the start against the files now, which may hold later edits.
      const incomplete = !end && this.live.get(s.id)?.turn !== q.turn;
      if (!end && ws !== s.workspace) return { files: [], diff: "", truncated: false, scope: start.paths ? "written" : "tree", incomplete: true };
      const to = end?.tree ?? (await this.now(s)).tree;
      const d = await this.shadow(ws).diff(start.tree, to, only(start.paths));
      return { ...d, files: d.files.map((f) => (end?.outside?.includes(f.path) ? { ...f, outside: true } : f)), scope: start.paths ? "written" : "tree", ...(incomplete ? { incomplete } : {}) };
    }
    // The session diff is since a turn in this folder: one from before a move
    // to it reads from this folder's first turn after it.
    const away = (t: number) => !here.some((c) => c.at === "start" && c.turn === t);
    const from = q.from !== undefined && !away(q.from) ? q.from : here.find((c) => c.at === "start" && c.tree && c.turn >= (q.from ?? 0))?.turn;
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
    const away = this.list(s.id).find((c) => c.turn === turn && c.at === "start" && c.workspace && c.workspace !== s.workspace);
    if (away) throw new Bad(`that turn ran in ${away.workspace}; the session is in ${s.workspace} now, so its files cannot be put back here`, 409);
    const rows = this.here(s);
    const cps = rows.filter((c) => c.at === "start" && c.turn >= turn);
    if (!cps.length) throw new Bad("no checkpoint at or after that turn in this folder");
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
  // since the last of them. Each maps to the row its first gap starts at (the
  // session's last version before the outside edit), null for an edit made
  // between a turn's calls.
  private async outside(s: Session, turn: number, nowTree: string): Promise<Map<string, Checkpoint | null>> {
    const all = this.here(s).filter((c) => c.tree);
    const from = all.find((c) => c.at === "start" && c.turn >= turn)?.created ?? 0;
    const cps = all.filter((c) => c.created >= from);
    const sh = this.shadow(s.workspace);
    const out = new Map<string, Checkpoint | null>();
    for (let i = 0; i < cps.length; i++) {
      const a = cps[i]!;
      for (const p of a.at === "end" ? a.outside ?? [] : []) if (!out.has(p)) out.set(p, null);
      if (a.at !== "end" && a.at !== "after") continue;
      const b = cps.slice(i + 1).find((c) => c.at === "start" || c.at === "undo");
      const both = a.paths && b?.paths ? a.paths.filter((p) => b.paths!.includes(p)) : a.paths ?? undefined;
      for (const p of await sh.changed(a.tree, b?.tree ?? nowTree, both)) if (!out.has(p)) out.set(p, a);
    }
    return out;
  }

  // Did the session itself change `path` after row `gap` (a later turn, or a restore)?
  private async touchedAfter(s: Session, gap: Checkpoint, path: string, nowTree: string): Promise<boolean> {
    const rows = this.here(s).filter((c) => c.tree && c.created > gap.created);
    const sh = this.shadow(s.workspace);
    for (const a of rows) {
      if (a.at !== "start" && a.at !== "undo") continue;
      const b = a.at === "start" ? rows.find((c) => c.at === "end" && c.turn === a.turn) : rows.find((c) => c.at === "after" && c.of_id === a.id);
      if ((await sh.changed(a.tree, b?.tree ?? nowTree, [path])).length) return true;
    }
    return false;
  }

  // A note for the model after files were put back: the conversation still
  // describes the files before, so it hears what changed (appended, so the
  // cached prefix stays).
  private tell(s: Session, what: string, r: RewindResult, sink?: (data: NoteData) => void, turns?: number[]) {
    if (!r.files.length) return;
    const removed = new Set(r.removes);
    const list = (xs: string[]) => xs.slice(0, 30).join(", ") + (xs.length > 30 ? ` and ${xs.length - 30} more` : "");
    const back = r.files.filter((f) => !removed.has(f));
    const gone = r.files.filter((f) => removed.has(f));
    const kept = [...r.skipped, ...r.uncaptured, ...r.blocked.map((f) => f.path)];
    const text = [
      `[harness] The owner ${what}. The conversation above is unchanged; these files are not as it describes them now.`,
      back.length ? `Restored: ${list(back)}.` : "",
      gone.length ? `Removed (they did not exist then): ${list(gone)}.` : "",
      kept.length ? `Left as they are: ${list(kept)}.` : "",
      r.failed.length ? `Could not be restored: ${list(r.failed.map((f) => f.path))}.` : "",
    ].filter(Boolean).join(" ");
    const short = `Files restored: ${r.files.length}${r.failed.length ? `, ${r.failed.length} could not be` : ""}`;
    const data: NoteData = { kind: "rewind", model: true, short, text, ...(turns?.length ? { turns } : {}) };
    if (sink) sink(data);
    else this.bus.emit({ t: "event", event: this.store.append(s.id, "note", data) });
  }

  // The first turn at or after a prompt's place in the history that has a start snapshot: where a rewind to
  // that prompt puts the files back to.
  fileTurn(s: Session, seq: number): number | undefined {
    return this.here(s).find((c) => c.at === "start" && c.turn >= seq)?.turn;
  }

  // The files a turn left out of its end snapshot that its start snapshot held or did not meet: over the size
  // cap at its end, not before it. A rewind puts none of them back (`uncaptured`), and says so before it runs.
  leftOut(s: Session, from: number): { turn: number; path: string }[] {
    const rows = this.here(s);
    const out: { turn: number; path: string }[] = [];
    for (const end of rows) {
      if (end.at !== "end" || end.turn < from || !end.skipped?.length) continue;
      const start = rows.find((c) => c.at === "start" && c.turn === end.turn);
      const was = new Set(start?.skipped ?? []);
      for (const p of end.skipped) if (!was.has(p)) out.push({ turn: end.turn, path: p });
    }
    return out;
  }

  // A turn's changed files never change: read once.
  private turnFiles = new Map<string, string[]>();

  // What the disk holds from turns the branch `line` does not contain, told once (src/safety/branch-note.ts).
  async branchNote(s: Session, line: readonly StoredEvent[]): Promise<{ short: string; text: string; turns: number[] } | undefined> {
    const starts = this.here(s).filter((c) => c.at === "start" && c.tree);
    if (!starts.length) return undefined;
    const left = leftTurns(starts.map((c) => c.turn), line);
    if (!left.length) return undefined;
    const rows = this.here(s);
    const files = new Set<string>();
    for (const turn of left) {
      const start = starts.find((c) => c.turn === turn)!;
      const end = rows.find((c) => c.turn === turn && c.at === "end" && c.tree);
      if (!end) continue;
      let got = this.turnFiles.get(start.id);
      if (!got) {
        got = await this.shadow(s.workspace).changed(start.tree, end.tree, start.paths ?? undefined);
        this.turnFiles.set(start.id, got);
      }
      for (const f of got) files.add(f);
    }
    return files.size ? { ...branchNote([...files]), turns: left } : undefined;
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
    const undo = this.save(s, { turn: this.currentTurn(s.id), at: "undo", tree: now.tree, paths: now.paths, skipped: now.skipped });
    try {
      await sh.git(["apply", "-R", "--whitespace=nowarn", "-"], { input: patch });
    } catch (e) {
      this.drop(undo.id); // git apply checks before it writes: nothing changed
      throw new Bad(`the hunk does not apply to the file as it is now: ${(e as Error).message.slice(0, 200)}`, 409);
    }
    const after = await this.now(s);
    this.save(s, { turn: undo.turn, at: "after", tree: after.tree, paths: after.paths, of_id: undo.id });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { rewind: true } });
    const r: RewindResult = { files: [o.path], failed: [], skipped: [], outside: [], merged: [], conflicts: [], blocked: [], removes: [], uncaptured: [], versions: {}, incomplete: false, undo: undo.id, scope: sh.mode };
    this.tell(s, `took back one hunk of ${o.path}`, r);
    return r;
  }

  // Put files back as they were at the start of `turn` (all the files that
  // changed since, or only `paths`), or as an undo checkpoint holds them.
  // `confirm` is what the owner saw in the preview: only those paths go back,
  // and only while each is still the version the preview showed.
  // `note`: where the note for the model goes instead of the end of the branch shown (a chat rewind or
  // an edit makes the new branch first); `quiet`: no note (an undo that brings the branch it was told on back).
  async rewind(s: Session, opts: { turn?: number; step?: string; checkpoint?: string; paths?: string[]; preview?: boolean; includeOutside?: boolean; confirm?: { paths: string[]; versions: Record<string, string> }; note?: (data: NoteData) => void; quiet?: boolean }): Promise<RewindResult> {
    const sh = this.shadow(s.workspace);
    let target: string;
    let scopePaths: string[] | null;
    let skippedAt = new Set<string>();
    let outsideFrom: number | null = null;
    let incomplete = false;
    let stepLabel: string | null = null;
    // Undo of a rewind: only the files that rewind changed go back, and one
    // edited since it (the owner's hand edit) is outside work, kept by default.
    let undoOf: { after: Checkpoint; touched: Set<string> } | null = null;
    if (opts.checkpoint) {
      const cp = this.get(opts.checkpoint);
      if (!cp || cp.session_id !== s.id) throw new Bad("no such checkpoint", 404);
      if (cp.workspace && cp.workspace !== s.workspace) throw new Bad(`that undo point is of ${cp.workspace}; the session is in ${s.workspace} now`, 409);
      if (cp.at !== "undo") throw new Bad("give a turn, or the undo point of a restore");
      if (!cp.tree) throw new Bad("that undo point was let go by retention", 410);
      target = cp.tree;
      scopePaths = cp.paths;
      skippedAt = new Set(cp.skipped ?? []);
      // Paired by operation: the after row that names this undo point. Without
      // it (the restore was cut before its result was recorded) what it changed
      // is unknown, and nothing goes back unless the owner picks it.
      const after = this.here(s).find((c) => c.at === "after" && c.of_id === cp.id && c.tree);
      if (after) undoOf = { after, touched: new Set(await sh.changed(cp.tree, after.tree, scopePaths ?? undefined)) };
      else incomplete = true;
    } else if (opts.step) {
      // Before one call of a turn: the files as that call found them, from the same protection of outside edits.
      const cp = this.get(opts.step);
      if (!cp || cp.session_id !== s.id || cp.at !== "step") throw new Bad("no such step", 404);
      if (cp.workspace && cp.workspace !== s.workspace) throw new Bad(`that step ran in ${cp.workspace}; the session is in ${s.workspace} now, so its files cannot be put back here`, 409);
      if (!cp.tree) throw new Bad("that step was let go by retention", 410);
      target = cp.tree;
      scopePaths = null;
      skippedAt = new Set(cp.skipped ?? []);
      outsideFrom = cp.turn;
      stepLabel = cp.label ?? "";
    } else {
      if (opts.turn === undefined) throw new Bad("give a turn or a checkpoint");
      let skipped: Set<string>;
      ({ target, paths: scopePaths, skipped } = await this.targetAt(s, opts.turn));
      skippedAt = skipped;
      outsideFrom = opts.turn;
    }
    const now = await this.now(s);
    const want = opts.paths && new Set(rel(s.workspace, opts.paths.map((p) => (isAbsolute(p) ? p : join(s.workspace, p)))));
    const selected = (f: string) => (!want || want.has(f)) && (!undoOf || undoOf.touched.has(f));
    // A capped file can be missing from both trees, so the tree diff alone
    // cannot tell us which current files have to be kept.
    const capped = new Set(now.skipped ?? []);
    const skippedNow = new Set([...capped].filter((f) => (!scopePaths || scopePaths.includes(f)) && selected(f)));
    // Forced checkout can replace a directory or a file in the way of a
    // directory. Use all capped paths, even outside a scoped restore.
    const cappedBelow = new Map<string, string>();
    for (const f of capped) for (const p of parents(f)) if (!cappedBelow.has(p)) cappedBelow.set(p, f);
    const blocked: RewindResult["blocked"] = [];
    let files = (await sh.changed(target, now.tree, scopePaths ?? undefined)).filter((f) => {
      if (!selected(f)) return false;
      if (!capped.size) return true;
      if (capped.has(f)) { skippedNow.add(f); return false; }
      const uncaptured = cappedBelow.get(f) ?? [...parents(f)].find((p) => capped.has(p));
      if (!uncaptured) return true;
      skippedNow.add(uncaptured);
      blocked.push({ path: f, uncaptured });
      return false;
    });
    const inTarget = await sh.blobs(target, files);
    // The target must say what to restore, and the undo point must capture
    // what we would overwrite. A file left out by the cap is not absent.
    const uncaptured = [...skippedNow, ...files.filter((f) => !inTarget.get(f) && skippedAt.has(f))];
    files = files.filter((f) => inTarget.get(f) || !skippedAt.has(f));
    const outsideSet: Map<string, Checkpoint | null> = outsideFrom !== null ? await this.outside(s, outsideFrom, now.tree)
      : new Map((undoOf ? await sh.changed(undoOf.after.tree, now.tree, files.length ? files : undefined) : files).map((f) => [f, null]));
    const outside = files.filter((f) => outsideSet.has(f));
    let restore = opts.includeOutside ? files : files.filter((f) => !outsideSet.has(f));
    const skipped = opts.includeOutside ? [] : outside;
    // "Undo this turn" around an outside edit: the session's own change to that
    // file is taken back and the edit stays, when the two do not overlap.
    const merges = new Map<string, string>();
    const conflicts: string[] = [];
    if (outsideFrom !== null && !opts.includeOutside) {
      for (const f of outside) {
        const gap = outsideSet.get(f);
        if (!gap || !inTarget.get(f) || (await this.touchedAfter(s, gap, f, now.tree))) continue;
        const m = await sh.merge3(f, gap.tree, target);
        if (m?.clean) merges.set(f, m.text);
        else if (m) conflicts.push(f);
      }
    }
    const versions = Object.fromEntries(await sh.versions(now.tree, files));
    const removes = files.filter((f) => !inTarget.get(f));
    const scope = scopePaths ? "written" as const : "tree" as const;
    if (opts.preview) return { files: restore, failed: [], skipped: skipped.filter((f) => !merges.has(f)), outside, merged: [...merges.keys()], conflicts, blocked, removes, uncaptured, versions, incomplete, undo: null, scope };
    if (opts.confirm) {
      const { paths, versions: expected } = opts.confirm;
      const seen = new Set(paths);
      const stale = [
        ...files.filter((f) => seen.has(f) && versions[f] !== expected[f]),
        ...[...skippedNow].filter((f) => seen.has(f)),
        ...blocked.filter((f) => seen.has(f.path)).map((f) => f.path),
      ];
      if (stale.length) throw new Bad(`changed since the preview: ${stale.slice(0, 10).join(", ")}; look at it again`, 409);
      restore = restore.filter((f) => seen.has(f));
      for (const f of [...merges.keys()]) if (!seen.has(f)) merges.delete(f);
    }
    const undo = this.save(s, { turn: this.currentTurn(s.id), at: "undo", tree: now.tree, paths: now.paths, skipped: now.skipped });
    let res: Awaited<ReturnType<Shadow["restore"]>>;
    try {
      res = await sh.restore(target, restore);
    } catch (e) {
      this.drop(undo.id);
      throw new Error(`nothing was restored, every file is as it was: ${(e as Error).message.slice(0, 300)}`);
    }
    const merged: string[] = [];
    for (const [f, text] of merges) {
      try { writeFileSync(join(s.workspace, f), text); merged.push(f); } catch (e) { res.failed.push({ path: f, error: (e as Error).message.slice(0, 300) }); }
    }
    const after = await this.now(s);
    this.save(s, { turn: undo.turn, at: "after", tree: after.tree, paths: after.paths, of_id: undo.id });
    if (res.failed.length) this.errors.capture("server", new Error(`rewind: ${res.failed.length} of ${restore.length} files could not be restored`), { at: "rewind", session: s.id, failed: res.failed });
    this.bus.emit({ t: "feature", name: "checkpoints", session_id: s.id, data: { rewind: true } });
    const r: RewindResult = { files: [...res.restored, ...merged], failed: res.failed, skipped: opts.includeOutside ? [] : outside.filter((f) => !restore.includes(f) && !merged.includes(f)), outside, merged, conflicts, blocked, removes: removes.filter((f) => res.restored.includes(f)), uncaptured, versions: {}, incomplete, undo: undo.id, scope };
    const turnText = outsideFrom !== null ? this.promptOf(s.id, outsideFrom).split("\n")[0]!.slice(0, 80) : "";
    // Every turn from the start of this one on had its files put back: a branch that leaves them is not told they stay.
    const covered = outsideFrom !== null && stepLabel === null ? this.here(s).filter((c) => c.at === "start" && c.turn >= outsideFrom!).map((c) => c.turn) : undefined;
    if (!opts.quiet) this.tell(s, stepLabel !== null ? `put files back as they were before the call "${stepLabel}" in the turn that began with "${turnText}"` : undoOf || incomplete ? "undid an earlier file restore" : `put files back as they were before the turn that began with "${turnText}"`, r, opts.note, covered);
    return r;
  }
}

// A note stored for the model (and shown) after a restore.
export type NoteData = { kind: string; model: true; short: string; text: string; turns?: number[] };

export class Bad extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Shadow tree paths use "/" as the component separator.
function* parents(path: string): Iterable<string> {
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) yield path.slice(0, at);
}

// A call in a few words for the list of a turn's steps: its tool and what it was given (a path or the first line of a command).
function labelOf(call: ToolCall): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  const hint = [i.file_path, i.path, i.command, i.description].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return `${call.tool.name}${hint ? ` ${hint.trim().split("\n")[0]!.slice(0, 100)}` : ""}`;
}

// Workspace-relative paths of the files a call writes, where the writes land:
// a link in the workspace is its target (when that is in the workspace too).
function rel(workspace: string, paths: string[]): string[] {
  const root = realOf(workspace);
  return paths.map((p) => realOf(p)).filter((p) => contains(root, p)).map((p) => relative(root, p)).filter(Boolean);
}
