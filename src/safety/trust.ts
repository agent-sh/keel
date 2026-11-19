// Trust of a repository's own files: its instruction files (AGENTS.md and the
// like, from the repository root down to the session's folder) and its skills
// (its hook file is pinned by the hooks module, routes/hooks.ts). Each is pinned by the SHA-256 of its
// content; a file loads only while it matches its pin. A changed file is
// quarantined until the owner trusts it again: an instruction file falls back
// to the content last trusted, a skill does not load. New ones are pinned on
// first sight unless the owner asks to review new ones too.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { contains, realOf } from "../core/paths.ts";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Store } from "../core/store.ts";

export type TrustKind = "instructions" | "skill";
export type ProjectFile = {
  path: string;           // the file (a skill: its folder)
  kind: TrustKind;
  root: string;           // the repository it belongs to
  sha256: string | null;  // null: gone
  state: "trusted" | "new" | "changed" | "gone";
  pinned_sha256?: string;
  trusted_ms?: number;
  auto?: boolean;         // pinned on first sight, not by the owner
  outside?: string[];     // a skill's links that land outside it: it does not load
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trust_pins (path TEXT PRIMARY KEY, kind TEXT NOT NULL, root TEXT NOT NULL, sha TEXT NOT NULL, content TEXT, auto INTEGER NOT NULL DEFAULT 0, trusted INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trust_pins_root ON trust_pins(root);
CREATE TABLE IF NOT EXISTS trust_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"]; // as the system prompt loads them
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// The repository root of a folder: the nearest ancestor with .git, never the home itself.
export function rootOf(dir: string): string | null {
  const home = homedir();
  for (let d = dir; ; d = dirname(d)) {
    if (d !== home && existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

// A skill folder's digest: each file's path and content; a link's path, where
// it points and the content it lands on, so retargeting a link changes the
// digest. A link that lands outside the skill is named in `outside`: such a
// skill does not load (what it runs is not the skill's to pin).
function skillScan(dir: string): { digest: string; outside: string[] } | null {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const parts: string[] = [];
  const outside: string[] = [];
  const top = realOf(dir);
  const walk = (d: string, depth: number) => {
    if (depth > 4 || parts.length > 400) return;
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && st.size <= 2_000_000) parts.push(`${relative(dir, p)}\0${sha(readFileSync(p))}`);
      else if (st.isSymbolicLink()) {
        let target = "";
        try { target = readlinkSync(p); } catch {}
        const lands = realOf(p);
        if (!contains(top, lands)) { outside.push(relative(dir, p)); parts.push(`${relative(dir, p)}\0link\0${target}\0outside`); continue; }
        let body = "missing";
        try { const t = statSync(lands); body = t.isFile() && t.size <= 2_000_000 ? sha(readFileSync(lands)) : t.isDirectory() ? "dir" : "large"; } catch {}
        parts.push(`${relative(dir, p)}\0link\0${target}\0${body}`);
      }
    }
  };
  walk(dir, 0);
  return { digest: sha(parts.join("\n")), outside };
}

// A command file (<repo>/.claude/commands/<name>.md): its content.
function commandDigest(p: string): string | null {
  try { return statSync(p).isFile() ? sha(readFileSync(p)) : null; } catch { return null; }
}

export class Trust {
  constructor(private store: Store) {
    store.migrate(SCHEMA);
  }

  // "auto": new instruction files and skills are pinned on first sight; "ask": they wait too.
  newFiles(): "auto" | "ask" {
    return this.store.db.query<{ value: string }, []>("SELECT value FROM trust_settings WHERE key = 'new_files'").get()?.value === "ask" ? "ask" : "auto";
  }
  setNewFiles(v: "auto" | "ask") {
    this.store.db.query("INSERT INTO trust_settings (key, value) VALUES ('new_files', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  }

  private pin(path: string) {
    return this.store.db.query<{ path: string; kind: string; root: string; sha: string; content: string | null; auto: number; trusted: number }, [string]>("SELECT * FROM trust_pins WHERE path = ?").get(path);
  }
  private setPin(f: { path: string; kind: TrustKind; root: string }, digest: string, content: string | null, auto: boolean) {
    this.store.db.query("INSERT INTO trust_pins (path, kind, root, sha, content, auto, trusted) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, content = excluded.content, auto = excluded.auto, trusted = excluded.trusted")
      .run(f.path, f.kind, f.root, digest, content, auto ? 1 : 0, Date.now());
  }

  // The project files that apply in `cwd`, as they are now, each with its state.
  // First sight pins what may be pinned on first sight.
  files(cwd: string): ProjectFile[] {
    const root = rootOf(cwd);
    if (!root) return [];
    const found: { path: string; kind: TrustKind; digest: string | null; content?: string; outside?: string[] }[] = [];
    const dirs: string[] = [];
    for (let d = cwd; ; d = dirname(d)) {
      dirs.unshift(d);
      if (d === root || dirname(d) === d) break;
    }
    for (const d of dirs) {
      for (const n of INSTRUCTION_NAMES) {
        const p = join(d, n);
        try {
          if (!statSync(p).isFile()) continue;
          const text = readFileSync(p, "utf8");
          if (!text.trim()) continue;
          found.push({ path: p, kind: "instructions", digest: sha(text), content: text });
          break;
        } catch {}
      }
      // Command files are skills in the older form: each file is pinned.
      for (const n of (() => { try { return readdirSync(join(d, ".claude/commands")).sort(); } catch { return []; } })()) {
        const p = join(d, ".claude/commands", n);
        if (!n.endsWith(".md")) continue;
        const digest = commandDigest(p);
        if (digest) found.push({ path: p, kind: "skill", digest });
      }
      for (const sub of [".agents/skills", ".claude/skills"]) {
        let names: string[] = [];
        try { names = readdirSync(join(d, sub)); } catch { continue; }
        for (const n of names.sort()) {
          const dir = join(d, sub, n);
          const scan = skillScan(dir);
          if (scan) found.push({ path: dir, kind: "skill", digest: scan.digest, ...(scan.outside.length ? { outside: scan.outside } : {}) });
        }
      }
    }
    const out: ProjectFile[] = [];
    const auto = this.newFiles() === "auto";
    for (const f of found) {
      const p = this.pin(f.path);
      if (!p && auto) {
        this.setPin({ path: f.path, kind: f.kind, root }, f.digest!, f.kind === "instructions" ? f.content! : null, true);
        out.push({ path: f.path, kind: f.kind, root, sha256: f.digest, state: "trusted", pinned_sha256: f.digest!, trusted_ms: Date.now(), auto: true, ...(f.outside ? { outside: f.outside } : {}) });
        continue;
      }
      out.push({
        path: f.path, kind: f.kind, root, sha256: f.digest,
        state: !p ? "new" : p.sha === f.digest ? "trusted" : "changed",
        pinned_sha256: p?.sha, trusted_ms: p?.trusted, auto: p ? !!p.auto : undefined, ...(f.outside ? { outside: f.outside } : {}),
      });
    }
    // Pinned files of the folders on the way that are gone now.
    const seen = new Set(found.map((f) => f.path));
    for (const r of this.store.db.query<{ path: string; kind: string; sha: string; trusted: number }, [string]>("SELECT path, kind, sha, trusted FROM trust_pins WHERE root = ?").all(root)) {
      if (seen.has(r.path) || !dirs.includes(r.kind === "skill" ? dirname(dirname(dirname(r.path))) : dirname(r.path))) continue;
      out.push({ path: r.path, kind: r.kind as TrustKind, root, sha256: null, state: "gone", pinned_sha256: r.sha, trusted_ms: r.trusted });
    }
    return out;
  }

  // One file against its pin, as it is now. First sight pins what may be pinned then.
  private check(path: string, kind: TrustKind, digest: string, content: string | null): "trusted" | "new" | "changed" {
    const p = this.pin(path);
    if (p) return p.sha === digest ? "trusted" : "changed";
    if (this.newFiles() === "auto") {
      this.setPin({ path, kind, root: rootOf(dirname(path)) ?? dirname(path) }, digest, content, true);
      return "trusted";
    }
    return "new";
  }

  // What an instruction file contributes: its text when trusted, the text last
  // trusted when it changed, nothing when it is new and waits for the owner.
  instructionText(path: string, text: string): string | null {
    const root = rootOf(dirname(path));
    if (!root || !path.startsWith(root + "/")) return text; // the owner's own files, outside any repository
    const st = this.check(path, "instructions", sha(text), text);
    if (st === "trusted") return text;
    if (st === "changed") return this.pin(path)?.content ?? null;
    return null;
  }

  skillAllowed(dir: string): boolean {
    if (!rootOf(dir)) return true;
    if (dir.endsWith(".md")) { const d = commandDigest(dir); return !d || this.check(dir, "skill", d, null) === "trusted"; }
    const scan = skillScan(dir);
    if (!scan) return true;
    if (scan.outside.length) return false;
    return this.check(dir, "skill", scan.digest, null) === "trusted";
  }

  // The owner trusts a file of `cwd` at the content shown to them (the digest they saw).
  trust(cwd: string, path: string, digest: string): ProjectFile {
    const f = this.files(cwd).find((x) => x.path === path);
    if (!f) throw Object.assign(new Error("no such project file in that folder"), { status: 404 });
    if (f.state === "gone") {
      this.store.db.query("DELETE FROM trust_pins WHERE path = ?").run(path);
      return f;
    }
    if (f.sha256 !== digest) throw Object.assign(new Error("the file changed since it was shown: look at it again"), { status: 409 });
    this.setPin(f, digest, f.kind === "instructions" ? readFileSync(path, "utf8") : null, false);
    return { ...f, state: "trusted", pinned_sha256: digest, trusted_ms: Date.now(), auto: false };
  }

  // The last trusted text (for the diff the owner reads before trusting).
  pinnedText(path: string): string | null {
    return this.pin(path)?.content ?? null;
  }

  roots(): string[] {
    return this.store.db.query<{ root: string }, []>("SELECT DISTINCT root FROM trust_pins").all().map((r) => r.root);
  }
}
