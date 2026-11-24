// Links and redirect files an agent's command leaves in the git data its worktree shares.
//
// A worktree's git runs against the repository's directory, which the main
// checkout and every other agent's worktree read as well. Objects, refs and
// logs are writable for a confined command there (a commit needs them), and a
// command outside the sandbox writes anywhere. A link under refs or logs, or
// in objects, makes git read or write the file it names the next time any
// checkout runs; `objects/info/alternates` makes git read another object
// store; the `gitdir` and `commondir` files of a worktree say where its
// repository is. Claude Desktop and Claude Code set the same things aside
// after a command ("quarantine").
//
// The gate refuses the writes a command spells out (shared-branches.ts,
// gitStoreOf). What it cannot read, a script or a program, is found here: the
// places are read before the command and after it, and what is new or
// different is moved out (a link or a new alternates file into a folder of
// Keel's) or put back (this worktree's own redirect files), and the result
// says so. What stood before the command (an alternates file the owner made, a
// link they keep) is the repository's own and stays.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitViewsDir } from "../core/git.ts";

// A place with what stood there: a link's target, or a redirect file's content.
type Seen = { link: string } | { text: string } | { sha: string };
export type Plants = Map<string, Seen>;
export type Plant = { path: string; what: "link" | "file" | "changed" | "gone"; kept?: string; put?: boolean };

const LIMIT = 100_000;
// The files that say where a repository's objects are, by name.
const REDIRECTS = ["alternates", "http-alternates"];

async function note(out: Plants, p: string, redirect: boolean): Promise<void> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) out.set(p, { link: await readlink(p) });
    else if (st.isFile() && redirect) out.set(p, st.size <= 65_536 ? { text: await readFile(p, "utf8") } : { sha: createHash("sha256").update(await readFile(p)).digest("hex") });
  } catch { /* gone */ }
}

// Every link under a folder (not followed), and nothing else.
async function links(dir: string, out: Plants, left: { n: number }): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (left.n-- <= 0) return;
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) { try { out.set(p, { link: await readlink(p) }); } catch { /* gone */ } }
    else if (e.isDirectory()) await links(p, out, left);
  }
}

// The places read: links in the repository's directory, refs, logs, hooks and objects, the alternates files, and the
// files that name where each worktree's repository is. `common`: the repository's git directory; `own`: this
// worktree's. The 256 folders of loose objects are looked into only when given the marks of an earlier reading, and
// then only the ones written to since (a link in one is always new: git writes plain files there). Read with the
// asynchronous file calls: a command's reading does not hold the daemon's loop.
export async function scanPlants(common: string, own: string, since?: Map<string, number>): Promise<{ plants: Plants; marks: Map<string, number> }> {
  const out: Plants = new Map();
  const left = { n: LIMIT };
  const top = async (dir: string) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((e) => e.isSymbolicLink()).map((e) => note(out, join(dir, e.name), false)));
  };
  const objects = join(common, "objects");
  const marks = new Map<string, number>();
  await Promise.all([
    top(common), top(own), top(objects),
    ...["refs", "logs", "info", "hooks"].map((d) => links(join(common, d), out, left)),
    links(join(objects, "info"), out, left), links(join(objects, "pack"), out, left),
    ...REDIRECTS.map((f) => note(out, join(objects, "info", f), true)),
    (async () => {
      try {
        const dirs = (await readdir(objects, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name));
        await Promise.all(dirs.map(async (e) => {
          const p = join(objects, e.name);
          const m = (await stat(p)).mtimeMs;
          marks.set(p, m);
          if (since !== undefined && since.get(p) !== m) await links(p, out, left);
        }));
      } catch { /* no objects */ }
    })(),
    ...["gitdir", "commondir"].map((f) => note(out, join(own, f), true)),
    (async () => {
      try {
        const names = await readdir(join(common, "worktrees"));
        await Promise.all(names.flatMap((name) => ["gitdir", "commondir"].map((f) => note(out, join(common, "worktrees", name, f), true))));
      } catch { /* no linked worktrees */ }
    })(),
  ]);
  return { plants: out, marks };
}

const same = (a: Seen | undefined, b: Seen | undefined) => (a === undefined || b === undefined ? a === b : JSON.stringify(a) === JSON.stringify(b));

export const quarantineRoot = () => join(dirname(gitViewsDir()), "git-quarantine");

function restore(p: string, was: Seen): void {
  if (!("text" in was)) return;
  try { rmSync(p, { force: true }); writeFileSync(p, was.text); } catch { /* read-only: nothing was written there */ }
}

// What is new or different since `before`, moved out or put back. `own`: this worktree's git directory. `at`: the
// folder of this reading in the quarantine.
export function settle(before: Plants, after: Plants, own: string, at: string = join(quarantineRoot(), String(Date.now()))): Plant[] {
  const done: Plant[] = [];
  const keep = (p: string, what: "link" | "file") => {
    let kept: string | undefined;
    try {
      mkdirSync(at, { recursive: true });
      kept = join(at, p.replace(/^\/+/, "").replace(/\//g, "%"));
      if (lstatSync(p).isSymbolicLink()) { symlinkSync(readlinkSync(p), kept); rmSync(p, { force: true }); }
      else { try { renameSync(p, kept); } catch { writeFileSync(kept, readFileSync(p)); rmSync(p, { force: true }); } }
    } catch { kept = undefined; }
    done.push({ path: p, what, kept });
  };
  const alternates = (p: string) => /(^|\/)(http-)?alternates$/.test(p);
  const ownFile = (p: string) => /(^|\/)(gitdir|commondir)$/.test(p) && dirname(p) === own;
  for (const [p, now] of [...after].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const was = before.get(p);
    if (same(was, now)) continue;
    if ("link" in now) { keep(p, "link"); if (was && "text" in was) restore(p, was); continue; }
    // A redirect file: a new alternates file is moved out; one that held something else gets its words back (this
    // worktree's own, and the alternates file; a change to another worktree's is said, since Keel moves those itself).
    if (!was) { if (alternates(p)) keep(p, "file"); continue; }
    const put = alternates(p) || ownFile(p);
    if (put) restore(p, was);
    done.push({ path: p, what: "changed", ...(put ? { put } : {}) });
  }
  for (const [p, was] of before) {
    // A redirect file taken away: a worktree without its gitdir or commondir is lost to git.
    if (!after.has(p) && "text" in was && ownFile(p) && !existsSync(p)) { restore(p, was); done.push({ path: p, what: "gone" }); }
  }
  return done;
}

const short = (p: string, common: string) => (p.startsWith(`${common}/`) ? p.slice(common.length + 1) : p);
// The sentence for the result of a command, or nothing.
export function plantsSaid(done: Plant[], common: string): string | undefined {
  if (!done.length) return undefined;
  const each = done.slice(0, 6).map((d) => {
    const p = short(d.path, common);
    const where = d.kept ? ` (moved to ${d.kept})` : "";
    return d.what === "link" ? `a link at ${p}${where}` : d.what === "file" ? `the file ${p}${where}` : d.what === "changed" ? `a change to ${p}${d.put ? " (put back)" : ""}` : `${p} taken away (put back)`;
  });
  const more = done.length > 6 ? ` and ${done.length - 6} more` : "";
  const acted = done.some((d) => d.kept !== undefined || d.put || d.what === "gone");
  return `This command ${done.every((d) => d.what === "changed") ? "made" : "left"} ${each.join(", ")}${more} in the git data this worktree shares with the repository's other checkouts. A link or a redirect file there makes git in every checkout read or write somewhere else; ${acted ? "what could be was set aside or put back" : "it was left as it is"}. Use git's own commands in your own worktree instead, and say in your report what you wanted done.`;
}
