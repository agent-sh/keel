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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitViewsDir } from "../core/git.ts";

// A place with what stood there: a link's target, or a redirect file's content.
type Seen = { link: string } | { text: string } | { sha: string };
export type Plants = Map<string, Seen>;
export type Plant = { path: string; what: "link" | "file" | "changed" | "gone"; kept?: string };

const LIMIT = 100_000;
// The files that say where a repository's objects are, by name.
const REDIRECTS = ["alternates", "http-alternates"];

function note(out: Plants, p: string, redirect: boolean): void {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.set(p, { link: readlinkSync(p) });
    else if (st.isFile() && redirect) out.set(p, st.size <= 65_536 ? { text: readFileSync(p, "utf8") } : { sha: createHash("sha256").update(readFileSync(p)).digest("hex") });
  } catch { /* gone */ }
}

// Every link under a folder (not followed), and nothing else.
function links(dir: string, out: Plants, left: { n: number }): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (left.n-- <= 0) return;
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) out.set(p, { link: readlinkSync(p) });
    else if (e.isDirectory()) links(p, out, left);
  }
}

// The places read: links in the repository's directory, refs, logs, hooks and objects, the alternates files, and the
// files that name where each worktree's repository is. `common`: the repository's git directory; `own`: this
// worktree's. The 256 folders of loose objects are looked into only when given the marks of an earlier reading, and
// then only the ones written to since (a link in one is always new: git writes plain files there).
export function scanPlants(common: string, own: string, since?: Map<string, number>): { plants: Plants; marks: Map<string, number> } {
  const out: Plants = new Map();
  const left = { n: LIMIT };
  const top = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isSymbolicLink()) note(out, join(dir, e.name), false);
  };
  top(common);
  top(own);
  for (const d of ["refs", "logs", "info", "hooks"]) links(join(common, d), out, left);
  const objects = join(common, "objects");
  top(objects);
  links(join(objects, "info"), out, left);
  links(join(objects, "pack"), out, left);
  for (const f of REDIRECTS) note(out, join(objects, "info", f), true);
  const marks = new Map<string, number>();
  try {
    for (const e of readdirSync(objects, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[0-9a-f]{2}$/.test(e.name)) continue;
      const p = join(objects, e.name);
      const m = statSync(p).mtimeMs;
      marks.set(p, m);
      if (since !== undefined && since.get(p) !== m) links(p, out, left);
    }
  } catch { /* no objects */ }
  for (const f of ["gitdir", "commondir"]) note(out, join(own, f), true);
  try {
    for (const name of readdirSync(join(common, "worktrees"))) for (const f of ["gitdir", "commondir"]) note(out, join(common, "worktrees", name, f), true);
  } catch { /* no linked worktrees */ }
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
  for (const [p, now] of after) {
    const was = before.get(p);
    if (same(was, now)) continue;
    if ("link" in now) { keep(p, "link"); if (was && "text" in was) restore(p, was); continue; }
    // A redirect file: a new alternates file is moved out; one that held something else gets its words back (this
    // worktree's own, and the alternates file; a change to another worktree's is said, since Keel moves those itself).
    if (!was) { if (alternates(p)) keep(p, "file"); continue; }
    if (alternates(p) || ownFile(p)) restore(p, was);
    done.push({ path: p, what: "changed" });
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
    return d.what === "link" ? `a link at ${p}${where}` : d.what === "file" ? `the file ${p}${where}` : d.what === "changed" ? `a change to ${p}` : `${p} taken away (put back)`;
  });
  const more = done.length > 6 ? ` and ${done.length - 6} more` : "";
  return `This command left ${each.join(", ")}${more} in the git data this worktree shares with the repository's other checkouts. A link or a redirect file there makes git in every checkout read or write somewhere else, so what could be was set aside or put back. Use git's own commands in your own worktree instead, and say in your report what you wanted done.`;
}
