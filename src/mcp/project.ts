// A project's own MCP servers: the `.mcp.json` a repository keeps (Claude
// Code's project scope, code.claude.com/docs/en/mcp#project-scope). Its
// servers are offered to the sessions working in that project, and only
// after the owner approved each one: a repository cannot approve its own.
//
// - The file is the nearest `.mcp.json` from the session's folder up to its
//   repository's root (the folder itself when it is in none).
// - An approval holds one entry as it was shown: the digest of what it
//   runs (command, arguments, environment, address, headers). A changed
//   entry waits for the owner again; a rejected one is never started.
// - The owner's approvals in Claude Code are taken over, from files a
//   repository cannot write (~/.claude.json's entry for the project, and
//   ~/.claude/settings.json): `enabledMcpjsonServers`,
//   `enableAllProjectMcpServers` and `disabledMcpjsonServers`. They are
//   recorded as the entry is now, so a later change asks in Keel. The
//   repository's own .claude/settings.json is not read for this.
// - An approved server runs as a session's own server does (manager.ts
//   setSessionServers): for those sessions alone, inside the session's
//   sandbox, with an environment of its own. In its command, arguments and
//   environment `${VAR}` and `${VAR:-default}` are expanded from the owner's
//   environment as Claude Code does; in a remote server's address and
//   headers no variable of the owner's is read (only a written default), so
//   a repository cannot send the owner's keys to a host it names.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { locate } from "../core/git.ts";
import type { ClaudeChoice } from "./claude-choices.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { rootOf } from "../safety/trust.ts";
import type { McpServerConfig } from "./config.ts";
import { expand } from "./config.ts";
import type { McpManager } from "./manager.ts";
import { claudeShape, importHome } from "./sources.ts";

export type ProjectDecision = "approved" | "rejected";
export type ProjectServer = {
  name: string;
  target: string;          // what it runs, in one line
  entry: unknown;          // the whole entry as the file holds it, unexpanded: what an approval holds
  digest: string;
  state: "approved" | "rejected" | "pending" | "changed";
  by?: "owner" | "claude"; // who approved or rejected it
};
export type ProjectState = { root: string; file: string | null; error?: string; servers: ProjectServer[] };

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v);
const digestOf = (raw: unknown) => createHash("sha256").update(JSON.stringify(canon(raw))).digest("hex").slice(0, 32);
const shown = (c: McpServerConfig) => (c.url ? c.url : [c.command, ...(c.args ?? [])].join(" "));

// The key a project's approvals are kept under: its folder in the
// repository's main checkout, so a worktree of it (or a second clone's
// worktree of the same repository) asks nothing again.
export function projectKey(root: string): string {
  const w = locate(root);
  if (!w?.top) return root;
  const main = w.common.endsWith("/.git") ? dirname(w.common) : w.common;
  let top = w.top, at = root;
  try { top = realpathSync(w.top); at = realpathSync(root); } catch {}
  return main === top ? root : join(main, relative(top, at));
}

// The `.mcp.json` a session's folder belongs to, and the project's root.
export function projectFile(workspace: string): { root: string; file: string | null } {
  const top = rootOf(workspace) ?? workspace;
  for (let d = workspace; ; d = dirname(d)) {
    const f = join(d, ".mcp.json");
    if (existsSync(f)) return { root: d, file: f };
    if (d === top || dirname(d) === d) return { root: top, file: null };
  }
}

// A project's entry as it runs: Claude Code's shape, its variables expanded.
export function runnable(raw: any, env: Record<string, string | undefined> = process.env): McpServerConfig {
  const c = claudeShape(raw);
  const all = (s: string) => expand(s, env);
  // An address or a header reads none of the owner's variables: only a default
  // the entry writes itself (${VAR:-default}); no list of names can tell every
  // credential apart (DATABASE_URL, GH_PAT, SENTRY_DSN, NPM_AUTH).
  const safe = (s: string) => expand(s, {});
  return {
    ...c,
    ...(c.command ? { command: all(c.command) } : {}),
    ...(c.args ? { args: c.args.map(all) } : {}),
    ...(c.env ? { env: Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, all(String(v))])) } : {}),
    ...(c.url ? { url: safe(c.url) } : {}),
    ...(c.headers ? { headers: Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, safe(String(v))])) } : {}),
  };
}

export class ProjectServers {
  // What each file held when it was last read: read again when its size or time changed.
  private files = new Map<string, { size: number; mtime: number; entries: Record<string, unknown>; error?: string }>();
  // The sessions given a project's servers, by root: told again when a decision changes them.
  private sessions = new Map<string, Set<string>>();
  // What a session was told is waiting (name and digest), so each is told once.
  private told = new Map<string, Set<string>>();
  // Told a session that its project has servers waiting for the owner.
  onPending?: (session: string, root: string, names: string[]) => void;

  constructor(private store: Store, private m: McpManager) {
    store.migrate("CREATE TABLE IF NOT EXISTS mcp_project_pins (root TEXT NOT NULL, name TEXT NOT NULL, digest TEXT NOT NULL, decision TEXT NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (root, name))");
  }

  private entries(file: string): { entries: Record<string, unknown>; error?: string } {
    let st;
    try { st = statSync(file); } catch { return { entries: {} }; }
    const had = this.files.get(file);
    if (had && had.size === st.size && had.mtime === st.mtimeMs) return had;
    let entries: Record<string, unknown> = {}, error: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const servers = raw?.mcpServers ?? {};
      if (servers && typeof servers === "object" && !Array.isArray(servers)) entries = servers;
      else error = "mcpServers is not an object";
    } catch (e) { error = `it cannot be read: ${(e as Error).message}`; }
    const r = { size: st.size, mtime: st.mtimeMs, entries, ...(error ? { error } : {}) };
    this.files.set(file, r);
    return r;
  }

  // The owner's approvals in Claude Code (files a repository cannot write),
  // read on the read thread when a file changed (~/.claude.json is large);
  // until an answer comes, what was read last. A new answer gives the
  // sessions of the projects it changes their servers again.
  private claude: { mark: string; roots: string; choices: Record<string, ClaudeChoice> } = { mark: "", roots: "", choices: {} };
  private claudeAsked?: string;
  read?: (files: string[], roots: string[]) => Promise<Record<string, ClaudeChoice>>;
  private claudeChoices(roots: string[]): { all: boolean; on: Set<string>; off: Set<string> } {
    const home = importHome();
    const files = [join(home, ".claude.json"), join(home, ".claude", "settings.json")];
    const mark = files.map((f) => { try { const st = statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return "-"; } }).join("|");
    const want = [...new Set([...roots, ...this.sessions.keys()])].sort();
    const key = `${mark}\u0000${want.join("\u0000")}`;
    if (this.read && `${this.claude.mark}\u0000${this.claude.roots}` !== key && this.claudeAsked !== key) {
      this.claudeAsked = key;
      this.read(files, want).then((choices) => {
        this.claude = { mark, roots: want.join("\u0000"), choices };
        this.claudeAsked = undefined;
        for (const root of want) for (const id of this.sessions.get(root) ?? []) { const s = this.store.session(id); if (s && !s.archived) this.refresh(s); }
      }, () => { this.claudeAsked = undefined; });
    }
    const out = { all: false, on: new Set<string>(), off: new Set<string>() };
    for (const r of roots) {
      const c = this.claude.choices[r];
      if (!c) continue;
      if (c.all) out.all = true;
      for (const n of c.on) out.on.add(n);
      for (const n of c.off) out.off.add(n);
    }
    return out;
  }

  private pin(root: string, name: string) {
    return this.store.db.query<{ digest: string; decision: ProjectDecision; by: "owner" | "claude" }, [string, string]>("SELECT digest, decision, by FROM mcp_project_pins WHERE root = ? AND name = ?").get(root, name);
  }

  // Every server of a project's file with what the owner decided of it.
  // `key`: where its approvals are kept (projectKey); `at`: the folder Claude Code knows it by.
  state(root: string, file: string | null, at: string = root): ProjectState & { configs: Map<string, McpServerConfig> } {
    const configs = new Map<string, McpServerConfig>();
    if (!file) return { root, file, servers: [], configs };
    const { entries, error } = this.entries(file);
    let claude: ReturnType<ProjectServers["claudeChoices"]> | undefined;
    const servers: ProjectServer[] = [];
    for (const [name, raw] of Object.entries(entries)) {
      const digest = digestOf(raw);
      let config: McpServerConfig;
      try { config = runnable(raw); } catch { continue; }
      configs.set(name, config);
      let p = this.pin(root, name);
      if (!p) {
        claude ??= this.claudeChoices([...new Set([at, root])]);
        const decision: ProjectDecision | undefined = claude.off.has(name) ? "rejected" : claude.all || claude.on.has(name) ? "approved" : undefined;
        if (decision) {
          this.store.db.query("INSERT OR IGNORE INTO mcp_project_pins (root, name, digest, decision, by, ts) VALUES (?, ?, ?, ?, 'claude', ?)").run(root, name, digest, decision, Date.now());
          p = { digest, decision, by: "claude" };
        }
      }
      const state = !p ? "pending" : p.decision === "rejected" ? "rejected" : p.digest === digest ? "approved" : "changed";
      servers.push({ name, target: shown(claudeShape(raw)), entry: raw, digest, state, ...(p ? { by: p.by } : {}) });
    }
    return { root, file, ...(error ? { error } : {}), servers, configs };
  }

  // A session's project servers brought to what the owner approved now.
  refresh(s: Pick<Session, "id" | "workspace" | "machine">) {
    if (!s.workspace) return;
    const { root: at, file } = projectFile(s.workspace);
    const root = projectKey(at);
    const st = this.state(root, file, at);
    // A command starts in the project's folder (where its .mcp.json is), as Claude Code starts it.
    const approved = st.servers.filter((x) => x.state === "approved").map((x) => ({ name: x.name, config: st.configs.get(x.name)! }));
    // (A session on another machine is not given a command of this one: setSessionServers says so.)
    this.m.setSessionServers(s.id, approved, { cwd: at, project: root, ...(s.machine && s.machine !== "local" ? { remote: s.machine } : {}) });
    let set = this.sessions.get(root);
    if (!set) this.sessions.set(root, (set = new Set()));
    set.add(s.id);
    this.where.set(root, { file, at });
    // Told once each, and not before the owner's approvals in Claude Code are read (one may approve it).
    if (this.claudeAsked !== undefined) return;
    let told = this.told.get(s.id);
    if (!told) this.told.set(s.id, (told = new Set()));
    const fresh = st.servers.filter((x) => (x.state === "pending" || x.state === "changed") && !told!.has(`${root}\u0000${x.name}:${x.digest}`));
    for (const x of fresh) told.add(`${root}\u0000${x.name}:${x.digest}`);
    if (fresh.length) this.onPending?.(s.id, root, fresh.map((x) => x.name));
  }

  // The owner's decision on one entry as it was shown (its digest); `forget` asks again.
  decide(root: string, name: string, digest: string, decision: ProjectDecision | "forget"): string | null {
    const { file, at } = this.whereOf(root);
    const now = this.state(root, file, at).servers.find((x) => x.name === name);
    if (!now) return `${root} has no server ${name} in its .mcp.json`;
    if (now.digest !== digest) return `${name} changed in .mcp.json since it was shown: look at it again`;
    if (decision === "forget") this.store.db.query("DELETE FROM mcp_project_pins WHERE root = ? AND name = ?").run(root, name);
    else this.store.db.query("INSERT INTO mcp_project_pins (root, name, digest, decision, by, ts) VALUES (?, ?, ?, ?, 'owner', ?) ON CONFLICT(root, name) DO UPDATE SET digest = excluded.digest, decision = excluded.decision, by = 'owner', ts = excluded.ts").run(root, name, digest, decision, Date.now());
    for (const id of this.sessions.get(root) ?? []) {
      const s = this.store.session(id);
      if (!s || s.archived) { this.sessions.get(root)!.delete(id); continue; }
      this.refresh(s);
    }
    return null;
  }

  // The projects the owner has to do with: those of the sessions given servers, and those decided before.
  projects(): ProjectState[] {
    const roots = new Set<string>([...this.sessions.keys(), ...this.store.db.query<{ root: string }, []>("SELECT DISTINCT root FROM mcp_project_pins").all().map((r) => r.root)]);
    return [...roots].sort().map((root) => { const { file, at } = this.whereOf(root); const { configs: _, ...st } = this.state(root, file, at); return st; }).filter((p) => p.file || p.servers.length);
  }

  // Where a project's file was last found (a worktree's own), else its key's own folder.
  private where = new Map<string, { file: string | null; at: string }>();
  private whereOf(root: string): { file: string | null; at: string } {
    const w = this.where.get(root);
    if (w && (!w.file || existsSync(w.file))) return w;
    const p = projectFile(root);
    return { file: p.root === root ? p.file : null, at: root };
  }

  forgetSession(id: string) {
    for (const set of this.sessions.values()) set.delete(id);
    this.told.delete(id);
  }
}
