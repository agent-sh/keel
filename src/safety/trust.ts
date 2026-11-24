// Trust of a repository's own files: its instruction files (AGENTS.md and the
// like, from the repository root down to the session's folder) and its skills
// (its hook file is pinned by the hooks module, routes/hooks.ts). Each is pinned by the SHA-256 of its
// content; a file loads only while it matches its pin. A changed file is
// quarantined until the owner trusts it again: an instruction file falls back
// to the content last trusted, a skill does not load. New ones are pinned on
// first sight unless the owner asks to review new ones too.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { contains, realOf, homeDir } from "../core/paths.ts";
import { dirname, join, relative } from "node:path";
import type { Store } from "../core/store.ts";
import { timed } from "../admin/stall.ts";
import { instructionNames } from "./instruction-files.ts";
import { codexConfig, nativeRoots } from "../engine/native-memory.ts";
import { headHold } from "./head-trust.ts";

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
  refused?: string;       // why a skill cannot be pinned (more than the scan reads): it does not load, and is not trusted
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trust_pins (path TEXT PRIMARY KEY, kind TEXT NOT NULL, root TEXT NOT NULL, sha TEXT NOT NULL, content TEXT, auto INTEGER NOT NULL DEFAULT 0, trusted INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS trust_pins_root ON trust_pins(root);
CREATE TABLE IF NOT EXISTS trust_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_told (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_servers (root TEXT PRIMARY KEY, auto INTEGER NOT NULL DEFAULT 0, trusted INTEGER NOT NULL);
`;
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

// The folder a pinned file belongs to: a skill's three levels up, an instruction file's own folder
// (the one above its `.claude` for a name that lives there).
function folderOf(path: string, kind: TrustKind, names: readonly string[]): string {
  if (kind === "skill") return dirname(dirname(dirname(path)));
  const n = names.find((x) => x.includes("/") && path.endsWith(`/${x}`));
  return n ? path.slice(0, path.length - n.length - 1) : dirname(path);
}

// The repository root of a folder: the nearest ancestor with .git, never the home itself.
export function rootOf(dir: string): string | null {
  const home = homeDir();
  for (let d = dir; ; d = dirname(d)) {
    if (d !== home && existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

// A file's SHA-256, read again only when the file is no longer the one hashed:
// another inode, size, or change time (nanoseconds). The change time is the
// kernel's (a write or a utime call sets it to now), so a file edited and given
// its old modification time back is read again. A file changed in the last two
// seconds is not kept (a write in the same tick as the hash would look the same,
// as git's racily clean entries). Bounded: the oldest go first.
// (`hashing`: how many files were read, and the window, for the tests.)
const HASHED_MAX = 20_000;
const hashed = new Map<string, { key: string; sha: string }>();
export const hashing = { reads: 0, racyMs: 2_000 };
function fileSha(p: string): string {
  const st = statSync(p, { bigint: true });
  const key = `${st.dev}:${st.ino}:${st.size}:${st.ctimeNs}:${st.mtimeNs}`;
  const kept = hashed.get(p);
  if (kept?.key === key) return kept.sha;
  hashing.reads++;
  const h = sha(readFileSync(p));
  hashed.delete(p);
  if (Date.now() - Number(st.ctimeMs) >= hashing.racyMs) hashed.set(p, { key, sha: h });
  if (hashed.size > HASHED_MAX) hashed.delete(hashed.keys().next().value!);
  return h;
}

// A skill folder's digest: each file's path and content; a link's path, where
// it points and the content it lands on, so retargeting a link changes the
// digest. A link that lands outside the skill is named in `outside`: such a
// skill does not load (what it runs is not the skill's to pin). Hook events
// ask for it (a repository skill's hooks run only while it is trusted as it is
// now), so a file's content is hashed again only when it changed (fileSha).
// The scan reads SKILL_SCAN.files files and links, SKILL_SCAN.depth folders down and files of SKILL_SCAN.bytes at
// most. A folder with more is `refused`: a digest of part of it would leave out files its hooks and scripts can run
// (${CLAUDE_SKILL_DIR}/...), and a change there would load as trusted.
export const SKILL_SCAN = { files: 400, depth: 4, bytes: 2_000_000 };
type Scan = { digest: string; outside: string[]; refused?: string };
function skillScan(dir: string): Scan | null {
  return timed(() => `trust: scan skill ${relative(homeDir(), dir)}`, () => scanSkill(dir));
}
function scanSkill(dir: string): Scan | null {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const parts: string[] = [];
  const outside: string[] = [];
  let refused: string | undefined;
  const top = realOf(dir);
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    if (depth > SKILL_SCAN.depth) { if (names.length) refused = `it nests folders more than ${SKILL_SCAN.depth} deep (${relative(dir, d)}), deeper than Keel reads to pin a skill`; return; }
    for (const n of names) {
      if (refused) return;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      if (parts.length >= SKILL_SCAN.files) { refused = `it holds more than ${SKILL_SCAN.files} files, more than Keel reads to pin a skill`; return; }
      if (st.isFile() && st.size > SKILL_SCAN.bytes) { refused = `it holds ${relative(dir, p)}, a file over ${SKILL_SCAN.bytes / 1_000_000} MB, larger than Keel reads to pin a skill`; return; }
      if (st.isFile()) parts.push(`${relative(dir, p)}\0${fileSha(p)}`);
      else {
        let target = "";
        try { target = readlinkSync(p); } catch {}
        const lands = realOf(p);
        if (!contains(top, lands)) { outside.push(relative(dir, p)); parts.push(`${relative(dir, p)}\0link\0${target}\0outside`); continue; }
        let body = "missing";
        try { const t = statSync(lands); body = t.isFile() && t.size <= SKILL_SCAN.bytes ? fileSha(lands) : t.isDirectory() ? "dir" : "large"; } catch {}
        parts.push(`${relative(dir, p)}\0link\0${target}\0${body}`);
      }
    }
  };
  walk(dir, 0);
  return { digest: sha(parts.join("\n")), outside, ...(refused ? { refused: `This skill cannot be trusted: ${refused}. Move what it does not need out of its folder.` } : {}) };
}

// A skill's digest as it is on disk now: a command file's content, a folder's scan.
// (null for a folder past what the scan reads: such a skill is never trusted, SKILL_SCAN.)
export function skillDigest(dir: string): string | null {
  if (dir.endsWith(".md")) return commandDigest(dir);
  const scan = skillScan(dir);
  return scan && !scan.refused ? scan.digest : null;
}

// A command file (<repo>/.claude/commands/<name>.md): its content.
function commandDigest(p: string): string | null {
  try { const st = statSync(p); return st.isFile() ? fileSha(p) : null; } catch { return null; }
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

  // Whether the session is owed the note about files held for the owner: not when it was already told of
  // these files at these contents (each file by its path, state and hash), so a restart of the daemon, which
  // makes every session's prompt again, tells nothing twice. A change of a file, or another file held, is
  // a new key. Taking it records it.
  owesNote(sessionId: string, held: readonly { path: string; state: string; sha256: string | null }[]): boolean {
    if (!held.length) { this.store.db.query("DELETE FROM trust_told WHERE session_id = ?").run(sessionId); return false; } // trusted since: a later hold is news again
    const key = sha(held.map((f) => `${f.path}\0${f.state}\0${f.sha256 ?? ""}`).sort().join("\n"));
    const told = this.store.db.query<{ key: string }, [string]>("SELECT key FROM trust_told WHERE session_id = ?").get(sessionId)?.key;
    if (told === key) return false;
    this.store.db.query("INSERT INTO trust_told (session_id, key) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET key = excluded.key").run(sessionId, key);
    return true;
  }

  // The project files that apply in `cwd`, as they are now, each with its state.
  // First sight pins what may be pinned on first sight.
  files(cwd: string): ProjectFile[] {
    const root = rootOf(cwd);
    if (!root) return [];
    const found: { path: string; kind: TrustKind; digest: string | null; content?: string; outside?: string[]; refused?: string }[] = [];
    const dirs: string[] = [];
    const names = instructionNames(codexConfig(nativeRoots()).fallback);
    for (let d = cwd; ; d = dirname(d)) {
      dirs.unshift(d);
      if (d === root || dirname(d) === d) break;
    }
    for (const d of dirs) {
      // Every file a family's chain can load from the folder is pinned (src/safety/instruction-files.ts).
      for (const n of names) {
        const p = join(d, n);
        try {
          if (!statSync(p).isFile()) continue;
          const text = readFileSync(p, "utf8");
          if (!text.trim()) continue;
          found.push({ path: p, kind: "instructions", digest: sha(text), content: text });
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
          if (scan) found.push({ path: dir, kind: "skill", digest: scan.digest, ...(scan.outside.length ? { outside: scan.outside } : {}), ...(scan.refused ? { refused: scan.refused } : {}) });
        }
      }
    }
    const out: ProjectFile[] = [];
    // (A tree whose head is held pins nothing on first sight: its files wait for the owner to trust the head.)
    const auto = this.newFiles() === "auto" && !headHold.of?.(root);
    for (const f of found) {
      const p = this.pin(f.path);
      // (A skill past what the scan reads is never trusted: not on first sight, not by its old pin.)
      if (f.refused) { out.push({ path: f.path, kind: f.kind, root, sha256: f.digest, state: p ? "changed" : "new", pinned_sha256: p?.sha, trusted_ms: p?.trusted, auto: p ? !!p.auto : undefined, refused: f.refused }); continue; }
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
      if (seen.has(r.path) || !dirs.includes(folderOf(r.path, r.kind as TrustKind, names))) continue;
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
    // The head of a pull request nobody vouched for: the base branch's file of that name, never the head's own.
    const head = headHold.of?.(path);
    if (head) return head.base(path);
    const st = this.check(path, "instructions", sha(text), text);
    if (st === "trusted") return text;
    if (st === "changed") return this.pin(path)?.content ?? null;
    return null;
  }

  skillAllowed(dir: string): boolean {
    return this.skillHeld(dir) === null;
  }
  // Why a repository's skill does not load, in words for the model and the owner; null when it loads.
  skillHeld(dir: string): string | null {
    if (!rootOf(dir)) return null;
    if (headHold.of?.(dir)) return "it is in the head of a pull request from a fork, which nobody the repository trusts wrote: the owner trusts the head on the session's chip first";
    const state = (digest: string) => {
      const st = this.check(dir, "skill", digest, null);
      return st === "trusted" ? null : st === "changed" ? "it changed since the owner trusted it, and waits for him to trust it again (the session's Trust panel)" : "it is new in this repository, and waits for the owner to trust it (the session's Trust panel)";
    };
    if (dir.endsWith(".md")) { const d = commandDigest(dir); return d ? state(d) : null; }
    const scan = skillScan(dir);
    if (!scan) return null;
    if (scan.refused) return scan.refused;
    if (scan.outside.length) return `it links to files outside its folder (${scan.outside.slice(0, 3).join(", ")}), which Keel does not load`;
    return state(scan.digest);
  }

  // Whether the owner pinned a project skill himself, as it is now: what a
  // skill may grant beyond its text (its allowed-tools) needs that. A pin made
  // on first sight (auto) lets a skill load, never grant itself tools.
  skillOwnerTrusted(dir: string): boolean {
    return this.skillOwnerDigest(dir) !== null;
  }
  // The digest the owner pinned a project skill at himself, while the skill
  // is still that on disk; else null.
  skillOwnerDigest(dir: string): string | null {
    if (headHold.of?.(dir)) return null;
    const digest = skillDigest(dir);
    if (!digest) return null;
    const p = this.pin(dir);
    return p && !p.auto && p.sha === digest ? digest : null;
  }

  // The owner trusts a file of `cwd` at the content shown to them (the digest they saw).
  trust(cwd: string, path: string, digest: string): ProjectFile {
    const f = this.files(cwd).find((x) => x.path === path);
    if (!f) throw Object.assign(new Error("no such project file in that folder"), { status: 404 });
    if (headHold.of?.(path)) throw Object.assign(new Error("this folder is the head of a pull request from a fork: trust the head on the session's chip first"), { status: 409 });
    if (f.state === "gone") {
      this.store.db.query("DELETE FROM trust_pins WHERE path = ?").run(path);
      return f;
    }
    if (f.refused) throw Object.assign(new Error(f.refused), { status: 422 });
    if (f.sha256 !== digest) throw Object.assign(new Error("the file changed since it was shown: look at it again"), { status: 409 });
    this.setPin(f, digest, f.kind === "instructions" ? readFileSync(path, "utf8") : null, false);
    return { ...f, state: "trusted", pinned_sha256: digest, trusted_ms: Date.now(), auto: false };
  }

  // The last trusted text (for the diff the owner reads before trusting).
  pinnedText(path: string): string | null {
    return this.pin(path)?.content ?? null;
  }

  // Whether the owner trusted a folder's language servers in so many words.
  // A server whose program is a file of the folder, or that loads its code,
  // runs that folder's code as the owner; so this is never given on first
  // sight, a folder that is no repository is not trusted for being none, and
  // asking changes nothing. Kept by the repository root, else by the folder.
  serversTrusted(dir: string): { root: string; trusted: boolean } {
    const root = rootOf(dir) ?? dir;
    const r = this.store.db.query<{ auto: number }, [string]>("SELECT auto FROM trust_servers WHERE root = ? AND auto = 0").get(root);
    return { root, trusted: !!r };
  }
  trustServers(dir: string, on = true): { root: string; trusted: boolean } {
    const root = rootOf(dir) ?? dir;
    if (on) this.store.db.query("INSERT INTO trust_servers (root, auto, trusted) VALUES (?, 0, ?) ON CONFLICT(root) DO UPDATE SET auto = 0, trusted = excluded.trusted").run(root, Date.now());
    else this.store.db.query("DELETE FROM trust_servers WHERE root = ?").run(root);
    return this.serversTrusted(dir);
  }

  roots(): string[] {
    return this.store.db.query<{ root: string }, []>("SELECT DISTINCT root FROM trust_pins").all().map((r) => r.root);
  }
}
