// Moving a session: the place its tools run changes, with its git state. The
// conversation stays with this daemon. `carry: "git"` makes the directory's
// state one snapshot commit (HEAD, or a commit on top holding every
// uncommitted change, built through a throwaway index so the directory it
// leaves is not touched), sends what the destination lacks as a git bundle,
// and puts it in a worktree there with the rest uncommitted again. What was
// staged travels apart from the files, as git stash keeps it: the snapshot's
// second parent is a commit of the index, and the index there is set from it,
// so staged, unstaged and untracked changes arrive as they were. Coming
// back, the snapshot lands in the directory the session first left, only when
// that directory is as the session left it; its own state is saved to a ref
// first, always.
//
// A move is safe to cut at any step and to start again. Each step leaves what
// it did on the session's row first (the worktree it is about to make, the ref
// a folder's own state went to), the switch is one write (the machine, the
// folder, the note and the receipt together), and a daemon that starts finds
// the moves the last one left running and closes them: the session is on one
// side with both its machine and its folder, and its transcript says where the
// move stopped and what it kept.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { Engine } from "../engine/turn.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, linkFetch } from "./link.ts";
import { readText } from "../core/proc.ts";

export type StepName = "interrupt" | "snapshot" | "transfer" | "worktree" | "switch";
export type Step = { name: StepName; state: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
export type Handoff = {
  session_id: string; state: "running" | "done" | "failed"; carry: "git" | "none";
  from: { machine_id: string; machine: string; cwd: string }; to: { machine_id: string; machine: string; cwd?: string };
  steps: Step[]; started_ms: number; ended_ms?: number; summary?: string; error?: string; home?: string; away?: Record<string, string>;
  before_ref?: string; replaced?: boolean;
  // Closed by the daemon that started after the one that ran it. `details`:
  // what it kept (the carry ref, the worktree there, the ref of the folder's own state).
  interrupted?: boolean; details?: string[];
  // The switch is stored; the session's queue is still to be let go on.
  settle?: boolean;
  // The owner held the session's queue before the move: it stays held after it.
  held?: boolean;
};
// `away`: the worktree the session has on a machine. `making`: one about to be
// made there, written before the call that makes it, so a move cut in between
// makes that one again and never a second. `left`: the state a folder was in
// when the session left it or a move last put it there ("files tree:index tree").
// `landing`: the state a move is about to put in a folder, written before it
// changes the folder: a move cut after that left the folder in this state, and
// the next move takes it as the session's own, not as someone else's change.
type Moves = { home?: string; away: Record<string, string>; left: Record<string, string>; making?: Record<string, { dir: string; branch: string }>; landing?: Record<string, string>; last?: Handoff };
const BEFORE_KEPT = 3; // a folder's own states saved before a landing, newest first, per session

const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=Keel -c user.email=keel@localhost";
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const key = (machine: string, dir: string) => `${machine}:${dir}`;
type Snap = { top: string; head: string; tree: string; itree: string; snap: string; roots: string[] };
// What a folder holds: its files and what is staged.
const stateOf = (s: { tree: string; itree: string }) => `${s.tree}:${s.itree}`;

export class MoveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const STEP_SAYS: Record<StepName, string> = { interrupt: "its turn was being stopped", snapshot: "its folder was being snapshotted", transfer: "its git state was being sent", worktree: "its files were being put in place", switch: "it was being switched" };

export class Handoffs {
  // The moves this process runs. One set for the process: a hot reload builds a
  // new Handoffs while a move of the old one may still run.
  private moving = ((globalThis as { __keelMoving?: Map<string, Promise<void>> }).__keelMoving ??= new Map<string, Promise<void>>());

  // The moves that run now, ended. A stop of the daemon waits for them within
  // its drain time: a move a restart does not cut needs no second try.
  idle(): Promise<void> {
    return Promise.all([...this.moving.values()]).then(() => {});
  }

  constructor(private store: Store, private bus: Bus, private engine: Engine, private fleet: Fleet) {
    store.migrate("CREATE TABLE IF NOT EXISTS fleet_moves (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.reconcile();
  }

  // What the last daemon left: a move still marked running was cut (no move
  // runs in a process that just started), and one whose switch is stored may
  // still owe its queue. Safe to run again: a closed move is not found again.
  private reconcile() {
    const rows = this.store.db.query<{ session_id: string }, []>("SELECT session_id FROM fleet_moves WHERE json_extract(data, '$.last.state') = 'running' OR json_extract(data, '$.last.settle') = 1").all();
    for (const { session_id: id } of rows) {
      if (this.moving.has(id)) continue;
      const m = this.moves(id);
      if (m.last?.state === "running") this.closeCut(id, m, m.last);
      // After the start has closed the turns the last daemon left open.
      if (m.last?.settle) setTimeout(() => this.settle(id), 0);
    }
  }

  // A move the daemon went down in the middle of. The switch is one write, so
  // the session is where it was; a row an older build wrote in two (the
  // machine, then the folder) is read as it stands: both new is a finished
  // move, the machine alone is put back.
  private closeCut(id: string, m: Moves, h: Handoff) {
    const s = this.store.session(id);
    rmSync(join(this.store.stateDir, "handoff", `${id}.bundle`), { force: true }); // what a cut transfer left here
    const at = h.steps.find((st) => st.state === "running") ?? h.steps.find((st) => st.state === "pending");
    const to = h.to.machine_id === "local" ? null : h.to.machine_id;
    h.ended_ms = Date.now();
    if (s && (s.machine ?? null) === to && s.workspace !== h.from.cwd) {
      for (const st of h.steps) if (st.state === "pending" || st.state === "running") st.state = "done";
      h.state = "done";
      h.to.cwd = s.workspace;
      h.away = Object.keys(m.away).length ? m.away : undefined;
      h.summary = `Moved from ${h.from.machine} to ${h.to.machine}: now in ${s.workspace}. The daemon restarted as the move ended.`;
      if (!h.held) h.settle = true;
    } else {
      for (const st of h.steps) {
        if (st.state === "running") { st.state = "failed"; st.detail = "cut by a daemon restart"; }
        else if (st.state === "pending") st.state = "skipped";
      }
      h.state = "failed";
      h.interrupted = true;
      const kept: string[] = [];
      const done = (n: StepName) => h.steps.find((st) => st.name === n)?.state === "done";
      if (h.carry === "git" && done("snapshot")) kept.push(`Its state at that time is kept in refs/keel/handoff/${id}.`);
      const wt = to ? m.making?.[to]?.dir ?? m.away[to] : undefined;
      if (wt && at?.name !== "interrupt" && at?.name !== "snapshot") kept.push(`The worktree for it on ${h.to.machine} is ${wt}; the next move there uses it.`);
      if (h.before_ref) kept.push(`What ${m.home ?? "the folder here"} held before the move is saved in ${h.before_ref}.`);
      h.error = `The daemon restarted while ${at ? STEP_SAYS[at.name] : "the move ran"}. The session stays on ${h.from.machine}. Move it again to finish.`;
      if (kept.length) h.details = kept;
    }
    const note = this.store.atomic(id, () => {
      if (s && h.state === "failed" && (s.machine ?? null) !== (h.from.machine_id === "local" ? null : h.from.machine_id)) {
        this.store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(h.from.machine_id === "local" ? null : h.from.machine_id, id);
      }
      this.saveMoves(id, { ...m, last: h });
      return s ? this.store.append(id, "note", { kind: "handoff", text: h.state === "done" ? h.summary! : `The move to ${h.to.machine} was cut. ${[h.error, ...(h.details ?? [])].join(" ")}` }) : undefined;
    });
    if (note) this.bus.emit({ t: "event", event: note });
    this.bus.emit({ t: "feature", name: "handoff_progress", session_id: id, data: h });
  }

  // The last thing a finished move does: the queue it stopped goes on. Its own
  // step, marked on the receipt, so a daemon that went down after the switch
  // was stored still does it. Never for a queue the owner held before the
  // move: that one waits for the owner as it did.
  private settle(id: string) {
    const m = this.moves(id);
    if (!m.last?.settle) return;
    // No turn starts while the daemon stops: the mark stays, and the next start does it.
    if ((this.engine as { isDraining?: () => boolean }).isDraining?.()) return;
    try {
      if (this.store.session(id)) this.engine.resumeQueue(id);
    } catch {
      // A prompt queued on another branch: the queue stays held until the owner says where it goes.
    }
    delete m.last.settle;
    this.saveMoves(id, m);
  }

  isMoving = (id: string) => this.moving.has(id);

  private moves(id: string): Moves {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM fleet_moves WHERE session_id = ?").get(id);
    return r ? JSON.parse(r.data) : { away: {}, left: {} };
  }
  private saveMoves(id: string, m: Moves) {
    this.store.db.query("INSERT OR REPLACE INTO fleet_moves (session_id, data) VALUES (?, ?)").run(id, JSON.stringify(m));
  }
  latest(id: string): Handoff | null {
    return this.moves(id).last ?? null;
  }

  // ---- one shell script at a place: this machine, or a machine's hands

  private async sh(machine: MachineRow | null, cwd: string, script: string): Promise<{ code: number; out: string }> {
    if (!machine) {
      const p = Bun.spawn(["bash", "-c", script], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
      return { code, out: out + err };
    }
    const r = await this.fleet.hands(machine.id, "/api/fleet/hands/exec", { method: "POST", body: JSON.stringify({ script, cwd, root: machine.workspace_root }), timeout: 11 * 60_000 });
    const b = (await r.json()) as { code: number; out: string; error?: string };
    return { code: b.code ?? 1, out: b.out ?? b.error ?? "" };
  }

  private async must(machine: MachineRow | null, cwd: string, script: string, what: string): Promise<string> {
    const r = await this.sh(machine, cwd, `set -e\n${script}`);
    if (r.code !== 0) throw new Error(`${what}: ${r.out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    return r.out;
  }

  // The directory's state as two trees, and a snapshot commit of them on top of
  // HEAD when either differs from it: `tree` is every file (tracked and
  // untracked), `itree` is what is staged. The commit holds the files; when
  // something is staged its second parent is a commit of the index. Built in a
  // copy of the index: nothing in the directory is touched.
  // The commits carry HEAD's date, not the time: an unchanged folder gives the
  // same commit again, so a move made again finds what it already sent.
  // `prune`: the refs under this prefix beyond the newest few are removed.
  private async snapshot(machine: MachineRow | null, dir: string, ref: string, prune?: string): Promise<Snap> {
    const out = await this.must(machine, dir, `
top=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
when=$(git show -s --format=%cI HEAD)
export GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when"
htree=$(git rev-parse 'HEAD^{tree}')
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
real=$(git rev-parse --git-path index)
if [ -f "$real" ]; then cp "$real" "$idx"; else GIT_INDEX_FILE="$idx" ${GIT} read-tree HEAD; fi
# An index with unmerged paths has no tree: HEAD's stands in for what is staged.
itree=$(GIT_INDEX_FILE="$idx" ${GIT} write-tree 2>/dev/null) || itree=$htree
GIT_INDEX_FILE="$idx" ${GIT} add -A
tree=$(GIT_INDEX_FILE="$idx" ${GIT} write-tree)
if [ "$tree" = "$htree" ] && [ "$itree" = "$htree" ]; then snap=$head; else
  staged=""
  if [ "$itree" != "$htree" ]; then staged="-p $(${GIT} commit-tree "$itree" -p "$head" -m "keel: handoff index")"; fi
  snap=$(${GIT} commit-tree "$tree" -p "$head" $staged -m "keel: handoff snapshot")
fi
${GIT} update-ref ${q(ref)} "$snap"
${prune ? `git for-each-ref --sort=-refname --format='%(refname)' ${q(prune)} | tail -n +${BEFORE_KEPT + 1} | xargs -r -n 1 ${GIT} update-ref -d` : ""}
echo "top=$top"; echo "head=$head"; echo "tree=$tree"; echo "itree=$itree"; echo "snap=$snap"
roots=$(git rev-list --max-parents=0 HEAD | tr '\\n' ' '); echo "roots=$roots"`, "snapshot");
    const v = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    return { top: v("top"), head: v("head"), tree: v("tree"), itree: v("itree"), snap: v("snap"), roots: v("roots").split(" ").filter(Boolean) };
  }

  // Put a snapshot into an existing directory: its own state saved to a ref of
  // its own first; replaced only when it is as the session left it (its files
  // and its index both) and its HEAD is an ancestor of the snapshot. Otherwise
  // its files and its index stay. Replacing goes from the tree the directory is
  // (untracked files too) to the snapshot's, so a file removed over there is
  // removed here, then the index is set to what was staged. Git refuses the
  // step whole when a file changed under it: the index is put back as it was.
  // `mine`: the states that count as the session's own (as it left the folder,
  // or as a cut move put it there). `applying` runs right before the folder changes.
  private async land(machine: MachineRow | null, dir: string, beforeRef: string, snap: Snap, mine: (string | undefined)[], applying: () => void) {
    const now = await this.snapshot(machine, dir, beforeRef, beforeRef.slice(0, beforeRef.lastIndexOf("/") + 1));
    // A move cut after this step put it here already: nothing to do.
    if (now.head === snap.head && stateOf(now) === stateOf(snap)) return { replaced: true };
    // A place an older build left has only its files' tree on record.
    const asLeft = mine.some((was) => was !== undefined && (was === stateOf(now) || was === now.tree));
    const anc = (await this.sh(machine, dir, `git merge-base --is-ancestor ${now.head} ${snap.snap}`)).code === 0;
    if (!asLeft || !anc) return { replaced: false, why: !asLeft ? "it changed since the session left it" : "its commit is not an ancestor of the carried state" };
    applying();
    await this.must(machine, dir, `real=$(git rev-parse --git-path index)
bak=$(mktemp)
cp "$real" "$bak"
${GIT} read-tree ${now.tree}
${GIT} update-index -q --refresh >/dev/null || true
if ! ${GIT} read-tree -u -m ${now.tree} ${snap.tree}; then cp "$bak" "$real"; rm -f "$bak"; exit 1; fi
rm -f "$bak"
${GIT} read-tree ${snap.itree}
${GIT} reset -q --soft ${snap.head}
${GIT} update-index -q --refresh >/dev/null || true`, "apply");
    return { replaced: true };
  }

  // Lands the snapshot in a folder that exists. Where the folder's own state
  // goes is on the receipt before anything is written there.
  private async landIn(h: Handoff, moves: Moves, machine: MachineRow | null, dir: string, snap: Snap, ref: string) {
    const place = key(machine?.id ?? "local", dir);
    h.before_ref = `refs/keel/handoff-before/${h.session_id}/${Date.now()}`;
    this.saveMoves(h.session_id, { ...moves, last: h });
    const r = await this.land(machine, dir, h.before_ref, snap, [moves.left[place], moves.landing?.[place]], () => {
      moves.landing = { ...moves.landing, [place]: stateOf(snap) };
      this.saveMoves(h.session_id, { ...moves, last: h });
    });
    h.replaced = r.replaced;
    if (r.replaced) {
      moves.left[place] = stateOf(snap);
      if (moves.landing) delete moves.landing[place];
    } else h.summary = `${machine ? "The worktree there" : dir} was kept as it was (${r.why}); the carried state is in ${ref}.`;
    this.saveMoves(h.session_id, { ...moves, last: h });
  }

  private async put(machine: MachineRow, path: string, data: Uint8Array) {
    const r = await this.fleet.hands(machine.id, `/api/fleet/hands/put?path=${encodeURIComponent(path)}&root=${encodeURIComponent(machine.workspace_root!)}`, { method: "POST", body: data as unknown as BodyInit, headers: { "content-type": "application/octet-stream" }, timeout: 10 * 60_000 });
    if (!r.ok) throw new Error(`sending the bundle: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  private async get(machine: MachineRow, path: string): Promise<Uint8Array> {
    const r = await this.fleet.hands(machine.id, `/api/fleet/hands/get?path=${encodeURIComponent(path)}&root=${encodeURIComponent(machine.workspace_root!)}`, { timeout: 10 * 60_000 });
    if (!r.ok) throw new Error(`fetching the bundle: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // ---- the move

  start(s: Session, b: { machine_id?: string; carry?: string; workspace?: string }): Handoff {
    const to = b.machine_id ?? "";
    const carry = (b.carry ?? "git") as Handoff["carry"];
    if (!["git", "none"].includes(carry)) throw new MoveError(400, "carry is git or none");
    if (s.archived) throw new MoveError(409, "the session is archived");
    if (s.parent_id) throw new MoveError(409, "a subagent moves with its parent");
    if (this.moving.has(s.id)) throw new MoveError(409, "the session is being moved");
    const fromId = s.machine ?? "local";
    const dest = to === "local" ? null : this.fleet.row(to) ?? null;
    if (to !== "local" && !dest) throw new MoveError(400, "no such machine");
    if (dest && !dest.workspace_root) throw new MoveError(400, `${dest.name} has no granted directory: Keel cannot run tools there`);
    if (to === fromId) throw new MoveError(409, "the session is already there");
    if (fromId !== "local" && to !== "local") throw new MoveError(409, "a session on another machine comes back here before it goes to a third");
    const src = fromId === "local" ? null : this.fleet.row(fromId) ?? null;
    if (fromId !== "local" && !src) throw new MoveError(409, "the machine the session is on was removed");

    const h: Handoff = {
      session_id: s.id, state: "running", carry,
      from: { machine_id: fromId, machine: src?.name ?? this.fleet.name, cwd: s.workspace },
      to: { machine_id: to, machine: dest?.name ?? this.fleet.name },
      steps: (["interrupt", "snapshot", "transfer", "worktree", "switch"] as StepName[]).map((name) => ({ name, state: "pending" })),
      started_ms: Date.now(),
      ...(this.engine.isHeld(s.id) ? { held: true } : {}),
    };
    this.record(h);
    const run = this.run(s, h, src, dest, b.workspace).finally(() => this.moving.delete(s.id));
    this.moving.set(s.id, run.catch(() => {}));
    return h;
  }

  private record(h: Handoff) {
    const m = this.moves(h.session_id);
    m.last = h;
    this.saveMoves(h.session_id, m);
    this.bus.emit({ t: "feature", name: "handoff_progress", session_id: h.session_id, data: h });
  }

  private async run(s: Session, h: Handoff, src: MachineRow | null, dest: MachineRow | null, workspace?: string) {
    const step = async <T>(name: StepName, f: () => Promise<T | "skip">): Promise<T | undefined> => {
      const st = h.steps.find((x) => x.name === name)!;
      st.state = "running";
      this.record(h);
      try {
        const r = await f();
        st.state = r === "skip" ? "skipped" : "done";
        this.record(h);
        return r === "skip" ? undefined : r;
      } catch (e) {
        st.state = "failed";
        st.detail = (e as Error).message;
        throw e;
      }
    };
    const moves = this.moves(s.id);
    const sid = s.id;
    const ref = `refs/keel/handoff/${sid}`;
    let switched = false;
    try {
      await step("interrupt", async () => (this.engine.isRunning(sid) ? void (await this.engine.interrupt(sid)) : "skip"));
      let target = "";
      if (h.carry === "none") {
        for (const n of ["snapshot", "transfer"] as StepName[]) await step(n, async () => "skip");
        target = await step("worktree", async () => (dest ? workspace ?? dest.workspace_root! : workspace ?? moves.home ?? s.workspace)) ?? "";
      } else {
        const snap = await step("snapshot", () => this.snapshot(src, s.workspace, ref));
        if (!snap) throw new Error("no snapshot");
        moves.left[key(h.from.machine_id, snap.top)] = stateOf(snap);
        if (h.from.machine_id === "local" && !moves.home) moves.home = snap.top;
        this.saveMoves(sid, { ...moves, last: h });
        h.home = moves.home;
        const name = basename(snap.top);
        if (dest) {
          // There: the repository named, else the same repository by name or at the root, else a new one.
          const root = dest.workspace_root!;
          let repo = workspace ?? "";
          await step("transfer", async () => {
            if (!repo) {
              const probe = await this.sh(dest, root, `for d in ${q(join(root, name))} ${q(root)}; do if [ "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" = "$d" ]; then echo "cand $d $(git -C "$d" rev-list --max-parents=0 --all 2>/dev/null | tr '\\n' ' ')"; fi; done; true`);
              for (const line of probe.out.split("\n")) {
                const m = line.match(/^cand (\S+) (.*)$/);
                if (m && m[2]!.split(" ").some((r) => snap.roots.includes(r))) { repo = m[1]!; break; }
                // One with no commit at the place a new one goes: a move cut after it made it, or an empty one. Either takes the state.
                if (m && m[1] === join(root, name) && !m[2]!.trim()) { repo = m[1]!; break; }
                if (m && m[1] === join(root, name)) throw new Error(`${join(root, name)} on ${dest.name} is another repository: name one with workspace`);
              }
              if (!repo) { repo = join(root, name); await this.must(dest, root, `mkdir -p ${q(repo)}\ngit -C ${q(repo)} init -q`, "a new repository there"); }
            }
            // Nothing to send when the commit is there already (an earlier move, a fetch of its
            // own). The ref still moves to it: the receipt names the ref as where the carried state is.
            const has = await this.sh(dest, root, `git -C ${q(repo)} cat-file -e ${snap.snap}^{commit} && ${GIT} -C ${q(repo)} update-ref ${q(ref)} ${snap.snap}`);
            if (has.code === 0) return "skip";
            const theirs = (await this.sh(dest, root, `git -C ${q(repo)} for-each-ref --format='%(objectname)' --count=50 refs/heads refs/keel/handoff 2>/dev/null; true`)).out.split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{40}$/.test(x));
            const known = theirs.length ? (await this.sh(src, s.workspace, theirs.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim())) : [];
            const local = join(this.store.stateDir, "handoff");
            mkdirSync(local, { recursive: true });
            const file = join(local, `${sid}.bundle`);
            if (src) throw new Error("a move between two other machines is not supported");
            await this.must(null, s.workspace, `git bundle create -q ${q(file)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle");
            const remoteFile = join(root, ".keel", "handoff", `${sid}.bundle`);
            try { await this.put(dest, remoteFile, readFileSync(file)); } finally { rmSync(file, { force: true }); }
            // The bundle there goes whether the fetch took it or not.
            await this.must(dest, root, `trap 'rm -f ${q(remoteFile)}' EXIT\ngit -C ${q(repo)} fetch ${q(remoteFile)} ${q(`+${ref}:${ref}`)}`, "unbundle there");
          });
          target = (await step("worktree", async () => {
            const wt = moves.away[dest.id];
            if (wt && (await this.sh(dest, root, `test -d ${q(wt)}`)).code === 0) {
              await this.landIn(h, moves, dest, wt, snap, ref);
              return wt;
            }
            // A new worktree. Its name is stored before it is made: a move cut
            // between the two makes this one again (the session never ran in
            // it, so what is there is only what the cut move put) and no other.
            const stamp = Date.now().toString(36);
            const cut = moves.making?.[dest.id];
            const made = cut ?? { dir: join(root, ".keel", "worktrees", `handoff-${sid.slice(-12)}-${stamp}`), branch: `keel/handoff-${sid.slice(-12)}-${stamp}` };
            moves.making = { ...moves.making, [dest.id]: made };
            this.saveMoves(sid, { ...moves, last: h });
            await this.must(dest, root, `${cut ? `rm -rf ${q(made.dir)}\n${GIT} -C ${q(repo)} worktree prune\n` : ""}${GIT} -C ${q(repo)} worktree add -q -B ${q(made.branch)} ${q(made.dir)} ${snap.snap}\n${snap.snap !== snap.head ? `cd ${q(made.dir)}\n${GIT} read-tree ${snap.itree}\n${GIT} reset -q --soft ${snap.head}\n${GIT} update-index -q --refresh >/dev/null || true` : "true"}`, "worktree there");
            moves.away[dest.id] = made.dir;
            moves.left[key(dest.id, made.dir)] = stateOf(snap);
            delete moves.making[dest.id];
            this.saveMoves(sid, { ...moves, last: h });
            return made.dir;
          })) ?? "";
        } else {
          // Back here, into the directory the session first left (or the one named).
          const home = workspace ?? moves.home ?? s.workspace;
          await step("transfer", async () => {
            const has = await this.sh(null, home, `git cat-file -e ${snap.snap}^{commit} && ${GIT} update-ref ${q(ref)} ${snap.snap}`);
            if (has.code === 0) return "skip";
            const root = src!.workspace_root!;
            const remoteFile = join(root, ".keel", "handoff", `${sid}.bundle`);
            const heads = (await this.sh(null, home, `git for-each-ref --format='%(objectname)' --count=50 refs/heads refs/keel/handoff; true`)).out.split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{40}$/.test(x));
            const known = (await this.sh(src, s.workspace, heads.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim()));
            await this.must(src, s.workspace, `mkdir -p ${q(join(root, ".keel", "handoff"))}\ngit bundle create -q ${q(remoteFile)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle there");
            const local = join(this.store.stateDir, "handoff");
            mkdirSync(local, { recursive: true });
            const file = join(local, `${sid}.bundle`);
            try {
              writeFileSync(file, await this.get(src!, remoteFile));
              await this.must(null, home, `git fetch ${q(file)} ${q(`+${ref}:${ref}`)}`, "unbundle here");
            } finally {
              rmSync(file, { force: true });
              await this.sh(src, root, `rm -f ${q(remoteFile)}`).catch(() => {});
            }
          });
          target = (await step("worktree", async () => {
            await this.landIn(h, moves, null, home, snap, ref);
            return home;
          })) ?? "";
        }
      }
      // The switch: the machine, the folder, the note and the finished receipt
      // are one write. A daemon killed before it finds the session where it
      // was; one killed after it finds the move done.
      const sw = h.steps.find((x) => x.name === "switch")!;
      sw.state = "running";
      this.record(h);
      const carried = h.carry === "git" ? "with its git state" : "without its files";
      const summary = h.summary ?? `Moved from ${h.from.machine} to ${h.to.machine} ${carried}: now in ${target}.`;
      const note = this.store.atomic(sid, () => {
        if (!this.store.session(sid)) throw new Error("the session was deleted while it moved");
        this.store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(dest ? dest.id : null, sid);
        this.store.updateSession(sid, { workspace: target });
        const done: Handoff = { ...h, steps: h.steps.map((x) => (x === sw ? { ...x, state: "done" } : x)), to: { ...h.to, cwd: target }, away: Object.keys(moves.away).length ? moves.away : undefined, state: "done", ended_ms: Date.now(), summary, ...(h.held ? {} : { settle: true }) };
        this.saveMoves(sid, { ...moves, last: done });
        return this.store.append(sid, "note", { kind: "handoff", text: summary });
      });
      switched = true;
      this.engine.forgetSystem(sid);
      this.bus.emit({ t: "session", session: this.store.session(sid)! });
      this.bus.emit({ t: "event", event: note });
      this.settle(sid);
      this.bus.emit({ t: "feature", name: "handoff_progress", session_id: sid, data: this.moves(sid).last });
    } catch (e) {
      if (switched) throw e; // the move is stored as done: nothing after it makes it a failed one
      h.state = "failed";
      h.error = e instanceof LinkError ? `${h.to.machine} does not answer: ${(e as Error).message}` : (e as Error).message;
      h.ended_ms = Date.now();
      for (const st of h.steps) if (st.state === "pending" || st.state === "running") st.state = st.state === "running" ? "failed" : "skipped";
      // Deleted while it moved: what the move made for it goes with it.
      if (!this.store.session(sid)) {
        this.saveMoves(sid, { ...moves, last: h });
        return void (await this.cleanup(sid).catch(() => {}));
      }
      this.note(sid, `The move to ${h.to.machine} failed; the session stays on ${h.from.machine}. ${h.error}`);
      this.record(h);
    }
  }

  private note(id: string, text: string) {
    if (!this.store.session(id)) return; // deleted while it moved: nothing to tell
    const e = this.store.append(id, "note", { kind: "handoff", text });
    this.bus.emit({ t: "event", event: e });
  }

  // When the session is deleted: its refs here; the worktree, its branch and refs there.
  async cleanup(id: string) {
    const m = this.moves(id);
    const ref = `refs/keel/handoff/${id}`;
    if (m.home) await this.sh(null, m.home, `git update-ref -d ${q(ref)}; git for-each-ref --format='%(refname)' ${q(`refs/keel/handoff-before/${id}/`)} | while read r; do git update-ref -d "$r"; done; true`).catch(() => {});
    rmSync(join(this.store.stateDir, "handoff", `${id}.bundle`), { force: true });
    const before = `refs/keel/handoff-before/${id}/`;
    const there = [...Object.entries(m.away), ...Object.entries(m.making ?? {}).map(([mid, w]) => [mid, w.dir] as [string, string])];
    for (const [mid, wt] of there) {
      const mr = this.fleet.row(mid);
      if (!mr?.workspace_root) continue;
      await this.sh(mr, mr.workspace_root, `if [ -d ${q(wt)} ]; then b=$(git -C ${q(wt)} rev-parse --abbrev-ref HEAD); c=$(git -C ${q(wt)} rev-parse --git-common-dir); repo=$(cd ${q(wt)} && cd "$c/.." && pwd); git -C "$repo" worktree remove --force ${q(wt)}; git -C "$repo" branch -D "$b" >/dev/null 2>&1; git -C "$repo" update-ref -d ${q(ref)}; git -C "$repo" for-each-ref --format='%(refname)' ${q(before)} | xargs -r -n 1 git -C "$repo" update-ref -d; fi; true`).catch(() => {});
    }
    // A bundle a cut move left on a machine it went to or came from.
    for (const mid of new Set([...there.map(([mid]) => mid), m.last?.to.machine_id, m.last?.from.machine_id])) {
      const mr = mid && mid !== "local" ? this.fleet.row(mid) : undefined;
      if (mr?.workspace_root) await this.sh(mr, mr.workspace_root, `rm -f ${q(join(mr.workspace_root, ".keel", "handoff", `${id}.bundle`))}`).catch(() => {});
    }
    this.store.db.query("DELETE FROM fleet_moves WHERE session_id = ?").run(id);
  }
}
