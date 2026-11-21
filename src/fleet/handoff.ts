// Moving a session: the place its tools run changes, with its git state. The
// conversation stays with this daemon. `carry: "git"` makes the directory's
// state one snapshot commit (HEAD, or a commit on top holding every
// uncommitted change, built through a throwaway index so the directory it
// leaves is not touched), sends what the destination lacks as a git bundle,
// and puts it in a worktree there with the rest uncommitted again. What was
// staged travels apart from the files, as git stash keeps it: the snapshot's
// second parent is a commit of the index, and the index there is set from it,
// so staged, unstaged and untracked changes arrive as they were. What a tree
// cannot hold does not travel, and the receipt says so when it applies: files
// git ignores, the contents of submodules and nested repositories, a rebase
// in progress, and a sparse checkout's cone (the copy holds every file). A
// merge in progress is not carried either (its unmerged entries and its
// second parent are outside any tree): the move is refused before anything
// changes, and the owner finishes or aborts the merge first. Coming
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
import { GIT_SHELL_ENV, GIT_SHELL_FETCH, gitEnv, gitReach, type GitFetch } from "../core/git.ts";
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
  // Without it, a hold found after the move is the move's own (it stopped the
  // running turn) and is let go when the move ends, however it ends.
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
// `prefix`: the session's folder inside the repository ("" at its top). `ita`: the paths only marked to be added,
// NUL-separated in base64. `busy`: what is unfinished there (a merge, files with unresolved conflicts), in words.
// `lost`: the kinds of thing that do not travel.
type Snap = { top: string; head: string; tree: string; itree: string; snap: string; roots: string[]; prefix: string; ita: string; busy: string; lost: string[] };
const LOST: Record<string, string> = {
  ignored: "files git ignores", nested: "the contents of submodules and nested repositories (their folders arrive empty)",
  op: "the rebase, cherry-pick or revert in progress (it stays in the folder it was started in)", sparse: "the sparse checkout (the copy holds every file)",
  bits: "the edits that skip-worktree and assume-unchanged marks hide (the copy has those files as git has them)",
};
// What stops a move before anything changes, each in the owner's words. Unfinished
// work whose state is in no tree (a merge's second parent, the stages of a
// conflict) would be lost on the way, so the move waits for the owner.
const CHECKS = `export LC_ALL=C
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "refuse=This folder is not a git repository, so there is no git state to carry. Move the session as place only."; exit 0; }
git rev-parse -q --verify HEAD >/dev/null || { echo "refuse=The repository in $top has no commit yet, so there is nothing to carry the changes on. Commit once, or move the session as place only."; exit 0; }
gp() { git rev-parse --git-path "$1"; }
busy=""; stop=""
if [ -e "$(gp MERGE_HEAD)" ]; then
  busy="a merge is in progress"; stop="A merge is in progress in $top. Finish or abort it there, then move the session: the state of a merge does not travel, and moving now would lose it."
elif [ -n "$(git ls-files -u | head -n 1)" ]; then
  if [ -e "$(gp CHERRY_PICK_HEAD)" ]; then busy="a cherry-pick stopped on a conflict"; what="A cherry-pick stopped on a conflict in $top. Resolve it and continue, or abort it there"
  elif [ -e "$(gp REVERT_HEAD)" ]; then busy="a revert stopped on a conflict"; what="A revert stopped on a conflict in $top. Resolve it and continue, or abort it there"
  elif [ -d "$(gp rebase-merge)" ] || [ -d "$(gp rebase-apply)" ]; then busy="a rebase stopped on a conflict"; what="A rebase stopped on a conflict in $top. Resolve it and continue, or abort it there"
  else busy="it has files with unresolved conflicts"; what="$top has files with unresolved conflicts (as a stash pop leaves them). Resolve them there"; fi
  stop="$what, then move the session: unresolved conflicts do not travel, and moving now would lose them."
fi
sparse=""
if [ "$(git config --bool core.sparseCheckout)" = true ]; then sparse="--sparse"; fi
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
real=$(gp index)
if [ -f "$real" ]; then cp "$real" "$idx"; else GIT_INDEX_FILE="$idx" git read-tree HEAD; fi
# Every file, also one outside a sparse checkout's cone that is on the disk. A git too old for that takes what it sees.
# The repositories inside this one (a submodule that is checked out, a folder with a .git of its own) are left
# out of the add: git would run git inside each, which reads that repository's own config (src/core/git.ts).
# Each is recorded as git records it, a gitlink at the commit it has out.
excl=(); inner=()
while IFS= read -r -d '' e; do case "$e" in "160000 "*) p=\${e#*$'\\t'}; if [ -e "$top/$p/.git" ]; then excl+=(":(top,exclude,literal)$p"); inner+=("$p"); fi;; esac; done < <(GIT_INDEX_FILE="$idx" git -C "$top" ls-files -s -z)
while IFS= read -r -d '' p; do case "$p" in */) excl+=(":(top,exclude,literal)\${p%/}"); inner+=("\${p%/}");; esac; done < <(git -C "$top" ls-files -o --exclude-standard -z)
# (The commit an inner repository has out, as git's own add reads it: the name its HEAD holds, whether or not the object is there.)
inside() { env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "$top/$1" rev-parse -q --verify HEAD 2>/dev/null; }
links() { for p in "\${inner[@]}"; do h=$(inside "$p") && GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "160000,$h,$p" || true; done; }
# (One with no commit yet cannot be recorded: git's own add refuses the folder for it, in these words.)
snapadd() {
  want=40; if [ "$(git rev-parse --show-object-format 2>/dev/null)" = sha256 ]; then want=64; fi
  for p in "\${inner[@]}"; do
    h=$(inside "$p") || { echo "error: '$p/' does not have a commit checked out"; return 1; }
    [ "\${#h}" = "$want" ] || { echo "error: cannot add a submodule of a different hash algorithm"; return 1; }
  done
  GIT_INDEX_FILE="$idx" ${GIT} add -A $sparse "$@" -- :/ "\${excl[@]}" 2>&1 || { [ -n "$sparse" ] && GIT_INDEX_FILE="$idx" ${GIT} add -A "$@" -- :/ "\${excl[@]}" 2>&1; } || return 1
  [ "$1" = -n ] || links
}
unreadable() { echo "refuse=Git cannot take the files in $top as they are: $(printf '%s\\n' "$1" | { grep -m 1 '^error:' || printf '%s\\n' "$1" | tail -n 1; } | sed 's/^error: //'). Fix that there, or move the session as place only."; exit 0; }`;
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
    }
    // After the start has closed the turns the last daemon left open.
    if (this.owed().length) setTimeout(() => this.settleOwed(), 0);
  }

  private owed(): string[] {
    return this.store.db.query<{ session_id: string }, []>("SELECT session_id FROM fleet_moves WHERE json_extract(data, '$.last.settle') = 1").all().map((r) => r.session_id);
  }

  // The queues that moves still owe a release: at a start, and when a drain
  // that held them back is called off.
  settleOwed() {
    for (const id of this.owed()) if (!this.moving.has(id)) this.settle(id);
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
      // The cut move had stopped the turn: that hold is not the owner's, and goes.
      if (!h.held && ["running", "done"].includes(h.steps.find((st) => st.name === "interrupt")!.state)) h.settle = true;
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

  // The last thing a move does, finished, failed or cut: the queue it stopped
  // goes on. Its own step, marked on the receipt, so a daemon that went down
  // after the switch was stored still does it. Never for a queue the owner
  // held before the move: that one waits for the owner as it did.
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

  // `view`: the script works in the repository `cwd` is in, and puts files
  // into an index or a folder (an add, a write-tree, a checkout): its git
  // reads that repository through the daemon's view of it, here and on the
  // other machine, so no filter the repository's own config names runs
  // (src/core/git.ts). The other scripts name their repository with -C and
  // only move refs and objects; they get the keys below.
  // `fetch`: the script fills a work tree, and may fetch what a partial clone lacks as far as that (GitOpts.fetch).
  private async sh(machine: MachineRow | null, cwd: string, script: string, view = false, fetch?: GitFetch): Promise<{ code: number; out: string }> {
    // Every git in the script, here or on the other machine, with what a
    // repository's config must not turn on. (After the view's environment:
    // these keep the file transport, which a bundle is fetched over.)
    script = `${GIT_SHELL_ENV}\n${script}`;
    if (!machine) {
      const p = Bun.spawn(["bash", "-c", script], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...(view ? gitEnv(cwd, fetch) : {}), GIT_TERMINAL_PROMPT: "0" } });
      const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
      return { code, out: out + err };
    }
    const r = await this.fleet.hands(machine.id, "/api/fleet/hands/exec", { method: "POST", body: JSON.stringify({ script, cwd, root: machine.workspace_root, ...(view ? { view: true } : {}), ...(view && fetch ? { fetch } : {}) }), timeout: 11 * 60_000 });
    const b = (await r.json()) as { code: number; out: string; error?: string };
    return { code: b.code ?? 1, out: b.out ?? b.error ?? "" };
  }

  private async must(machine: MachineRow | null, cwd: string, script: string, what: string, view = false, fetch?: GitFetch): Promise<string> {
    const r = await this.sh(machine, cwd, `set -e\n${script}`, view, fetch);
    if (r.code !== 0) throw new Error(`${what}: ${r.out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    return r.out;
  }

  // Asked before the running turn is stopped, so a move that cannot go leaves
  // the turn alone: whether a move out of this folder would be refused, and
  // the folder to read it from. A session's folder that is gone (the work
  // there removed or renamed it) is read from the nearest one above it that
  // still stands.
  private async preflight(machine: MachineRow | null, dir: string): Promise<{ dir: string; refuse?: string }> {
    // (Two scripts: the second runs in the folder the first found, so its git reads that folder's repository through its view.)
    const found = await this.sh(machine, machine ? machine.workspace_root! : "/", `d=${q(dir)}
while [ ! -d "$d" ] && [ "$d" != / ] && [ "$d" != . ]; do d=$(dirname "$d"); done
cd "$d" || exit 1
echo "dir=$d"`);
    const at = found.out.match(/^dir=(.*)$/m)?.[1]?.trim();
    if (found.code !== 0 || !at) return { dir };
    const r = await this.sh(machine, at, `${CHECKS}
if [ -n "$stop" ]; then echo "refuse=$stop"; exit 0; fi
err=$(snapadd -n) || unreadable "$err"`, true);
    return { dir: at, refuse: r.out.match(/^refuse=(.*)$/m)?.[1]?.trim() };
  }

  // The directory's state as two trees, and a snapshot commit of them on top of
  // HEAD when either differs from it: `tree` is every file (tracked and
  // untracked), `itree` is what is staged. The commit holds the files; when
  // something is staged its second parent is a commit of the index. Built in a
  // copy of the index: nothing in the directory is touched.
  // The commits carry HEAD's date, not the time: an unchanged folder gives the
  // same commit again, so a move made again finds what it already sent.
  // `prune`: the refs under this prefix beyond the newest few are removed.
  // `leaving`: the folder the session leaves. Unfinished work there stops the
  // move here, before a ref is written, and what will not travel is looked for.
  private async snapshot(machine: MachineRow | null, dir: string, ref: string, o: { prune?: string; leaving?: boolean } = {}): Promise<Snap> {
    const out = await this.must(machine, dir, `${CHECKS}
${o.leaving ? `if [ -n "$stop" ]; then echo "refuse=$stop"; exit 0; fi` : ""}
head=$(git rev-parse HEAD)
when=$(git show -s --format=%cI HEAD)
export GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when"
htree=$(git rev-parse 'HEAD^{tree}')
# An index with unmerged paths has no tree: HEAD's stands in for what is staged.
itree=$(GIT_INDEX_FILE="$idx" ${GIT} write-tree 2>/dev/null) || itree=$htree
# Paths only marked to be added (git add -N) are in no tree: their names travel beside it.
ita=$(GIT_INDEX_FILE="$idx" git diff-files --ignore-submodules=dirty -z --name-only --diff-filter=A 2>/dev/null | base64 | tr -d '\\n')
err=$(snapadd) || unreadable "$err"
tree=$(GIT_INDEX_FILE="$idx" ${GIT} write-tree)
if [ "$tree" = "$htree" ] && [ "$itree" = "$htree" ]; then snap=$head; else
  staged=""
  if [ "$itree" != "$htree" ]; then staged="-p $(${GIT} commit-tree "$itree" -p "$head" -m "keel: handoff index")"; fi
  snap=$(${GIT} commit-tree "$tree" -p "$head" $staged -m "keel: handoff snapshot")
fi
${GIT} update-ref ${q(ref)} "$snap"
${o.prune ? `git for-each-ref --sort=-refname --format='%(refname)' ${q(o.prune)} | tail -n +${BEFORE_KEPT + 1} | xargs -r -n 1 ${GIT} update-ref -d` : ""}
lost=""
${o.leaving ? `if [ -n "$(git -C "$top" ls-files --others --ignored --exclude-standard --directory | head -n 1)" ]; then lost="$lost ignored"; fi
if [ -n "$(GIT_INDEX_FILE="$idx" git -C "$top" ls-files -s | grep -m 1 '^160000')" ]; then lost="$lost nested"; fi
for f in rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD; do if [ -e "$(gp $f)" ]; then lost="$lost op"; break; fi; done
if [ -n "$sparse" ]; then lost="$lost sparse"; elif [ -n "$(git ls-files -v | grep -m 1 '^[a-zS] ')" ]; then lost="$lost bits"; fi` : ""}
echo "top=$top"; echo "head=$head"; echo "tree=$tree"; echo "itree=$itree"; echo "snap=$snap"; echo "busy=$busy"; echo "ita=$ita"; echo "lost=$lost"
echo "prefix=$(git rev-parse --show-prefix)"
roots=$(git rev-list --max-parents=0 HEAD | tr '\\n' ' '); echo "roots=$roots"`, "snapshot", true);
    const v = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    // Said in the owner's words, with nothing changed: not a failed script.
    if (v("refuse")) throw new Error(v("refuse"));
    return { top: v("top"), head: v("head"), tree: v("tree"), itree: v("itree"), snap: v("snap"), roots: v("roots").split(" ").filter(Boolean), prefix: v("prefix").replace(/\/$/, ""), ita: v("ita"), busy: v("busy"), lost: v("lost").split(" ").filter(Boolean) };
  }

  // The index of a folder set to what was staged, after its files are in
  // place: the paths only marked to be added are marked again.
  private staged(snap: Snap): string {
    return `${GIT} read-tree ${snap.itree}${snap.ita ? `\necho ${snap.ita} | base64 -d | while IFS= read -r -d '' f; do ${GIT} add -N -- "$f" 2>/dev/null || true; done` : ""}`;
  }

  // Put a snapshot into an existing directory: its own state saved to a ref of
  // its own first; replaced only when it is as the session left it (its files
  // and its index both) and its HEAD is an ancestor of the snapshot. Otherwise
  // its files and its index stay, as they do when a merge is in progress there.
  // Replacing goes from the tree the directory is (untracked files too) to the
  // snapshot's, so a file removed over there is removed here, then the index
  // is set to what was staged. Git refuses the step whole when a file changed
  // under it. The index as it was is kept until the last line and put back on
  // any failure. HEAD moves only when it differs.
  //
  // What only this folder holds is looked at first and put back after:
  // - A file git does not see here (ignored through this folder's own exclude
  //   file, a global one, a rule the other side dropped) where the carried
  //   state has a file: git would write over it and nothing keeps it. The
  //   folder is kept as it was, and the path is named.
  // - A skip-worktree or assume-unchanged mark set by hand, on a file the
  //   carried state changes, with an edit under the mark: refused, in words.
  // - Every other such mark returns to its path, and so does a sparse
  //   checkout's: only on paths the carried state left alone. A file outside
  //   the cone that was worked on over there is written here, as it is there.
  // `mine`: the states that count as the session's own (as it left the folder,
  // or as a cut move put it there). `applying` runs right before the folder changes.
  private async land(machine: MachineRow | null, dir: string, beforeRef: string, snap: Snap, mine: (string | undefined)[], applying: () => void): Promise<{ replaced: boolean; why?: string }> {
    const now = await this.snapshot(machine, dir, beforeRef, { prune: beforeRef.slice(0, beforeRef.lastIndexOf("/") + 1) });
    if (now.busy) return { replaced: false, why: `${now.busy} there` };
    // A move cut after this step put it here already: nothing to do.
    if (now.head === snap.head && stateOf(now) === stateOf(snap)) return { replaced: true };
    // A place an older build left has only its files' tree on record.
    const asLeft = mine.some((was) => was !== undefined && (was === stateOf(now) || was === now.tree));
    const anc = (await this.sh(machine, dir, `git merge-base --is-ancestor ${now.head} ${snap.snap}`)).code === 0;
    if (!asLeft || !anc) return { replaced: false, why: !asLeft ? "it changed since the session left it" : "its commit is not an ancestor of the carried state" };
    applying();
    const changed = `{ git diff-tree -r -z --name-only ${now.tree} ${snap.tree}; git diff-tree -r -z --name-only ${snap.tree} ${snap.itree}; }`;
    const inIndex = `xargs -0 -r git --literal-pathspecs ls-files -z --`;
    const out = await this.must(machine, dir, `export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"
real=$(git rev-parse --git-path index)
bak=$(mktemp); skip=$(mktemp); assume=$(mktemp)
cp "$real" "$bak"
ok=0
trap 'if [ "$ok" != 1 ]; then cp "$bak" "$real"; fi; rm -f "$bak" "$skip" "$assume"' EXIT
# A file here that git does not see, where the carried state adds one: the first such path.
inway=$(git diff-tree -r -z --name-only --diff-filter=A ${now.tree} ${snap.tree} | { while IFS= read -r -d '' f; do
  if [ -L "$f" ] || [ -e "$f" ]; then
    if [ -d "$f" ] && [ ! -L "$f" ] && [ "$(git cat-file -t "${now.tree}:$f" 2>/dev/null)" = tree ] && [ -z "$(git ls-files --others --ignored --exclude-standard -- "$f/" | head -n 1)" ]; then continue; fi
    printf '%s\\n' "$f"; break
  fi
  p=$f
  while [ "$p" != "\${p%/*}" ]; do
    p=\${p%/*}
    if [ -d "$p" ] && [ ! -L "$p" ]; then break; fi
    if [ -L "$p" ] || [ -e "$p" ]; then if ! git cat-file -e "${now.tree}:$p" 2>/dev/null; then printf '%s\\n' "$p"; break 2; fi; break; fi
  done
done; } | head -n 1)
if [ -n "$inway" ]; then echo "inway=$inway"; ok=1; exit 0; fi
# The marks set by hand (and a sparse checkout's), by path, whatever the path's name.
if [ -n "$(git ls-files -v | grep -m 1 '^[a-zS] ')" ]; then
  git ls-files -v -z | while IFS= read -r -d '' rec; do
    case "$rec" in [Ss]\\ *) printf '%s\\0' "\${rec#* }" >> "$skip";; esac
    case "$rec" in [a-z]\\ *) printf '%s\\0' "\${rec#* }" >> "$assume";; esac
  done
  # An edit under a mark, on a file the carried state changes: nothing is touched.
  hidden=$(git diff-tree -r -z --name-only ${now.tree} ${snap.tree} | xargs -0 -r git --literal-pathspecs ls-files -v -z -- | { while IFS= read -r -d '' rec; do
    case "$rec" in [a-zS]\\ *) f=\${rec#* }; if [ -f "$f" ] && [ "$(git hash-object -- "$f")" != "$(git rev-parse ":$f" 2>/dev/null)" ]; then printf '%s\\n' "$f"; break; fi;; esac
  done; } | head -n 1)
  if [ -n "$hidden" ]; then echo "hidden=$hidden"; ok=1; exit 0; fi
fi
${GIT} read-tree ${now.tree}
${GIT} update-index -q --refresh >/dev/null || true
${GIT} read-tree -u -m --no-sparse-checkout ${now.tree} ${snap.tree}
# Where what is staged differs from the file, a file this folder does not hold (outside a sparse cone) is written as it is there.
git diff-tree -r -z --name-only ${snap.tree} ${snap.itree} | ${inIndex} | ${GIT} checkout-index -z --stdin >/dev/null 2>&1 || true
${this.staged(snap)}
${now.head !== snap.head ? `${GIT} update-ref -m "keel: handoff" HEAD ${snap.head}` : ""}
ok=1
# The marks return, except on the paths the carried state changed.
if [ -s "$skip" ]; then
  ${inIndex} < "$skip" | ${GIT} update-index -z --skip-worktree --stdin || true
  ${changed} | ${inIndex} | ${GIT} update-index -z --no-skip-worktree --stdin || true
fi
if [ -s "$assume" ]; then
  ${inIndex} < "$assume" | ${GIT} update-index -z --assume-unchanged --stdin || true
  ${changed} | ${inIndex} | ${GIT} update-index -z --no-assume-unchanged --stdin || true
fi
${GIT} update-index -q --refresh >/dev/null || true`, "the folder could not take the carried state (it is as it was)", true);
    const v = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
    if (v("inway")) return { replaced: false, why: `${v("inway")} exists there where git does not see it, and the carried state has a file of that name` };
    if (v("hidden")) throw new Error(`${v("hidden")} in ${dir} has an edit that git was told not to look at (a skip-worktree or assume-unchanged mark), and the carried state changes that file. Commit that edit or put it aside there, then move the session again. Nothing was changed.`);
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
    if (moves.landing) delete moves.landing[place];
    if (r.replaced) moves.left[place] = stateOf(snap);
    else h.summary = `${machine ? "The worktree there" : dir} was kept as it was (${r.why}); the carried state is in ${ref}.`;
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
    // What the last move still owes the queue is done first: the hold it left is not read as the owner's.
    this.settle(s.id);

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
    let lost: string[] = [];
    try {
      // The folder the session's state is read from, and a refusal, before its turn is stopped.
      let from = s.workspace;
      if (h.carry === "git") {
        const pre = await this.preflight(src, s.workspace);
        if (pre.refuse) throw new Error(pre.refuse);
        from = pre.dir;
      }
      await step("interrupt", async () => (this.engine.isRunning(sid) ? void (await this.engine.interrupt(sid)) : "skip"));
      let target = "";
      if (h.carry === "none") {
        for (const n of ["snapshot", "transfer"] as StepName[]) await step(n, async () => "skip");
        target = await step("worktree", async () => (dest ? workspace ?? dest.workspace_root! : workspace ?? moves.home ?? s.workspace)) ?? "";
      } else {
        const snap = await step("snapshot", () => this.snapshot(src, from, ref, { leaving: true }));
        if (!snap) throw new Error("no snapshot");
        lost = snap.lost;
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
            const known = theirs.length ? (await this.sh(src, from, theirs.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim())) : [];
            const local = join(this.store.stateDir, "handoff");
            mkdirSync(local, { recursive: true });
            const file = join(local, `${sid}.bundle`);
            if (src) throw new Error("a move between two other machines is not supported");
            await this.must(null, from, `git bundle create -q ${q(file)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle");
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
            await this.must(dest, root, `${cut ? `rm -rf ${q(made.dir)}\n${GIT} -C ${q(repo)} worktree prune\n` : ""}${GIT} -C ${q(repo)} worktree add -q --no-checkout -B ${q(made.branch)} ${q(made.dir)} ${snap.snap}`, "worktree there");
            // Its files, through the view of the repository there: a checkout made by `worktree add` would run the filters that repository's own config names.
            // (The fill of a new worktree may fetch what a partial clone was promised, as far as the moved session's own commands reach: see `fetch` in src/core/git.ts.)
            await this.must(dest, made.dir, `${GIT_SHELL_FETCH}${GIT} reset -q --hard ${snap.snap}\n${snap.snap !== snap.head ? `${this.staged(snap)}\n${GIT} reset -q --soft ${snap.head}\n${GIT} update-index -q --refresh >/dev/null || true` : "true"}`, "worktree there", true, gitReach(sid));
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
            const known = (await this.sh(src, from, heads.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim()));
            await this.must(src, from, `mkdir -p ${q(join(root, ".keel", "handoff"))}\ngit bundle create -q ${q(remoteFile)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle there");
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
        // A session that worked in a folder inside the repository goes on in the same folder of it.
        if (snap.prefix && !workspace) {
          const folder = join(target, snap.prefix);
          if ((await this.sh(dest, target, `test -d ${q(folder)}`)).code === 0) target = folder;
        }
      }
      // The switch: the machine, the folder, the note and the finished receipt
      // are one write. A daemon killed before it finds the session where it
      // was; one killed after it finds the move done.
      const sw = h.steps.find((x) => x.name === "switch")!;
      sw.state = "running";
      this.record(h);
      const carried = h.carry === "git" ? "with its git state" : "without its files";
      const summary = (h.summary ?? `Moved from ${h.from.machine} to ${h.to.machine} ${carried}: now in ${target}.`) + (lost.length ? ` Not carried: ${lost.map((k) => LOST[k]).filter(Boolean).join("; ")}.` : "");
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
      h.error = e instanceof LinkError ? `${(dest ?? src)?.name ?? h.to.machine} does not answer: ${(e as Error).message}` : (e as Error).message;
      h.ended_ms = Date.now();
      for (const st of h.steps) if (st.state === "pending" || st.state === "running") st.state = st.state === "running" ? "failed" : "skipped";
      // Deleted while it moved: what the move made for it goes with it.
      if (!this.store.session(sid)) {
        this.saveMoves(sid, { ...moves, last: h });
        return void (await this.cleanup(sid).catch(() => {}));
      }
      this.note(sid, `The move to ${h.to.machine} failed; the session stays on ${h.from.machine}. ${h.error}`);
      // The turn this move stopped stays stopped; the queue behind it is not the move's to keep held.
      const stopped = !h.held && h.steps.find((st) => st.name === "interrupt")!.state === "done";
      if (stopped) h.settle = true;
      this.record(h);
      if (stopped) { this.settle(sid); delete h.settle; }
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
