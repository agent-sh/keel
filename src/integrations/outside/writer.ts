// Who holds a session of another harness now: the one fact the row, the send
// and the mirror read (src/integrations/outside/service.ts, codex-app.ts). The
// writer is the process the harness itself records:
//
// - Claude Code: a record of its own running session, <config>/sessions/<pid>.json
//   with that sessionId, whose pid is alive and started when the record says
//   (procStart: field 22 of /proc/<pid>/stat, as Claude Code writes it). Claude
//   Code takes no lock: two processes can write one transcript, so the rule that
//   one writes at a time is Keel's.
// - Codex: the holder of the FLOCK write lock on
//   <home>/thread-writer-locks/<thread>.lock, read from /proc/locks. The lock is
//   never taken to test it: taking it would lock the owner's terminal out.
//   Codex refuses a second writer itself ("already has an active writer").
// - agy: the holder of <root>/presence/<conversation>.lock, the same way.
//
// Read again right before anything is started in a session, never taken from
// an earlier read. Linux only: elsewhere every lock reads as free, and the
// harness's own refusal is the guard.
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Holder, HolderKind } from "../../core/types.ts";

export type { Holder, HolderKind };
export const FREE: Holder = { kind: "free" };

// One line of /proc/locks: "1: FLOCK  ADVISORY  WRITE 1234 fc:00:105142592 0 EOF". A waiter's line
// ("1: -> FLOCK ...") holds nothing. An OFD lock names no process (pid -1).
export type Lock = { type: string; write: boolean; pid: number; major: number; minor: number; inode: number };
export function parseLocks(text: string): Lock[] {
  const out: Lock[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[1] === "->") continue;
    const [maj, min, ino] = (f[5] ?? "").split(":");
    const major = parseInt(maj ?? "", 16), minor = parseInt(min ?? "", 16), inode = Number(ino);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(inode)) continue;
    out.push({ type: f[1]!, write: f[3] === "WRITE", pid: Number(f[4]), major, minor, inode });
  }
  return out;
}

// A stat's device number as the kernel's major and minor (glibc's encoding of dev_t).
export function devParts(dev: number | bigint): { major: number; minor: number } {
  const d = BigInt(dev);
  return { major: Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn)), minor: Number((d & 0xffn) | ((d >> 12n) & ~0xffn)) };
}

// The process that holds a write lock on the file: its pid, 0 when the lock names none, undefined when
// nothing holds it (or the file is not there). Matched by inode; a lock on the same inode of another device
// counts only when no lock matches the device too (a filesystem that reports another device to stat).
export function lockHolder(path: string, locks: Lock[]): number | undefined {
  let st;
  try { st = statSync(path, { bigint: true }); } catch { return undefined; }
  const ino = Number(st.ino);
  const { major, minor } = devParts(st.dev);
  const held = locks.filter((l) => l.write && l.inode === ino);
  const same = held.find((l) => l.major === major && l.minor === minor) ?? held[0];
  return same ? Math.max(0, same.pid) : undefined;
}

export const readLocks = (): Lock[] => { try { return parseLocks(readFileSync("/proc/locks", "utf8")); } catch { return []; } };

// A process's state letter and start time (field 22, clock ticks since boot, as text) from /proc/<pid>/stat.
// The name in parentheses can hold spaces and parentheses: the fields are counted after its last ")".
export function statFields(text: string): { state: string; start: string } | undefined {
  const i = text.lastIndexOf(")");
  if (i < 0) return undefined;
  const f = text.slice(i + 2).split(" ");
  return f[0] && f[19] ? { state: f[0], start: f[19] } : undefined;
}

// Alive: the process is there and is no zombie; with `start`, it is the process that started then (a
// pid taken again by another program is not it).
export function alive(pid: number, start?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch {
    // No /proc (not Linux): whether the pid answers a signal.
    if (existsSync("/proc/self/stat")) return false;
    try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
  }
  const s = statFields(text);
  if (!s || s.state === "Z" || s.state === "X") return false;
  return start === undefined || s.start === start;
}

// A process by its pid and start time: a pid taken again by another program is not it.
export type Proc = { pid: number; start: string };
export function procOf(pid: number): Proc | undefined {
  try { const s = statFields(readFileSync(`/proc/${pid}/stat`, "utf8")); return s && s.state !== "Z" ? { pid, start: s.start } : undefined; } catch { return undefined; }
}

// A process's parent (field 4 of /proc/<pid>/stat).
export function parentOf(pid: number): number | undefined {
  try { const t = readFileSync(`/proc/${pid}/stat`, "utf8"); const n = Number(t.slice(t.lastIndexOf(")") + 2).split(" ")[1]); return Number.isInteger(n) ? n : undefined; } catch { return undefined; }
}

// The process that holds a lock and its ancestors up to `top` (not `top` itself), each with its start time: what
// stands between a child Keel started and the writer lock it took (a launcher's native codex). Nothing when the
// holder is `top`, is not under it within `depth` steps, or nothing holds the lock.
export function holderChain(top: number, holder: number | undefined, depth = 6): Proc[] {
  if (!holder || holder === top) return [];
  const out: Proc[] = [];
  let p = holder;
  for (let i = 0; i < depth && p !== top; i++) {
    const c = procOf(p);
    const up = c && parentOf(p);
    if (!c || !up || up <= 1) return [];
    out.push(c);
    p = up;
  }
  return p === top ? out : [];
}

// The processes under one, each with its start time (/proc/<pid>/task/<tid>/children, every thread's). A
// program a launcher starts (the npm package's codex.js starts the native codex) holds what the launcher
// does not: the native holds the thread's writer lock.
export function descendants(pid: number, depth = 4): Proc[] {
  const out: Proc[] = [];
  const walk = (p: number, d: number) => {
    if (d <= 0) return;
    let tids: string[] = [];
    try { tids = readdirSync(`/proc/${p}/task`); } catch { return; }
    const kids = new Set<number>();
    for (const t of tids) {
      try { for (const k of readFileSync(`/proc/${p}/task/${t}/children`, "utf8").trim().split(/\s+/)) if (Number(k) > 1) kids.add(Number(k)); } catch {}
    }
    for (const k of kids) {
      const c = procOf(k);
      if (!c) continue;
      out.push(c);
      walk(k, d - 1);
    }
  };
  walk(pid, depth);
  return out;
}

// A Claude Code record of a running session, as its kind and entrypoint say who runs it.
export type ClaudeRecord = { pid: number; sessionId?: string; procStart?: string; kind?: string; entrypoint?: string; status?: string; waitingFor?: string };
export function claudeKind(r: Pick<ClaudeRecord, "kind" | "entrypoint">): HolderKind {
  if (r.entrypoint === "claude-desktop") return "desktop";
  if (r.entrypoint === "claude-vscode") return "editor";
  if (r.kind === "bg" || r.kind === "daemon" || r.kind === "daemon-worker") return "background";
  if (r.entrypoint?.startsWith("sdk")) return "process";
  return "terminal";
}

export function readClaudeRecord(path: string): ClaudeRecord | undefined {
  const pid = Number(/(\d+)\.json$/.exec(path)?.[1]);
  if (!pid) return undefined;
  let r: any;
  try { r = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!r || typeof r !== "object") return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { pid, sessionId: str(r.sessionId), procStart: str(r.procStart), kind: str(r.kind), entrypoint: str(r.entrypoint), status: str(r.status), waitingFor: str(r.waitingFor) };
}

// The live record Claude Code keeps for the session in its folder of running sessions now: its pid, with the
// start time it wrote compared (a pid taken again by another program is not it).
export function claudeRecordOf(sessionsDir: string, sessionId: string): ClaudeRecord | undefined {
  let names: string[] = [];
  try { names = readdirSync(sessionsDir); } catch { return undefined; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const r = readClaudeRecord(join(sessionsDir, n));
    if (r?.sessionId === sessionId && alive(r.pid, r.procStart)) return r;
  }
  return undefined;
}

// The live process Claude Code records for the session, read from its folder of running sessions now.
export function claudeHolder(sessionsDir: string, sessionId: string): Holder {
  const r = claudeRecordOf(sessionsDir, sessionId);
  return r ? { kind: claudeKind(r), pid: r.pid } : FREE;
}

// What a lock's holder is, from its command line and its input: a server another app speaks to, a
// program at a terminal, or a process Keel cannot tell.
function lockKind(pid: number): HolderKind {
  if (!pid) return "process";
  let argv: string[] = [];
  try { argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch {}
  if (argv.includes("app-server")) return "app";
  try { if (/^\/dev\/(pts\/\d+|tty\w*)$/.test(readlinkSync(`/proc/${pid}/fd/0`))) return "terminal"; } catch {}
  return "process";
}

const heldBy = (path: string, locks: Lock[]): Holder => {
  const pid = lockHolder(path, locks);
  return pid === undefined ? FREE : { kind: lockKind(pid), ...(pid ? { pid } : {}) };
};

export const codexLock = (codexHome: string, threadId: string) => join(codexHome, "thread-writer-locks", `${threadId}.lock`);
// A Codex here keeps writer locks (this folder is there): a thread whose lock nothing holds has no process.
export const codexKeepsLocks = (codexHome: string) => existsSync(join(codexHome, "thread-writer-locks"));
export const codexHolder = (codexHome: string, threadId: string, locks = readLocks()): Holder => heldBy(codexLock(codexHome, threadId), locks);
export const agyHolder = (agyRoot: string, conversationId: string, locks = readLocks()): Holder => heldBy(join(agyRoot, "presence", `${conversationId}.lock`), locks);
