// The branches an agent's own git made in its worktree: the ones it may move, rename and delete beside its own
// (src/safety/shared-branches.ts, ref-guard.ts).
//
// A branch is known as made by this worktree by two things together: the name it was made under, and the line that
// begins its log (git's reflog: when it was made, from which commit, by whom). The line goes with the log when the
// branch is renamed, and a branch made again under the same name, by the owner or another agent, begins with
// another line, so a branch an agent made and deleted never makes the next one of that name its own.
//
// Two files hold them, one line each, "refs/heads/NAME LINE":
//  - the pad, in the worktree's git directory: the guard hook writes it while a command runs, which a confined
//    command can write as well. The hook trusts it for the length of the command; after it, nothing here does.
//  - the ledger, in Keel's folder for the agent: only the daemon writes it, after each command, from the pad (what
//    the pad says was made by that command: its line carries the time, and a line older than the command is not
//    taken), and it keeps each entry on the branch it names now (a rename is followed) and drops the ones whose
//    branch is gone.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ledgerOf, PAD } from "./ref-guard.ts";

export type Made = { ref: string; line: string };

const HEAD_BYTES = 8192;
const KEEP = 4000;

function firstOf(text: string): string | undefined {
  const at = text.indexOf("\n");
  const line = at < 0 ? text : text.slice(0, at);
  return line.length ? line : undefined;
}

// The line that begins a branch's log: undefined where it has none (no log, or logging is off).
export function firstLineSync(common: string, ref: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(common, "logs", ref), "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    return firstOf(buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0)));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export async function firstLine(common: string, ref: string): Promise<string | undefined> {
  let h;
  try {
    h = await open(join(common, "logs", ref), "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await h.read(buf, 0, HEAD_BYTES, 0);
    return firstOf(buf.toString("utf8", 0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await h?.close();
  }
}

export function parseMade(text: string): Made[] {
  const out: Made[] = [];
  for (const l of text.split("\n")) {
    const at = l.indexOf(" ");
    if (at > 0 && l.startsWith("refs/heads/")) out.push({ ref: l.slice(0, at), line: l.slice(at + 1) });
  }
  return out;
}
const write = (m: Made[]) => m.map((e) => `${e.ref} ${e.line}\n`).join("");

export function ledgerSync(gitDir: string): Made[] {
  try { return parseMade(readFileSync(ledgerOf(gitDir), "utf8")); } catch { return []; }
}
export async function ledger(gitDir: string): Promise<Made[]> {
  try { return parseMade(await readFile(ledgerOf(gitDir), "utf8")); } catch { return []; }
}

// The branches the ledger holds that still begin with the line they were made with, in small letters (a file system
// that ignores case takes MAIN for main).
export function madeNowSync(common: string, gitDir: string): Set<string> {
  const out = new Set<string>();
  for (const e of ledgerSync(gitDir)) if (firstLineSync(common, e.ref) === e.line) out.add(e.ref.slice(11).toLowerCase());
  return out;
}
export async function madeNow(common: string, gitDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = await ledger(gitDir);
  await Promise.all(entries.map(async (e) => { if ((await firstLine(common, e.ref)) === e.line) out.add(e.ref.slice(11).toLowerCase()); }));
  return out;
}

// The seconds in a log line: "<old> <new> <name> <<email>> <seconds> <zone>\t<words>".
const SECONDS = /> (\d+) [+-]\d{4}(\t|$)/;

// Where the renamed ones went: for each entry whose branch is gone, the branch that carries its log now (the log's
// first line is the entry's, and it says "renamed refs/heads/FROM to refs/heads/TO" for the rename).
async function renamedTo(common: string, gone: Made[]): Promise<Made[]> {
  const lines = new Set(gone.map((g) => g.line));
  const found: Made[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { await walk(join(dir, e.name), `${prefix}${e.name}/`); continue; }
      const ref = `refs/heads/${prefix}${e.name}`;
      const first = await firstLine(common, ref);
      if (first === undefined || !lines.has(first)) continue;
      let log: string;
      try { log = await readFile(join(dir, e.name), "utf8"); } catch { continue; }
      const names = new Set([...log.matchAll(/\tBranch: renamed (refs\/heads\/\S+) to refs\/heads\/\S+$/gm)].map((m) => m[1]!));
      for (const g of gone) if (g.line === first && names.has(g.ref)) found.push({ ref, line: first });
    }
  };
  await walk(join(common, "logs/refs/heads"), "");
  return found;
}

// After a command: what its guard hook noted in the pad is taken into the ledger (only the branches made while the
// command ran: `since`, in milliseconds), the entries of renamed branches follow them, the ones whose branch is gone
// go, and the pad is emptied. A pad written to while this runs loses the lines it had not read: those branches are
// not noted, and so count as not made by the worktree, which only holds it back from moving them.
export async function settleMade(common: string, gitDir: string, since: number): Promise<void> {
  const pad = join(gitDir, PAD);
  let text = "";
  try { text = await readFile(pad, "utf8"); } catch { /* none made */ }
  const kept = await ledger(gitDir);
  const floor = Math.floor(since / 1000) - 2;
  const fresh = parseMade(text).filter((e) => Number(SECONDS.exec(e.line)?.[1] ?? 0) >= floor);
  if (!kept.length && !fresh.length) { if (text) await rm(pad, { force: true }); return; }
  const all = new Map<string, Made>();
  for (const e of [...kept, ...fresh]) all.set(`${e.ref} ${e.line}`, e);
  const entries = [...all.values()];
  const here = await Promise.all(entries.map(async (e) => (await firstLine(common, e.ref)) === e.line));
  const next = entries.filter((_, k) => here[k]);
  const gone = entries.filter((_, k) => !here[k]);
  if (gone.length) for (const e of await renamedTo(common, gone)) if (!next.some((l) => l.ref === e.ref && l.line === e.line)) next.push(e);
  if (next.length > KEEP) next.splice(0, next.length - KEEP);
  if (write(next) !== write(kept)) {
    const file = ledgerOf(gitDir);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, write(next));
    await rename(tmp, file);
  }
  if (text) await rm(pad, { force: true });
}
