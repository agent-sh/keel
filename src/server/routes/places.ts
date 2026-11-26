// Where a session works: move it to another folder (optionally copying its
// files and making the folder a repository), clone it into a new folder or a
// worktree of its own, open one of its files in the owner's editor, serve an
// image from its folder, and the repositories the folder picker offers.
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { heldFile } from "../../core/store-files.ts";
import { gitSync } from "../../core/git.ts";
import { contains, homeDir } from "../../core/paths.ts";
import type { Session } from "../../core/types.ts";
import { instructionFilter, instructionPaths } from "../../engine/turn.ts";
import { jobsOf, running, toolEnv } from "../../tools/jobs.ts";
import { GitError, Worktrees } from "../../worktree/manager.ts";
import { lineage } from "../../core/tree.ts";
import type { RouteModule } from "../app.ts";
import { outsideRefusal } from "../../core/watch.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const HOME = homeDir();
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, HOME));
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isRepo = (p: string) => existsSync(join(p, ".git"));

// The instruction files of `to` (every session's chain: engine/turn.ts instructionPaths) that the
// session's prompt does not carry yet: those of the folders `from` does not share. Applied through the
// same filter as the prompt.
export function newInstructions(to: string, from: string): string {
  const chain = (dir: string) => instructionPaths(dir).filter((f) => f.scope !== "owner").map((f) => f.path);
  const had = new Set(chain(from));
  return chain(to).filter((p) => !had.has(p)).map((p) => {
    try {
      const raw = readFileSync(p, "utf8");
      const text = instructionFilter.file ? instructionFilter.file(p, raw) : raw;
      return text === null ? "" : `# ${p}\n\n${text.slice(0, 40_000)}`;
    } catch { return ""; }
  }).filter(Boolean).join("\n\n");
}

// Files under `src` a copy would write, relative; symlinks are left out.
function filesOf(src: string, out: string[] = [], rel = ""): string[] {
  for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) filesOf(src, out, r);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// What POST /api/open runs, and what it opens. A configured command
// (KEEL_OPEN_COMMAND, else KEEL_EDITOR) is a template: {path} and {line} are
// filled, the path is appended when it names neither. Else the owner's
// $VISUAL or $EDITOR when it is an editor with a window of its own. Else the
// folder that holds the file, in the desktop's file manager: the desktop's
// opener would hand a model-written file to whatever program its type has
// (a browser for an HTML file, with its scripts).
const GUI_EDITORS = new Set(["code", "code-insiders", "codium", "cursor", "windsurf", "zed", "zeditor", "subl", "gedit", "gnome-text-editor", "kate", "kwrite", "mousepad", "xed", "pulsar", "idea", "pycharm", "webstorm", "clion", "rustrover", "goland"]);
export function openPlan(env: Record<string, string | undefined>, path: string, line?: number): { argv: string[]; opened: "file" | "folder" } {
  const l = String(Math.max(1, Math.floor(line ?? 1)));
  const tpl = (env.KEEL_OPEN_COMMAND ?? env.KEEL_EDITOR ?? "").split(/\s+/).filter(Boolean);
  if (tpl.length) {
    const argv = tpl.map((a) => a.replaceAll("{path}", path).replaceAll("{line}", l));
    if (!tpl.some((a) => a.includes("{path}"))) argv.push(path);
    return { argv, opened: "file" };
  }
  const ed = (env.VISUAL || env.EDITOR || "").split(/\s+/).filter(Boolean);
  if (ed.length && GUI_EDITORS.has(basename(ed[0]!))) {
    // VS Code and its forks take path:line with -g; the others get the path.
    const vs = /^(code|code-insiders|codium|cursor|windsurf)$/.test(basename(ed[0]!));
    return { argv: vs ? [...ed, "-g", `${path}:${l}`] : [...ed, path], opened: "file" };
  }
  return { argv: [process.platform === "darwin" ? "open" : "xdg-open", dirname(path)], opened: "folder" };
}

// The image kinds served raw, by their first bytes (never by the name).
export function imageKind(head: Uint8Array): string | null {
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return "image/gif";
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return "image/webp";
  return null;
}

type AgentMove = { id: string; title: string; why: string };
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const placesRoutes: RouteModule = ({ store, bus, engine, workspace }) => {
  const wts = new Worktrees(store, join(store.stateDir, "worktrees"));
  const emit = (id: string) => { const s = store.session(id); if (s) bus.emit({ t: "session", session: s }); return s; };
  const note = (id: string, data: unknown) => bus.emit({ t: "event", event: store.append(id, "note", data) });

  // The real path of `raw` when it is an existing file inside the session's
  // folder (through symlinks and `..`), else a refusal.
  const fileOf = (s: Session, raw: string | null): string | Response => {
    if (!raw?.trim()) return bad("path is empty");
    let root: string;
    try { root = realpathSync(s.workspace); } catch { return bad("the session's folder is gone", 404); }
    let real: string;
    try { real = realpathSync(resolve(root, raw)); } catch { return bad("no such file in the session's folder", 404); }
    if (!contains(root, real)) return bad("the file is outside the session's folder", 403);
    if (contains(store.stateDir, real)) return bad("that is the daemon's own state", 403);
    if (!statSync(real).isFile()) return bad("not a file");
    return real;
  };

  // The agents below a session that a move of its folder takes along: those
  // working in the folder it leaves (they were started with no worktree or
  // place of their own, so they took their parent's). The others stay, with
  // the reason: a worktree, another machine, or a folder of their own.
  const agentsOfMove = (id: string, from: string): { moved: AgentMove[]; stayed: AgentMove[] } => {
    const out = { moved: [] as AgentMove[], stayed: [] as AgentMove[] };
    for (const d of store.descendants(id)) {
      const a = store.session(d);
      if (!a) continue;
      const m = { id: a.id, title: a.title };
      if (a.machine) out.stayed.push({ ...m, why: "on another machine" });
      else if (wts.get(a.id)?.state === "active") out.stayed.push({ ...m, why: "in its worktree" });
      else if (a.workspace === from) out.moved.push({ ...m, why: "same folder" });
      else out.stayed.push({ ...m, why: "in its own folder" });
    }
    return out;
  };

  // A copy of the session's current branch as a new session (`clone`), in
  // `cwd` or a fresh worktree of its repository when asked.
  const clone = async (s: Session, b: any) => {
    let cwd = s.workspace;
    if (b.cwd) {
      cwd = expand(String(b.cwd));
      if (!isDir(cwd)) throw Object.assign(new Error(`not a directory: ${cwd}`), { status: 400 });
    }
    const line = lineage(store.events(s.id), s.head);
    const titles = new Set(store.sessions().concat(store.sessions({ archived: true })).map((x) => x.title));
    const base = b.title ? String(b.title).trim() : `${s.title || "Session"} (clone`;
    let title = b.title ? base : `${base})`;
    for (let n = 2; !b.title && titles.has(title); n++) title = `${base} ${n})`;
    // Marks belong to the source: the copy keeps its tags and settings, not its pin or done.
    // (The owner's switch for compaction by price is his choice for that session, with its numbers since: the copy starts without it.)
    const { pinned_ms: _p, done_ms: _d, repairs: _r, owner_compact_by_price: _o, owner_compact_by_price_on_ms: _on, owner_compact_by_price_off_ms: _off, ...settings } = s.settings; // (its repairs are recorded as its own)
    const c = store.createSession({ title, model: s.model, workspace: cwd, settings });
    try {
      if (b.worktree) {
        const { wt, cwd: wcwd } = await wts.create(c.id, cwd, b.worktree.name || title, b.worktree.base);
        wts.adopt(c.id, wt);
        store.updateSession(c.id, { workspace: wcwd });
      }
    } catch (e) {
      store.deleteSession(c.id);
      throw e;
    }
    const copy = line.filter((e) => e.kind !== "turn_start" || line.at(-1) !== e);
    store.copyEvents(c.id, copy);
    if (cwd !== s.workspace || b.worktree) {
      const now = store.session(c.id)!;
      const inst = newInstructions(now.workspace, s.workspace);
      note(c.id, { kind: "folder", model: true, short: `Cloned into ${now.workspace}`, text: `[harness] This session was cloned into ${now.workspace} (the conversation so far ran in ${s.workspace}). Work there now.${inst ? `\n\nInstructions from the owner's files there:\n\n${inst}` : ""}` });
    }
    return { session: emit(c.id)!, events_copied: copy.length };
  };

  return {
    // Move the session and go on in the same conversation. The system prompt
    // stays as it was (its cache holds); a note the model reads names the new
    // folder and carries that folder's instruction files.
    "/api/sessions/:id/folder": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        if (b.cwd === undefined && !b.copy_files && !b.init_git) return bad("give cwd, copy_files or init_git");
        if (s.machine) return bad("this session works on another machine; move it there", 400);
        if (engine.isRunning(s.id)) return bad("a turn is running: move the session when it has ended", 409);
        const jobs = jobsOf(s.id).filter(running);
        if (jobs.length && b.cwd !== undefined) return bad(`the session still runs ${jobs.map((j) => j.command.slice(0, 60)).join("; ")} in its folder: stop ${jobs.length > 1 ? "them" : "it"} first`, 409);
        const from = s.workspace;
        const to = b.cwd !== undefined ? expand(String(b.cwd)) : from;
        if (!isDir(to)) return bad(`not a directory: ${to}`);
        let copied = 0;
        if (b.copy_files && to !== from) {
          if (contains(from, to) || contains(to, from)) return bad("one folder holds the other: copy into a folder beside it");
          const files = filesOf(from);
          const clash = files.filter((f) => existsSync(join(to, f)));
          if (clash.length) return bad(`${clash.length} file${clash.length > 1 ? "s" : ""} already there: ${clash.slice(0, 5).join(", ")}`, 409);
          for (const f of files) {
            mkdirSync(dirname(join(to, f)), { recursive: true });
            copyFileSync(join(from, f), join(to, f), constants.COPYFILE_EXCL);
          }
          copied = files.length;
        }
        if (b.init_git && !isRepo(to)) {
          const p = gitSync(to, ["init", "--quiet"], { mode: "plain", env: toolEnv(s.id) });
          if (p.code !== 0) return bad(`git init failed: ${p.err.trim()}`, 409);
        }
        let agents: { moved: AgentMove[]; stayed: AgentMove[] } = { moved: [], stayed: [] };
        if (to !== from) {
          // The agents that share the folder (started with no worktree or place of their own) go with it.
          agents = agentsOfMove(s.id, from);
          store.updateSession(s.id, { workspace: to });
          const inst = newInstructions(to, from);
          const names = (l: AgentMove[]) => l.map((a) => `${a.title} (${a.id})`).join(", ");
          const said = (agents.moved.length ? ` Its agents that shared the folder moved with it: ${names(agents.moved)}.` : "") + (agents.stayed.length ? ` Its agents that kept their own folders: ${agents.stayed.map((a) => `${a.title} (${a.id}, ${a.why})`).join(", ")}.` : "");
          const shortSaid = (agents.moved.length ? `, ${agents.moved.length} agent${agents.moved.length > 1 ? "s" : ""} moved with it` : "") + (agents.stayed.length ? `, ${agents.stayed.length} stayed in their own folder${agents.stayed.length > 1 ? "s" : ""}` : "");
          note(s.id, {
            kind: "folder", model: true, from, to, short: `Moved from ${from} to ${to}${copied ? `, ${copied} files copied` : ""}${b.init_git ? ", made a git repository" : ""}${shortSaid}`,
            text: `[harness] The owner moved this session from ${from} to ${to}${copied ? `, with ${copied} files copied from there` : ""}. Work in ${to} now: run commands and read and write files there.${said}${inst ? `\n\nInstructions from the owner's files there:\n\n${inst}` : ""}`,
          });
          for (const a of agents.moved) {
            store.updateSession(a.id, { workspace: to });
            note(a.id, {
              kind: "folder", model: true, from, to, short: `Moved from ${from} to ${to}, with the session that started it`,
              text: `[harness] The owner moved the session that started you from ${from} to ${to}, and you with it. Work in ${to} now: run commands and read and write files there.${inst ? `\n\nInstructions from the owner's files there:\n\n${inst}` : ""}`,
            });
            emit(a.id);
          }
        } else if (b.init_git) {
          note(s.id, { kind: "folder", model: true, short: `Made ${to} a git repository`, text: `[harness] The owner made ${to} a git repository.` });
        }
        return json({ session: emit(s.id), files_copied: copied, agents });
      },
    },

    "/api/sessions/:id/clone": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        // Another harness's session goes on in Keel through its continue (a copy from its source, kept up to date).
        if (s.outside) return bad(outsideRefusal(s), 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        try {
          return json(await clone(s, b), 201);
        } catch (e) {
          if (e instanceof GitError) return bad(e.message, e.status);
          throw e;
        }
      },
    },

    // Opens a file of the session in the owner's editor on this machine. Only
    // for a page on this machine: it starts a program on the owner's desktop.
    "/api/open": {
      POST: async (req: Request, srv: Bun.Server<unknown>) => {
        const ip = srv.requestIP(req)?.address ?? "";
        if (!LOOPBACK.has(ip) || FORWARDED.some((h) => req.headers.has(h))) return bad("files can only be opened from a browser on the daemon's own machine", 403);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const s = store.session(String(b.session_id ?? ""));
        if (!s) return bad("no such session", 404);
        if (s.machine) return bad("this session works on another machine; its files are not here to open");
        const real = fileOf(s, typeof b.path === "string" ? b.path : null);
        if (real instanceof Response) return real;
        const { argv, opened } = openPlan(process.env, real, Number(b.line) || undefined);
        try {
          // Its own process, not waited for, with the tool environment (no provider keys).
          const p = Bun.spawn(argv, { cwd: s.workspace, env: toolEnv(s.id), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
          p.unref();
        } catch (e) {
          return bad(`could not start ${argv[0]}: ${(e as Error).message}`, 409);
        }
        return json({ ok: true, opened });
      },
    },

    // A file of the session's folder: lines of a text file as JSON, or with
    // raw=1 an image itself, sandboxed, so the page and the phone can show it.
    // Which of the paths a reply names are files of the session's folder, each
    // with its path from the folder: the page links only those.
    "/api/sessions/:id/files/exist": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.machine) return json({ files: {} });
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        if (!Array.isArray(b.paths)) return bad("paths is a list");
        let root: string;
        try { root = realpathSync(s.workspace); } catch { return json({ files: {} }); }
        const files: Record<string, string> = {};
        for (const p of b.paths.slice(0, 500)) {
          if (typeof p !== "string") continue;
          const real = fileOf(s, p.startsWith("~/") ? join(homeDir(), p.slice(2)) : p);
          if (typeof real === "string") files[p] = relative(root, real);
        }
        return json({ files });
      },
    },

    "/api/sessions/:id/file": {
      GET: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.machine) return bad("this session works on another machine");
        const u = new URL(req.url);
        const real = fileOf(s, u.searchParams.get("path"));
        if (real instanceof Response) return real;
        { const held = heldFile(real); if (held) return bad(held, 403); }
        const f = Bun.file(real);
        const kind = imageKind(new Uint8Array(await f.slice(0, 16).arrayBuffer()));
        if (u.searchParams.get("raw") === "1") {
          if (!kind) return bad("raw is only for an image (PNG, JPEG, GIF or WebP)");
          return new Response(f, { headers: { "content-type": kind, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-cache" } });
        }
        const size = f.size;
        if (kind) return json({ path: relative(realpathSync(s.workspace), real), bytes: size, kind: "image", mime: kind });
        if (size > 20 * 1024 * 1024) return json({ path: relative(realpathSync(s.workspace), real), bytes: size, kind: "too_large" });
        const head = new Uint8Array(await f.slice(0, 8000).arrayBuffer());
        if (head.includes(0)) return json({ path: relative(realpathSync(s.workspace), real), bytes: size, kind: "binary" });
        const all = (await f.text()).split("\n");
        const from = Math.max(1, Number(u.searchParams.get("from") ?? 1) || 1);
        const to = Math.min(all.length, Number(u.searchParams.get("to") ?? all.length) || all.length);
        if (to < from) return bad("to is before from");
        let text = all.slice(from - 1, to).join("\n");
        const LIMIT = 400 * 1024;
        const truncated = Buffer.byteLength(text) > LIMIT;
        if (truncated) text = text.slice(0, text.lastIndexOf("\n", LIMIT) > 0 ? text.lastIndexOf("\n", LIMIT) : LIMIT);
        return json({ path: relative(realpathSync(s.workspace), real), bytes: size, kind: "text", text, from, to, total_lines: all.length, truncated });
      },
    },

    // Repositories for the folder picker: two levels under the repo roots
    // (KEEL_REPO_ROOTS, else the parent of the default folder) and the folders
    // of existing sessions, all inside the home directory; cached for 30 s.
    "/api/fs/repos": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams.get("root");
        if (q !== null) {
          const r = expand(q);
          if (!isDir(r) || !contains(HOME, realpathSync(r))) return bad("root is a folder inside the home directory");
          return json({ repos: scan([realpathSync(r)]) });
        }
        if (cache && Date.now() - cache.at < 30_000) return json({ repos: cache.repos });
        const roots = (process.env.KEEL_REPO_ROOTS ?? dirname(resolve(workspace))).split(":").filter(Boolean).map(expand).filter(isDir);
        const found = scan(roots);
        for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
          if (s.machine || !isRepo(s.workspace) || found.some((r) => r.path === s.workspace) || !contains(HOME, s.workspace)) continue;
          found.push(repo(s.workspace));
        }
        found.sort((a, b) => a.path.localeCompare(b.path));
        cache = { at: Date.now(), repos: found };
        return json({ repos: found });
      },
    },
  };
};

type Repo = { name: string; path: string; linked_worktree: boolean };
let cache: { at: number; repos: Repo[] } | null = null;
// A `.git` file (not a folder) is a linked worktree's.
const repo = (p: string): Repo => ({ name: basename(p), path: p, linked_worktree: (() => { try { return statSync(join(p, ".git")).isFile(); } catch { return false; } })() });
function scan(roots: string[]): Repo[] {
  const out: Repo[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (seen.has(dir) || !contains(HOME, dir)) return;
    seen.add(dir);
    if (isRepo(dir)) { out.push(repo(dir)); return; }
    if (depth === 0) return;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) if (!n.startsWith(".") && n !== "node_modules" && isDir(join(dir, n))) visit(join(dir, n), depth - 1);
  };
  for (const r of roots) visit(r, 2);
  return out;
}
