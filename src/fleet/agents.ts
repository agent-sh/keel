// Subagents on other machines of the fleet, and the files a session sends them.
//
// An agent given a machine is a child session placed there: its workspace tools
// go over that machine's hands like any placed session's. One that edits gets a
// git worktree of its own there (`<granted>/.keel/worktrees/agent-<id>`, branch
// `keel/agent-<id>`) when its directory is in a repository; the worktree goes
// when it ended with nothing in it, or when its session is deleted.
// Starting one is judged by the gate as `keel__spawn_on_machine` (the spawn
// tools' target); `keel__send_files` copies files of the caller's workspace
// into the agent's directory there.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RemotePlace, RemotePlacer } from "../automation/agents.ts";
import * as agents from "../automation/agents.ts";
import { contains } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { registerShared } from "../tools/registry.ts";
import { fail, ok, type Tool } from "../tools/types.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, linkFetch } from "./link.ts";

const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false";
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// The most files one call sends: a tree larger than this is an archive's job.
export const SEND_LIMIT = 5000;
// Per file: under Bun's default request body limit (128 MB) on the far side.
const FILE_MAX = 100 * 1024 * 1024;
// A result names this many files; the count says the rest.
const NAMES_SHOWN = 50;

type Work = { session_id: string; machine: string; worktree: string; repo: string; branch: string; base: string };

export class RemoteAgents implements RemotePlacer {
  constructor(private store: Store, private fleet: Fleet, private errors: ErrorTracker, private sandboxOf: (sessionId: string) => string) {
    store.migrate("CREATE TABLE IF NOT EXISTS fleet_agent_work (session_id TEXT PRIMARY KEY, machine TEXT NOT NULL, worktree TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL)");
  }

  key(machine: string): string {
    return (this.fleet.byName(machine)?.name ?? machine).toLowerCase();
  }

  private async sh(m: MachineRow, cwd: string, script: string): Promise<{ code: number; out: string }> {
    const r = await this.fleet.hands(m.id, "/api/fleet/hands/exec", { method: "POST", body: JSON.stringify({ script, cwd, root: m.workspace_root }), timeout: 11 * 60_000 });
    const b = (await r.json()) as { code?: number; out?: string; error?: string };
    return { code: b.code ?? 1, out: b.out ?? b.error ?? "" };
  }

  async place(parent: Session, o: { machine?: string; cwd?: string; worktree: boolean; key: string; title: string }): Promise<RemotePlace | null> {
    let wanted = o.machine?.trim() || parent.machine || "";
    if (wanted === "auto") {
      const p = await this.fleet.placeWork({ kind: "subagent" });
      if (typeof p === "string") throw new Error(p);
      wanted = p.machine_id;
    }
    const here = wanted === "local" || wanted.toLowerCase() === this.fleet.name.toLowerCase() || wanted === this.fleet.id;
    if (here) {
      if (parent.machine) throw new Error("this session's tools run on another machine; an agent of it cannot run on the daemon's own machine");
      return null;
    }
    const m = this.fleet.byName(wanted);
    if (!m) throw new Error(`no machine named ${wanted}. Known: ${[this.fleet.name, ...this.fleet.rows().map((r) => r.name)].join(", ")} (keel__machines_list shows them)`);
    if (parent.machine && parent.machine !== m.id) throw new Error("this session's tools run on another machine; its agents run there or here, not on a third one");
    if (!m.workspace_root) throw new Error(`${m.name} has no granted directory: the owner sets one in Settings, Machines`);
    if (this.sandboxOf(parent.id) === "read-only") throw new Error("a read-only sandbox reaches no other machine");
    const root = m.workspace_root;
    const base = parent.machine === m.id ? parent.workspace : root;
    const cwd = o.cwd ? (isAbsolute(o.cwd) ? resolve(o.cwd) : resolve(base, o.cwd)) : base;
    if (!contains(root, cwd)) throw new Error(`${cwd} is outside the directory granted on ${m.name} (${root})`);
    try {
      const st = (await (await this.fleet.hands(m.id, "/api/fleet/hands/stat", { method: "POST", body: JSON.stringify({ path: cwd, root }) })).json()) as { dir?: boolean };
      if (!st.dir) throw new Error(`${cwd} is not a directory on ${m.name}`);
      if (!o.worktree) return { machine: m.id, name: m.name, cwd };
      // An agent that edits gets its own worktree there when its directory is in a repository.
      const top = await this.sh(m, cwd, `${GIT} rev-parse --show-toplevel 2>/dev/null && ${GIT} rev-parse --short HEAD 2>/dev/null && (${GIT} symbolic-ref -q --short HEAD || true)`);
      const [repo, head, branchNow] = top.out.trim().split("\n");
      if (top.code !== 0 || !repo || !head) return { machine: m.id, name: m.name, cwd };
      const branch = `keel/agent-${o.key}`;
      const dir = join(root, ".keel", "worktrees", `agent-${o.key}`);
      const made = await this.sh(m, root, `set -e\nmkdir -p ${q(join(root, ".keel", "worktrees"))}\n${GIT} -C ${q(repo)} worktree add -q -b ${q(branch)} ${q(dir)} HEAD`);
      if (made.code !== 0) throw new Error(`no worktree could be made on ${m.name} from ${repo}: ${made.out.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
      const sub = relative(repo, cwd);
      const at = sub && !sub.startsWith("..") ? join(dir, sub) : dir;
      const baseName = branchNow || head;
      this.store.db.query("INSERT OR REPLACE INTO fleet_agent_work (session_id, machine, worktree, repo, branch, base) VALUES (?, ?, ?, ?, ?, ?)").run(`pending:${o.key}`, m.id, dir, repo, branch, head);
      return { machine: m.id, name: m.name, cwd: at, worktree: dir, branch, base: baseName };
    } catch (e) {
      if (e instanceof LinkError) throw new Error(`${m.name} cannot be reached: ${e.message}`);
      throw e;
    }
  }

  // The record made at placement, tied to the agent's session once it exists.
  private work(a: agents.AgentRecord): Work | undefined {
    const db = this.store.db;
    db.query("UPDATE fleet_agent_work SET session_id = ? WHERE session_id = ?").run(a.session_id, `pending:${a.id}`);
    return db.query<Work, [string]>("SELECT * FROM fleet_agent_work WHERE session_id = ?").get(a.session_id) ?? undefined;
  }

  // What the agent left there: an empty worktree goes, one with work stays.
  async finished(a: agents.AgentRecord): Promise<string> {
    const w = this.work(a);
    const m = this.fleet.row(a.machine ?? "");
    if (!w || !m) return "";
    try {
      const st = await this.sh(m, m.workspace_root!, `[ -d ${q(w.worktree)} ] || { echo gone; exit 0; }\ncd ${q(w.worktree)}\necho "$(${GIT} status --porcelain | wc -l) $(${GIT} rev-list --count ${w.base}..HEAD)"`);
      const line = st.out.trim().split("\n").at(-1) ?? "";
      if (line === "gone") return "";
      const [dirty, ahead] = line.split(" ").map(Number);
      if (st.code !== 0 || dirty === undefined || ahead === undefined || Number.isNaN(dirty) || Number.isNaN(ahead)) return `\n\nWorktree ${w.worktree} on ${m.name} (branch ${w.branch}): git could not read it: ${line.slice(0, 200)}`;
      if (!dirty && !ahead) {
        await this.removeWork(w, false);
        return `\n\n(The agent changed no files; its worktree on ${m.name} was removed.)`;
      }
      return `\n\nIts work is on ${m.name}, branch ${w.branch} in the worktree ${w.worktree}: ${ahead} commit${ahead === 1 ? "" : "s"} over ${w.base}, ${dirty} uncommitted file${dirty === 1 ? "" : "s"}. Look at it there with keel__run_on (git -C ${w.worktree} log --stat ${w.base}..HEAD).`;
    } catch (e) {
      if (!(e instanceof LinkError)) this.errors.capture("server", e, { at: "remote agent finished", machine: m.id });
      return `\n\nIts worktree ${w.worktree} on ${m.name} could not be checked: ${(e as Error).message}`;
    }
  }

  // A finished agent continued: its emptied worktree is made again at the same place.
  async revive(a: agents.AgentRecord): Promise<void> {
    const w = this.work(a);
    const m = this.fleet.row(a.machine ?? "");
    if (!w || !m) return;
    const r = await this.sh(m, m.workspace_root!, `[ -d ${q(w.worktree)} ] && exit 0\n${GIT} -C ${q(w.repo)} worktree add -q -B ${q(w.branch)} ${q(w.worktree)} ${w.base}`);
    if (r.code !== 0) throw new Error(`its worktree on ${m.name} could not be made again: ${r.out.trim().slice(-300)}`);
  }

  // `forget`: the agent's session is gone; else its record stays, so a later
  // message or send makes the worktree again at the same place.
  private async removeWork(w: Work, forget = true) {
    const m = this.fleet.row(w.machine);
    if (m?.workspace_root) {
      await this.sh(m, m.workspace_root, `if [ -d ${q(w.worktree)} ]; then ${GIT} -C ${q(w.repo)} worktree remove --force ${q(w.worktree)}; fi; ${GIT} -C ${q(w.repo)} branch -D ${q(w.branch)} >/dev/null 2>&1; true`);
    }
    if (forget) this.store.db.query("DELETE FROM fleet_agent_work WHERE session_id = ?").run(w.session_id);
  }

  // After a session is deleted: the worktrees there of agents whose sessions are gone.
  async sweep() {
    const rows = this.store.db.query<Work, []>("SELECT * FROM fleet_agent_work WHERE session_id NOT LIKE 'pending:%'").all();
    for (const w of rows) {
      if (this.store.session(w.session_id)) continue;
      await this.removeWork(w).catch((e) => {
        if (!(e instanceof LinkError)) this.errors.capture("server", e, { at: "remote agent cleanup", machine: w.machine });
      });
    }
  }

  // ---- keel__send_files

  async send(parent: Session, agentId: string, paths: string[], callId: string | undefined, mode: string): Promise<{ text: string; error?: boolean }> {
    const err = (text: string) => ({ text, error: true });
    if (mode === "plan") return err("Error [PERMISSION_DENIED]: this session is in plan mode: nothing is copied to another machine.");
    let a: agents.AgentRecord;
    try { a = agents.resolveTarget(parent.id, agentId); } catch { return err(`Error [INVALID_PARAM]: this session has no agent ${agentId}.`); }
    const child = this.store.session(a.session_id);
    if (!child) return err("Error [NOT_FOUND]: that agent's session is gone.");
    if (!child.machine) return err("Error [NOT_AVAILABLE]: that agent runs on this machine and reads the same files; there is nothing to copy.");
    if (parent.machine) return err("Error [NOT_AVAILABLE]: this session's own files are on another machine; copying between two other machines is not supported.");
    const m = this.fleet.row(child.machine);
    if (!m?.workspace_root) return err("Error [NOT_AVAILABLE]: the agent's machine is no longer in the fleet, or has no granted directory.");
    if (!paths.length) return err("Error [INVALID_PARAM]: paths is missing: the files or directories to copy.");
    let ws: string;
    try { ws = realpathSync(parent.workspace); } catch { return err(`Error [NOT_FOUND]: this session's directory ${parent.workspace} is gone.`); }
    // Only this workspace's own files leave the machine this way, links resolved.
    const roots: string[] = [];
    for (const raw of paths) {
      const p = isAbsolute(raw) ? raw : resolve(parent.workspace, raw);
      let real: string;
      try { real = realpathSync(p); } catch { return err(`Error [NOT_FOUND]: ${raw} does not exist.`); }
      if (!contains(ws, real)) return err(`Error [PERMISSION_DENIED]: ${raw} is outside this session's directory. Only files of the workspace can be sent to an agent.`);
      roots.push(real);
    }
    const files = filesUnder(roots);
    if (files.length > SEND_LIMIT) return err(`Error [INVALID_PARAM]: more than ${SEND_LIMIT} files in one call; send fewer paths or an archive.`);
    const big = files.find((f) => statSync(f).size > FILE_MAX);
    if (big) return err(`Error [INVALID_PARAM]: ${relative(ws, big)} is over ${FILE_MAX / 1024 / 1024} MB; send an archive in parts or let the agent fetch it.`);
    this.fleet.step(parent.id, callId, m.id);
    // An agent that ended with an empty worktree had it removed: it is made again first.
    if (a.worktree) {
      try { await this.revive(a); } catch (e) {
        if (e instanceof LinkError) return err(`Error [NOT_AVAILABLE]: ${m.name} cannot be reached: ${e.message}`);
        return err(`Error [FAILED]: ${(e as Error).message}`);
      }
    }
    let bytes = 0;
    const sent: string[] = [];
    try {
      for (const f of files) {
        const to = join(child.workspace, relative(ws, f));
        const data = readFileSync(f);
        const r = await this.fleet.hands(m.id, `/api/fleet/hands/put?path=${encodeURIComponent(to)}&root=${encodeURIComponent(m.workspace_root)}`, { method: "POST", body: data, headers: { "content-type": "application/octet-stream" }, timeout: 120_000 });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          return err(`Error [FAILED]: ${m.name} refused ${relative(ws, f)}: ${b.error ?? `HTTP ${r.status}`}. ${sent.length} file(s) were copied before it.`);
        }
        bytes += data.length;
        sent.push(to);
      }
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      return err(`Error [NOT_AVAILABLE]: ${m.name} cannot be reached: ${e.message}. ${sent.length} file(s) were copied before it.`);
    }
    const names = sent.slice(0, NAMES_SHOWN).map((s) => `  ${s}`);
    if (sent.length > NAMES_SHOWN) names.push(`  and ${sent.length - NAMES_SHOWN} more`);
    return { text: `Copied ${sent.length} file(s), ${bytes} bytes, to ${m.name} into ${child.workspace}:\n${names.join("\n")}` };
  }
}

// The regular files at or under each path: links are left out, and so is a
// repository's .git (the agent's worktree has its own).
export function filesUnder(roots: string[]): string[] {
  const out = new Set<string>();
  const walk = (p: string) => {
    if (out.size > SEND_LIMIT) return;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isFile()) return void out.add(p);
    if (!st.isDirectory()) return;
    for (const e of readdirSync(p)) if (e !== ".git") walk(join(p, e));
  };
  for (const r of roots) walk(r);
  return [...out];
}

export function sendFilesTool(r: () => RemoteAgents | undefined, session: (id: string) => Session | undefined, modeOf: (id: string) => string): Tool {
  return {
    name: "keel__send_files",
    description: "Copy files or directories of your workspace into the directory of an agent you started on another machine (spawn with machine). Paths keep their place under the workspace. Links and .git are left out; at most 5000 files.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent's id (or its title)" },
        paths: { type: "array", items: { type: "string" }, description: "Files or directories inside your workspace" },
      },
      required: ["agent_id", "paths"],
      additionalProperties: false,
    },
    // It writes files on another machine: a remote write, judged by its name
    // (it asks, read-only and plan refuse it, a grant names it).
    readOnly: false,
    kind: "remote",
    async run(input, ctx) {
      const ra = r();
      const me = session(ctx.sessionId);
      if (!ra || !me) return fail("The fleet is not running.");
      const paths = Array.isArray(input.paths) ? input.paths.filter((p: unknown): p is string => typeof p === "string" && !!p.trim()) : [];
      const out = await ra.send(me, String(input.agent_id ?? ""), paths, ctx.callId, modeOf(ctx.sessionId));
      return out.error ? fail(out.text) : ok(out.text);
    },
  };
}

export function registerSendFiles(r: () => RemoteAgents | undefined, session: (id: string) => Session | undefined, modeOf: (id: string) => string) {
  registerShared(sendFilesTool(r, session, modeOf));
}
