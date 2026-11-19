// Moving a session: the place its tools run changes, with its git state. The
// conversation stays with this daemon. `carry: "git"` makes the directory's
// state one snapshot commit (HEAD, or a commit on top holding every
// uncommitted change, built through a throwaway index so the directory it
// leaves is not touched), sends what the destination lacks as a git bundle,
// and puts it in a worktree there with the rest uncommitted again. Coming
// back, the snapshot lands in the directory the session first left, only when
// that directory is as the session left it; its own state is saved to a ref
// first, always.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { Engine } from "../engine/turn.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, linkFetch } from "./link.ts";

export type StepName = "interrupt" | "snapshot" | "transfer" | "worktree" | "switch";
export type Step = { name: StepName; state: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
export type Handoff = {
  session_id: string; state: "running" | "done" | "failed"; carry: "git" | "none";
  from: { machine_id: string; machine: string; cwd: string }; to: { machine_id: string; machine: string; cwd?: string };
  steps: Step[]; started_ms: number; ended_ms?: number; summary?: string; error?: string; home?: string; away?: Record<string, string>;
  before_ref?: string; replaced?: boolean;
};
type Moves = { home?: string; away: Record<string, string>; left: Record<string, string>; last?: Handoff };

const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=Keel -c user.email=keel@localhost";
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const key = (machine: string, dir: string) => `${machine}:${dir}`;

export class MoveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class Handoffs {
  private moving = new Set<string>();

  constructor(private store: Store, private bus: Bus, private engine: Engine, private fleet: Fleet) {
    store.migrate("CREATE TABLE IF NOT EXISTS fleet_moves (session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
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
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, out: out + err };
    }
    const p = await this.fleet.peer(machine.id);
    const r = await linkFetch(p, "/api/fleet/hands/exec", { method: "POST", body: JSON.stringify({ script, cwd, root: machine.workspace_root }), timeout: 11 * 60_000 });
    const b = (await r.json()) as { code: number; out: string; error?: string };
    return { code: b.code ?? 1, out: b.out ?? b.error ?? "" };
  }

  private async must(machine: MachineRow | null, cwd: string, script: string, what: string): Promise<string> {
    const r = await this.sh(machine, cwd, `set -e\n${script}`);
    if (r.code !== 0) throw new Error(`${what}: ${r.out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    return r.out;
  }

  // The directory's whole state as one tree (tracked, staged, untracked), and a
  // snapshot commit of it on top of HEAD when it differs. Touches nothing there.
  private async snapshot(machine: MachineRow | null, dir: string, ref: string) {
    const out = await this.must(machine, dir, `
top=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
GIT_INDEX_FILE="$idx" ${GIT} read-tree HEAD
GIT_INDEX_FILE="$idx" ${GIT} add -A
tree=$(GIT_INDEX_FILE="$idx" ${GIT} write-tree)
if [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then snap=$head; else snap=$(${GIT} commit-tree "$tree" -p "$head" -m "keel: handoff snapshot"); fi
${GIT} update-ref ${q(ref)} "$snap"
echo "top=$top"; echo "head=$head"; echo "tree=$tree"; echo "snap=$snap"
roots=$(git rev-list --max-parents=0 HEAD | tr '\\n' ' '); echo "roots=$roots"`, "snapshot");
    const v = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    return { top: v("top"), head: v("head"), tree: v("tree"), snap: v("snap"), roots: v("roots").split(" ").filter(Boolean) };
  }

  private async treeOf(machine: MachineRow | null, dir: string): Promise<string | null> {
    const r = await this.sh(machine, dir, `idx=$(mktemp); GIT_INDEX_FILE="$idx" ${GIT} read-tree HEAD && GIT_INDEX_FILE="$idx" ${GIT} add -A && GIT_INDEX_FILE="$idx" ${GIT} write-tree; rm -f "$idx"`);
    return r.code === 0 ? r.out.trim().split("\n").pop()! : null;
  }

  // Put a snapshot into an existing directory: its own state saved to a ref of
  // its own first; replaced only when it is as the session left it and its
  // HEAD is an ancestor of the snapshot. Otherwise its files stay.
  private async land(machine: MachineRow | null, dir: string, sid: string, snap: { head: string; snap: string }, leftTree?: string) {
    const beforeRef = `refs/keel/handoff-before/${sid}/${Date.now()}`;
    const now = await this.snapshot(machine, dir, beforeRef);
    const asLeft = leftTree !== undefined && now.tree === leftTree;
    const anc = (await this.sh(machine, dir, `git merge-base --is-ancestor ${now.head} ${snap.snap}`)).code === 0;
    if (!asLeft || !anc) return { beforeRef, replaced: false, why: !asLeft ? "it changed since the session left it" : "its commit is not an ancestor of the carried state" };
    await this.must(machine, dir, `${GIT} reset -q --hard ${snap.head}\n${GIT} read-tree -u --reset ${snap.snap}\n${GIT} reset -q ${snap.head}`, "apply");
    return { beforeRef, replaced: true };
  }

  private async put(machine: MachineRow, path: string, data: Uint8Array) {
    const p = await this.fleet.peer(machine.id);
    const r = await linkFetch(p, `/api/fleet/hands/put?path=${encodeURIComponent(path)}&root=${encodeURIComponent(machine.workspace_root!)}`, { method: "POST", body: data as unknown as BodyInit, headers: { "content-type": "application/octet-stream" }, timeout: 10 * 60_000 });
    if (!r.ok) throw new Error(`sending the bundle: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  private async get(machine: MachineRow, path: string): Promise<Uint8Array> {
    const p = await this.fleet.peer(machine.id);
    const r = await linkFetch(p, `/api/fleet/hands/get?path=${encodeURIComponent(path)}&root=${encodeURIComponent(machine.workspace_root!)}`, { timeout: 10 * 60_000 });
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
    };
    this.moving.add(s.id);
    this.record(h);
    this.run(s, h, src, dest, b.workspace).finally(() => this.moving.delete(s.id));
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
    try {
      await step("interrupt", async () => (this.engine.isRunning(sid) ? void (await this.engine.interrupt(sid)) : "skip"));
      let target = "";
      if (h.carry === "none") {
        for (const n of ["snapshot", "transfer"] as StepName[]) await step(n, async () => "skip");
        target = await step("worktree", async () => (dest ? workspace ?? dest.workspace_root! : workspace ?? moves.home ?? s.workspace)) ?? "";
      } else {
        const snap = await step("snapshot", () => this.snapshot(src, s.workspace, ref));
        if (!snap) throw new Error("no snapshot");
        moves.left[key(h.from.machine_id, snap.top)] = snap.tree;
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
                if (m && m[1] === join(root, name)) throw new Error(`${join(root, name)} on ${dest.name} is another repository: name one with workspace`);
              }
              if (!repo) { repo = join(root, name); await this.must(dest, root, `mkdir -p ${q(repo)}\ngit -C ${q(repo)} init -q`, "a new repository there"); }
            }
            const has = await this.sh(dest, root, `git -C ${q(repo)} cat-file -e ${snap.snap}^{commit}`);
            if (has.code === 0) return "skip";
            const theirs = (await this.sh(dest, root, `git -C ${q(repo)} for-each-ref --format='%(objectname)' --count=50 refs/heads refs/keel/handoff 2>/dev/null; true`)).out.split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{40}$/.test(x));
            const known = theirs.length ? (await this.sh(src, s.workspace, theirs.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim())) : [];
            const local = join(this.store.stateDir, "handoff");
            mkdirSync(local, { recursive: true });
            const file = join(local, `${sid}.bundle`);
            if (src) throw new Error("a move between two other machines is not supported");
            await this.must(null, s.workspace, `git bundle create -q ${q(file)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle");
            const remoteFile = join(root, ".keel", "handoff", `${sid}.bundle`);
            await this.put(dest, remoteFile, readFileSync(file));
            rmSync(file, { force: true });
            await this.must(dest, root, `git -C ${q(repo)} fetch ${q(remoteFile)} ${q(`+${ref}:${ref}`)}\nrm -f ${q(remoteFile)}`, "unbundle there");
          });
          target = (await step("worktree", async () => {
            const wt = moves.away[dest.id];
            if (wt && (await this.sh(dest, root, `test -d ${q(wt)}`)).code === 0) {
              const r = await this.land(dest, wt, sid, snap, moves.left[key(dest.id, wt)]);
              h.before_ref = r.beforeRef;
              h.replaced = r.replaced;
              if (!r.replaced) h.summary = `The worktree there was kept as it was (${r.why}); the carried state is in ${ref}.`;
              return wt;
            }
            const stamp = Date.now().toString(36);
            const dir = join(root, ".keel", "worktrees", `handoff-${sid.slice(-12)}-${stamp}`);
            await this.must(dest, root, `${GIT} -C ${q(repo)} worktree add -q -B ${q(`keel/handoff-${sid.slice(-12)}-${stamp}`)} ${q(dir)} ${snap.snap}\n${snap.snap !== snap.head ? `cd ${q(dir)} && ${GIT} reset -q ${snap.head}` : "true"}`, "worktree there");
            moves.away[dest.id] = dir;
            this.saveMoves(sid, { ...moves, last: h });
            return dir;
          })) ?? "";
        } else {
          // Back here, into the directory the session first left (or the one named).
          const home = workspace ?? moves.home ?? s.workspace;
          await step("transfer", async () => {
            const has = await this.sh(null, home, `git cat-file -e ${snap.snap}^{commit}`);
            if (has.code === 0) return "skip";
            const root = src!.workspace_root!;
            const remoteFile = join(root, ".keel", "handoff", `${sid}.bundle`);
            const heads = (await this.sh(null, home, `git for-each-ref --format='%(objectname)' --count=50 refs/heads refs/keel/handoff; true`)).out.split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{40}$/.test(x));
            const known = (await this.sh(src, s.workspace, heads.map((c) => `git cat-file -e ${c}^{commit} 2>/dev/null && echo ${c}`).join("\n") + "\ntrue")).out.split("\n").filter((x) => /^[0-9a-f]{40}$/.test(x.trim()));
            await this.must(src, s.workspace, `mkdir -p ${q(join(root, ".keel", "handoff"))}\ngit bundle create -q ${q(remoteFile)} ${q(ref)} ${known.map((k) => `^${k}`).join(" ")}`, "bundle there");
            const local = join(this.store.stateDir, "handoff");
            mkdirSync(local, { recursive: true });
            const file = join(local, `${sid}.bundle`);
            writeFileSync(file, await this.get(src!, remoteFile));
            await this.sh(src, root, `rm -f ${q(remoteFile)}`);
            await this.must(null, home, `git fetch ${q(file)} ${q(`+${ref}:${ref}`)}`, "unbundle here");
            rmSync(file, { force: true });
          });
          target = (await step("worktree", async () => {
            const r = await this.land(null, home, sid, snap, moves.left[key("local", home)]);
            h.before_ref = r.beforeRef;
            h.replaced = r.replaced;
            if (!r.replaced) h.summary = `${home} was kept as it was (${r.why}); the carried state is in ${ref}.`;
            return home;
          })) ?? "";
        }
      }
      await step("switch", async () => {
        this.store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(dest ? dest.id : null, sid);
        const next = this.store.updateSession(sid, { workspace: target });
        this.engine.forgetSystem(sid);
        this.bus.emit({ t: "session", session: next });
      });
      h.to.cwd = target;
      h.away = Object.keys(moves.away).length ? moves.away : undefined;
      h.state = "done";
      h.ended_ms = Date.now();
      const carried = h.carry === "git" ? "with its git state" : "without its files";
      h.summary = h.summary ?? `Moved from ${h.from.machine} to ${h.to.machine} ${carried}: now in ${target}.`;
      this.note(sid, h.summary);
      this.record(h);
      this.engine.resumeQueue(sid);
    } catch (e) {
      h.state = "failed";
      h.error = e instanceof LinkError ? `${h.to.machine} does not answer: ${(e as Error).message}` : (e as Error).message;
      h.ended_ms = Date.now();
      for (const st of h.steps) if (st.state === "pending" || st.state === "running") st.state = st.state === "running" ? "failed" : "skipped";
      this.note(sid, `The move to ${h.to.machine} failed; the session stays on ${h.from.machine}. ${h.error}`);
      this.record(h);
    }
  }

  private note(id: string, text: string) {
    const e = this.store.append(id, "note", { kind: "handoff", text });
    this.bus.emit({ t: "event", event: e });
  }

  // When the session is deleted: its refs here; the worktree, its branch and refs there.
  async cleanup(id: string) {
    const m = this.moves(id);
    const ref = `refs/keel/handoff/${id}`;
    if (m.home) await this.sh(null, m.home, `git update-ref -d ${q(ref)}; git for-each-ref --format='%(refname)' ${q(`refs/keel/handoff-before/${id}/`)} | while read r; do git update-ref -d "$r"; done; true`).catch(() => {});
    for (const [mid, wt] of Object.entries(m.away)) {
      const mr = this.fleet.row(mid);
      if (!mr?.workspace_root) continue;
      await this.sh(mr, mr.workspace_root, `if [ -d ${q(wt)} ]; then b=$(git -C ${q(wt)} rev-parse --abbrev-ref HEAD); c=$(git -C ${q(wt)} rev-parse --git-common-dir); repo=$(cd ${q(wt)} && cd "$c/.." && pwd); git -C "$repo" worktree remove --force ${q(wt)}; git -C "$repo" branch -D "$b" >/dev/null 2>&1; git -C "$repo" update-ref -d ${q(ref)}; fi; true`).catch(() => {});
    }
    this.store.db.query("DELETE FROM fleet_moves WHERE session_id = ?").run(id);
  }
}
