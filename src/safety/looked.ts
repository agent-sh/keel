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
import { existsSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { gitNames } from "../core/git.ts";
import { contains } from "../core/paths.ts";
import { chunks } from "../core/proc.ts";

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
};

const within = <T>(ms: number, p: Promise<T>, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((done) => { timer = setTimeout(() => done(late), ms); })]).finally(() => clearTimeout(timer));
};

// The folders of a bare repository that are the repository.
const BARE = new Set(["objects", "refs", "HEAD", "packed-refs", "config", "hooks", "info", "worktrees", "modules", "logs"]);

export async function keptIn(workspace: string, specs: string[], deadlineMs = 1_500): Promise<Kept> {
  const named = specs.filter((s) => s.startsWith(":(literal)")).map((s) => s.slice(10));
  try {
    // A repository of its own under the path, the session's folder being one with no work tree, and a
    // submodule under the path: each is more than git brings back.
    if (named.some((p) => existsSync(join(p, ".git")))) return { n: 2 };
    if (!existsSync(join(workspace, ".git")) && existsSync(join(workspace, "HEAD")) && existsSync(join(workspace, "objects")) && existsSync(join(workspace, "refs"))
      && named.some((p) => BARE.has(relative(workspace, p).split("/")[0] ?? ""))) return { n: 2 };
    const modules = join(workspace, ".gitmodules");
    if (named.length && existsSync(modules)) {
      const paths = [...readFileSync(modules, "utf8").matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => resolve(workspace, m[1]!));
      if (named.some((p) => paths.some((sub) => contains(p, sub)))) return { n: 2 };
    }
  } catch { /* what the disk does not say, git is asked */ }
  const r = await gitNames(workspace, ["ls-files", "-z", "-m", "-o", "--exclude-standard", "--", ...specs], 2, deadlineMs);
  if (r.late) return "late";
  if (r.none || r.failed) return null;
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

// The answers gathered for one call. `view(asked)` is what a decision reads: an answer already in hand, else the
// answer of a disk that did not answer, with the question noted in `asked`. `answer` asks the disk what was noted
// (at most 32 questions a time: a line that asks more is decided with the rest not answered).
export function looking(workspace: string) {
  const known = new Map<string, unknown>();
  const view = (asked?: Map<string, () => Promise<unknown>>): Looked => {
    const get = <A>(key: string, late: A, ask: () => Promise<A>): A => {
      if (known.has(key)) return known.get(key) as A;
      asked?.set(key, ask);
      return late;
    };
    return {
      kept: (specs) => get<Kept>(`kept\0${specs.join("\0")}`, "late", () => keptIn(workspace, specs)),
      exists: (path) => get(`exists\0${path}`, "late" as const, () => existsAt(path)),
      targets: (kind, file) => get<string[] | null>(`targets\0${kind}\0${file}`, null, () => targetsOf(kind, file)),
      read: (file) => get<string | null>(`read\0${file}`, null, () => textOf(file)),
    };
  };
  const answer = async (asked: Map<string, () => Promise<unknown>>) => { await Promise.all([...asked].slice(0, 32).map(async ([key, ask]) => { known.set(key, await ask()); })); };
  return { view, answer };
}

// Decides with what the disk says: `run` is called with the answers so far, what it asked is answered, and it is
// called again, at most four times. A question still open then stays not answered.
export async function deciding<T>(workspace: string, run: (looked: Looked) => T): Promise<{ d: T; looked: Looked }> {
  const l = looking(workspace);
  let asked = new Map<string, () => Promise<unknown>>();
  let d = run(l.view(asked));
  for (let pass = 0; asked.size && pass < 3; pass++) {
    await l.answer(asked);
    asked = new Map();
    d = run(l.view(asked));
  }
  return { d, looked: l.view() };
}
