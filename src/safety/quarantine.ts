// Protected paths: files a repository runs or reads its configuration from
// later, outside any sandbox (git hooks, direnv, the project's hook and MCP
// files, editor tasks, package manager settings). A call the owner did not
// answer on a card may not create or change one: after it ran, a protected
// file it created or changed is moved out of the workspace into a quarantine
// batch (a changed one gets its previous content back), the model is told,
// and the owner restores or discards the batch.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Store } from "../core/store.ts";

const FILES = [".envrc", ".mcp.json", ".npmrc", ".pypirc", ".gitattributes", ".gitmodules", ".keel/hooks.json", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", ".gemini/settings.json", ".vscode/tasks.json", ".vscode/settings.json", ".vscode/launch.json"];
const DIRS = [".git/hooks", ".husky", ".githooks"];
const MAX = 256 * 1024;

export type Snap = Map<string, { sha: string; content: Buffer | null }>;
export type Batch = { id: string; session_id: string; root: string; created: number; paths: string[]; bytes: number; state: "held" | "restored" | "discarded"; dir: string };

const SCHEMA = `CREATE TABLE IF NOT EXISTS quarantine (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS quarantine_session ON quarantine(session_id, created);`;

// The protected files under `root` now, each with its hash (and content when small).
export function snapshot(root: string): Snap {
  const out: Snap = new Map();
  const take = (rel: string) => {
    const p = join(root, rel);
    try {
      const st = lstatSync(p);
      if (!st.isFile() && !st.isSymbolicLink()) return;
      const b = st.isSymbolicLink() ? Buffer.from(`link\0${p}`) : readFileSync(p);
      out.set(rel, { sha: createHash("sha256").update(b).digest("hex"), content: st.isFile() && st.size <= MAX ? b : null });
    } catch {}
  };
  for (const f of FILES) take(f);
  // Keel's own configuration, where the owner keeps a file of it inside this folder (KEEL_HOOKS and its kin).
  for (const f of [process.env.KEEL_HOOKS, process.env.KEEL_MCP_CONFIG, process.env.KEEL_ACP_AGENTS, process.env.KEEL_ACP_FOLDERS]) {
    if (!f) continue;
    const rel = relative(root, f);
    if (rel && !rel.startsWith("..") && !rel.startsWith("/")) take(rel);
  }
  for (const d of DIRS) {
    let names: string[] = [];
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const n of names) take(join(d, n));
  }
  return out;
}

export class Quarantine {
  constructor(private store: Store, private dir: string) {
    store.migrate(SCHEMA);
  }

  list(sessionId?: string): Batch[] {
    const rows = sessionId
      ? this.store.db.query<{ data: string }, [string]>("SELECT data FROM quarantine WHERE session_id = ? ORDER BY created DESC").all(sessionId)
      : this.store.db.query<{ data: string }, []>("SELECT data FROM quarantine ORDER BY created DESC LIMIT 200").all();
    return rows.map((r) => JSON.parse(r.data));
  }
  get(id: string): Batch | undefined {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM quarantine WHERE id = ?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  }
  private save(b: Batch) {
    this.store.db.query("INSERT INTO quarantine (id, session_id, created, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(b.id, b.session_id, b.created, JSON.stringify(b));
    return b;
  }

  // After a call: what it created or changed among the protected files goes to
  // a batch. Returns the batch, or null when nothing protected changed.
  sweep(sessionId: string, root: string, before: Snap): Batch | null {
    const after = snapshot(root);
    const moved: string[] = [];
    const id = crypto.randomUUID();
    const created = Date.now();
    const dir = join(this.dir, sessionId, `${created}-${id.slice(0, 8)}`);
    let bytes = 0;
    for (const [rel, now] of after) {
      const was = before.get(rel);
      if (was && was.sha === now.sha) continue;
      if (was && !was.content) continue; // a large file changed: there is nothing to put back, leave it
      const src = join(root, rel);
      const dst = join(dir, rel);
      try {
        // Only a file in its place, not a link to elsewhere: a parent that is a link is left alone.
        if (lstatSync(dirname(src)).isSymbolicLink()) continue;
        mkdirSync(dirname(dst), { recursive: true });
        bytes += lstatSync(src).size;
        renameSync(src, dst);
        if (was?.content) writeFileSync(src, was.content); // a changed file gets its previous content back
        moved.push(rel);
      } catch {}
    }
    if (!moved.length) return null;
    return this.save({ id, session_id: sessionId, root, created, paths: moved, bytes, state: "held", dir });
  }

  // The owner puts the quarantined files back where they were.
  restore(id: string): Batch {
    const b = this.get(id);
    if (!b) throw Object.assign(new Error("no such quarantine batch"), { status: 404 });
    if (b.state !== "held") throw Object.assign(new Error(`the batch is ${b.state}`), { status: 409 });
    for (const rel of b.paths) {
      const src = join(b.dir, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(b.root, rel)), { recursive: true });
      cpSync(src, join(b.root, rel), { force: true });
    }
    rmSync(b.dir, { recursive: true, force: true });
    return this.save({ ...b, state: "restored" });
  }

  // The owner discards exactly one batch.
  discard(id: string): Batch {
    const b = this.get(id);
    if (!b) throw Object.assign(new Error("no such quarantine batch"), { status: 404 });
    if (b.state !== "held") throw Object.assign(new Error(`the batch is ${b.state}`), { status: 409 });
    if (!relative(this.dir, b.dir).startsWith("..")) rmSync(b.dir, { recursive: true, force: true });
    return this.save({ ...b, state: "discarded" });
  }

  // A file of a batch, to read before restoring.
  read(id: string, rel: string): string {
    const b = this.get(id);
    if (!b || !b.paths.includes(rel)) throw Object.assign(new Error("no such file in the batch"), { status: 404 });
    const p = join(b.dir, rel);
    if (!existsSync(p) || statSync(p).size > MAX) return "";
    return readFileSync(p, "utf8");
  }
}
