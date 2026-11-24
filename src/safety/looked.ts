// What the permission policy asks of this machine's disk before it decides
// (the policy itself reads nothing), and who answers:
//
//   kept     how many files under a path git cannot bring back: untracked
//            ones it does not ignore, and tracked ones modified since
//   exists   whether a path is there, as a file or a folder
//   targets  the files a patch or an archive would write
//   read     the text of a small file a program is handed as its statements
//
// A decision is made with what is known, the questions it asked are answered
// off the loop, each within a deadline, and it is made again; a question
// still open at the end counts as not answered, which the policy reads as
// high risk. The answers stay with the call, so a card that waits is judged
// again with the same ones.
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { git, gitNames } from "../core/git.ts";
import { contains } from "../core/paths.ts";
import { chunks } from "../core/proc.ts";
import type { Answer, Manifest, Remotes } from "./accounts.ts";

// `n`: files git cannot bring back (0, 1, or 2 for more). `self`: the one such file is the path itself.
// null: no repository there. "late": git did not answer in time.
export type Kept = { n: number; self?: true } | null | "late";
export type Looked = {
  kept(specs: string[]): Kept;
  exists(path: string): "file" | "dir" | "none" | "late";
  // null: not read (missing, too large, not a patch or an archive, no answer in time).
  targets(kind: "patch" | "archive", file: string): string[] | null;
  // null: not read (missing, too large, no answer in time).
  read(file: string): string | null;
  // The git remotes of the repository a folder is in, and the package a folder's manifest names (accounts.ts).
  // null: nothing there. "late": no answer in time.
  remotes?(dir: string): Answer<Remotes>;
  manifest?(dir: string): Answer<Manifest>;
  // The line asked more than is looked up for one command (QUESTIONS): the rest were not asked, and read as not answered.
  over?(): boolean;
};
// How many questions one command may ask of the disk. A line that names more paths than that is not read
// further: what was not asked counts as not answered, which is high risk, and nothing is asked at all.
export const QUESTIONS = 32;

const within = <T>(ms: number, p: Promise<T>, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((done) => { timer = setTimeout(() => done(late), ms); })]).finally(() => clearTimeout(timer));
};

// The folders of a bare repository that are the repository.
const BARE = new Set(["objects", "refs", "HEAD", "packed-refs", "config", "hooks", "info", "worktrees", "modules", "logs"]);

const there = (p: string) => lstat(p).then(() => true, () => false);
// The paths of a repository's submodules, from its own .gitmodules: at most 256 KB of it, read off the loop.
async function submodules(workspace: string): Promise<string[]> {
  try {
    const f = Bun.file(join(workspace, ".gitmodules"));
    if (!(await f.exists())) return [];
    const text = await f.slice(0, 262_144).text();
    // (Spaces and tabs only around the words: a pattern that also takes line ends reads a run of blank lines
    // once for each of them.)
    return [...text.matchAll(/^[ \t]*path[ \t]*=[ \t]*([^\n]+)$/gm)].map((m) => resolve(workspace, m[1]!.trim()));
  } catch {
    return [];
  }
}

export async function keptIn(workspace: string, specs: string[], deadlineMs = 1_500): Promise<Kept> {
  const named = specs.filter((s) => s.startsWith(":(literal)")).map((s) => s.slice(10));
  try {
    // A repository of its own under the path, the session's folder being one with no work tree, and a
    // submodule under the path: each is more than git brings back.
    if ((await Promise.all(named.map((p) => there(join(p, ".git"))))).some(Boolean)) return { n: 2 };
    if (named.some((p) => BARE.has(relative(workspace, p).split("/")[0] ?? "")) && !(await there(join(workspace, ".git")))
      && (await Promise.all(["HEAD", "objects", "refs"].map((n) => there(join(workspace, n))))).every(Boolean)) return { n: 2 };
    if (named.length) { const paths = await submodules(workspace); if (named.some((p) => paths.some((sub) => contains(p, sub)))) return { n: 2 }; }
  } catch { /* what the disk does not say, git is asked */ }
  const began = Date.now();
  const r = await gitNames(workspace, ["ls-files", "-z", "-m", "-o", "--exclude-standard", "--", ...specs], 2, deadlineMs);
  if (r.late) return "late";
  if (r.none || r.failed) return null;
  if (r.names.length === 0) {
    // Nothing new or changed that git sees. A file marked assume-unchanged or skip-worktree is one git was told
    // not to look at: its changes are not listed above, and are not in git either. (Asked only here, where the
    // delete would otherwise be an edit; the listing is tagged, and stopped at the first such entry.)
    const hidden = await gitNames(workspace, ["ls-files", "-z", "-v", "--", ...specs], 1, Math.max(200, deadlineMs - (Date.now() - began)), (e) => /^[a-zS] /.test(e));
    if (hidden.late) return "late";
    if (hidden.names.length) return { n: 2 };
  }
  const one = r.names.length === 1 && named.length === 1 && specs.length === 1 && !r.names[0]!.endsWith("/") && resolve(workspace, r.names[0]!) === resolve(named[0]!);
  return { n: r.names.length, ...(one ? { self: true as const } : {}) };
}

async function existsAt(path: string): Promise<"file" | "dir" | "none" | "late"> {
  return within(300, lstat(path).then((st) => (st.isDirectory() ? "dir" as const : "file" as const), () => "none" as const), "late" as const);
}

const MOST = 2_000_000; // bytes of a patch, or of an archive's listing, that are read
async function targetsOf(kind: "patch" | "archive", file: string): Promise<string[] | null> {
  try {
    if (kind === "patch") {
      const f = Bun.file(file);
      if (!(await f.exists()) || f.size > MOST) return null;
      const out = new Set<string>();
      for (const m of (await f.text()).matchAll(/^(?:\+\+\+ |--- |rename to |copy to )(?:"?)(.+?)(?:"?)(?:\t.*)?$|^diff --git a\/.+ b\/(.+)$/gm)) {
        const p = (m[2] ?? m[1]!).replace(/^[ab]\//, "");
        if (p !== "/dev/null") out.add(p);
      }
      return out.size ? [...out] : null;
    }
    const zip = /\.(zip|jar|whl|egg)$/i.test(file);
    const proc = Bun.spawn(zip ? ["unzip", "-Z1", file] : ["tar", "--list", `--file=${file}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 1_500, killSignal: "SIGKILL" });
    const text = new TextDecoder();
    let all = "";
    for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) { all += text.decode(chunk, { stream: true }); if (all.length > MOST) { proc.kill("SIGKILL"); return null; } }
    if ((await proc.exited) !== 0) return null;
    const names = all.split("\n").filter(Boolean);
    return names.length ? names : null;
  } catch {
    return null;
  }
}

async function textOf(file: string): Promise<string | null> {
  try {
    const f = Bun.file(file);
    return (await f.exists()) && f.size <= 262_144 ? await within(500, f.text(), null as string | null) : null;
  } catch {
    return null;
  }
}

// The remotes of the repository `dir` is in, through Keel's own view of its config (src/core/git.ts): the
// addresses as git rewrites them for a fetch and for a push, what gh marked, and where a bare push goes.
export async function remotesIn(dir: string): Promise<Remotes | null | "late"> {
  const run = (args: string[]) => git(dir, args, { read: true, timeout: 1_500 });
  const [verbose, config, branch] = await Promise.all([run(["remote", "-v"]), run(["config", "--get-regexp", "^(remote\\..+\\.gh-resolved|remote\\.pushdefault|branch\\..+\\.(remote|pushremote))$"]), run(["symbolic-ref", "-q", "--short", "HEAD"])]);
  if (verbose.code === -1 || config.code === -1) return "late";
  if (verbose.code !== 0) return null;
  const r: Remotes = { push: {}, fetch: {}, resolved: {} };
  for (const line of verbose.out.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    if (m[3] === "fetch") r.fetch[m[1]!] = m[2]!; else (r.push[m[1]!] ??= []).push(m[2]!);
  }
  r.branch = branch.code === 0 ? branch.out.trim() : undefined;
  for (const line of config.out.split("\n")) {
    const m = /^(\S+) (.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!, value = m[2]!.trim();
    const res = /^remote\.(.+)\.gh-resolved$/.exec(key);
    if (res) r.resolved[res[1]!] = value;
    else if (key === "remote.pushdefault") r.pushDefault = value;
    else if (r.branch !== undefined && key.toLowerCase() === `branch.${r.branch.toLowerCase()}.remote`) r.branchRemote = value;
    else if (r.branch !== undefined && key.toLowerCase() === `branch.${r.branch.toLowerCase()}.pushremote`) r.branchPushRemote = value;
  }
  return r;
}

// The package a folder holds: the names in package.json, pyproject.toml (or setup.cfg) and Cargo.toml, each read
// from the file's first 256 KB.
export async function manifestIn(dir: string): Promise<Manifest | null | "late"> {
  const text = async (name: string) => { try { const f = Bun.file(join(dir, name)); return (await f.exists()) && f.size <= 262_144 ? await within(500, f.text(), null as string | null) : null; } catch { return null; } };
  const [pkg, py, cfg, cargo] = await Promise.all([text("package.json"), text("pyproject.toml"), text("setup.cfg"), text("Cargo.toml")]);
  if (pkg === null && py === null && cfg === null && cargo === null) return null;
  const m: Manifest = {};
  if (pkg) { try { const j = JSON.parse(pkg); if (typeof j?.name === "string") m.npm = j.name; if (j?.private === true) m.private = true; } catch { /* not JSON: no name */ } }
  const section = (t: string, head: RegExp) => { const at = t.search(head); return at < 0 ? "" : t.slice(at).split(/\n\[/)[0]!; };
  const nameIn = (t: string) => /^\s*name\s*=\s*["']([^"']+)["']/m.exec(t)?.[1];
  if (py) m.pypi = nameIn(section(py, /^\[project\]/m)) ?? nameIn(section(py, /^\[tool\.poetry\]/m));
  if (!m.pypi && cfg) m.pypi = /^\s*name\s*=\s*([^\s#]+)/m.exec(section(cfg, /^\[metadata\]/m))?.[1];
  if (cargo) m.crates = nameIn(section(cargo, /^\[package\]/m));
  return m;
}

// The answers gathered for one call. `view(asked)` is what a decision reads: an answer already in hand, else the
// answer of a disk that did not answer, with the question noted in `asked`. `answer` asks the disk what was noted.
// A decision that asks more than QUESTIONS at once is over: nothing is asked for it, and it stands as it is.
export function looking(workspace: string) {
  const known = new Map<string, unknown>();
  let over = false;
  const view = (asked?: Map<string, () => Promise<unknown>>): Looked => {
    const get = <A>(key: string, late: A, ask: () => Promise<A>): A => {
      if (known.has(key)) return known.get(key) as A;
      if (asked && !asked.has(key)) { if (asked.size >= QUESTIONS) over = true; else asked.set(key, ask); }
      return late;
    };
    return {
      kept: (specs) => get<Kept>(`kept\0${specs.join("\0")}`, "late", () => keptIn(workspace, specs)),
      exists: (path) => get(`exists\0${path}`, "late" as const, () => existsAt(path)),
      targets: (kind, file) => get<string[] | null>(`targets\0${kind}\0${file}`, null, () => targetsOf(kind, file)),
      read: (file) => get<string | null>(`read\0${file}`, null, () => textOf(file)),
      remotes: (dir) => get<Answer<Remotes>>(`remotes\0${dir}`, "late", () => remotesIn(dir)),
      manifest: (dir) => get<Answer<Manifest>>(`manifest\0${dir}`, "late", () => manifestIn(dir)),
      over: () => over,
    };
  };
  const answer = async (asked: Map<string, () => Promise<unknown>>) => { await Promise.all([...asked].map(async ([key, ask]) => { known.set(key, await ask()); })); };
  return { view, answer, over: () => over };
}

// Decides with what the disk says: `run` is called with the answers so far, what it asked is answered, and it is
// called again, at most four times. A question still open then stays not answered.
export async function deciding<T>(workspace: string, run: (looked: Looked) => T): Promise<{ d: T; looked: Looked }> {
  const l = looking(workspace);
  let asked = new Map<string, () => Promise<unknown>>();
  let d = run(l.view(asked));
  for (let pass = 0; asked.size && !l.over() && pass < 3; pass++) {
    await l.answer(asked);
    asked = new Map();
    d = run(l.view(asked));
  }
  return { d, looked: l.view() };
}
