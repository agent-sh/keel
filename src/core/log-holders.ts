// Who holds the store's log at a start. The log a daemon leaves long is not always the mark of an
// unclean stop: a reader of another connection (a command, a viewer) that held the log open at the
// stop keeps it from being emptied, and it grows until that reader lets go. The holders are found
// from the descriptors processes have open (Linux's /proc; elsewhere none are found).
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type LogHolder = { pid: number; name: string };

// The processes other than `self` that have one of `files` open.
export function logHolders(files: string[], proc = "/proc", self = process.pid): LogHolder[] {
  const want = new Set(files);
  const out: LogHolder[] = [];
  let pids: string[];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const n of pids) {
    const pid = Number(n);
    if (pid === self) continue;
    try {
      const fds = readdirSync(`${proc}/${n}/fd`);
      if (!fds.some((fd) => { try { return want.has(readlinkSync(`${proc}/${n}/fd/${fd}`)); } catch { return false; } })) continue;
      let name = "";
      try { name = readFileSync(`${proc}/${n}/comm`, "utf8").trim(); } catch {}
      out.push({ pid, name: name || "a process" });
    } catch {}
  }
  return out;
}

// The line a start says while it reads a long log: what holds it when something does, else only its size.
export function logStartLine(mb: number, holders: LogHolder[]): string {
  if (!holders.length) return `[store] reading ${mb} MB of the store's log, not emptied by the daemon before this one`;
  const who = holders.slice(0, 3).map((h) => `${h.name} (pid ${h.pid})`).join(", ");
  return `[store] reading ${mb} MB of the store's log, held open by ${who}${holders.length > 3 ? ` and ${holders.length - 3} more` : ""}: it could not be emptied while they read`;
}
