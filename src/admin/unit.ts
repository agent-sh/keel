// The systemd user unit for keel-bun. `keel service install` writes it to
// ~/.config/systemd/user/keel-bun.service with ExecStart pointing at the binary
// that ran it; it never enables or starts it. To use it:
//   systemctl --user daemon-reload && systemctl --user enable --now keel-bun.service
//
// A unit that is already installed is brought up to a newer build by `keel
// service update` (updateUnit below): the lines this file owns are set, every
// other line of the unit and every drop-in beside it stay as they are.
//
// The restart. `keel restart` drains and exits 75, and the unit starts the
// daemon again after RestartSec. That wait is time nothing answers, so it is
// 100 ms: long enough for the old process to be gone from its port, short
// against the daemon's own start.
// The starts are not bounded (StartLimitIntervalSec=0). systemd's own bound
// is five starts in ten seconds, and any bound short enough to stop a daemon
// that cannot start is also reached by restarts asked for one after the
// other (each takes well under a second): the unit then goes failed and the
// daemon stays down until someone resets it. A daemon that cannot start (a
// taken port, a state folder another daemon holds, a bad argument) is kept
// from being started several times a second another way: under a service
// manager it waits two seconds before it exits (src/main.ts), the wait the
// unit made between starts before, kept for the failed start alone.
// StartLimitIntervalSec in [Unit] needs systemd 230; RestartSec has taken a
// unit since before that.
//
// Memory. The unit bounds what the daemon and the processes it keeps in its
// own control group may take: the daemon itself, and the MCP servers,
// language servers and provider plugins it starts (the commands a session
// runs are not in it: each runs in a scope of its own beside the unit, so a
// build is never counted here, and never killed by this bound). Without a
// bound a daemon that ran away took the machine with it, and where a
// drop-in forbids the unit swap (MemorySwapMax=0) none of it can be paged
// out.
// - MemoryHigh: an eighth of the machine's memory, at least 2 GB, at most
//   8 GB. Above it the kernel takes memory back from the group and slows
//   its allocations; it kills nothing. The daemon reads the kernel's count
//   of those moments and gives its kept events back when it rises
//   (src/core/rest.ts). The daemon alone stays under 900 MB on a heavy day;
//   the floor leaves the rest of 2 GB to the servers it keeps, and a share
//   of the machine above that because their number is the owner's.
// - MemoryMax: a quarter of the machine's memory, at least 4 GB, at most
//   16 GB: twice the throttle. Reaching it means something ran away for
//   good; the kernel then kills a process of the group.
// - OOMPolicy=continue: that kill ends the one process (the largest, a
//   runaway server as a rule), and the unit goes on. By default systemd
//   would stop the whole unit, the daemon with it. Should the daemon be the
//   one killed, Restart=on-failure starts it again.
// MemoryHigh and MemoryMax need systemd 231 and the unified control group
// hierarchy with the memory controller given to the user manager (every
// current distribution); elsewhere they are read and do nothing.
// OOMPolicy needs systemd 243.
import { totalmem } from "node:os";

const GB = 2 ** 30;
export function memoryBounds(totalBytes: number): { high: number; max: number } {
  const within = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  // Whole megabytes, as the unit writes them.
  const mbOf = (bytes: number) => Math.floor(bytes / 2 ** 20) * 2 ** 20;
  return { high: mbOf(within(totalBytes / 8, 2 * GB, 8 * GB)), max: mbOf(within(totalBytes / 4, 4 * GB, 16 * GB)) };
}
const template = `[Unit]
Description=Keel coding agent daemon (Bun)
After=network-online.target
Wants=network-online.target
# Starts are not bounded: restarts asked for one after the other must not
# leave the unit failed. A daemon that cannot start waits before it exits.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=@EXEC@
# \`keel restart\` drains and exits 75; on-failure starts it again. A plain stop
# drains too: running turns get up to KEEL_DRAIN_MS to finish, and the
# ones that do not are parked and continue after the next start.
Environment=KEEL_SUPERVISED=systemd
Environment=KEEL_DRAIN_MS=600000
# The runtime's collector timer is off (the daemon asks the collector itself:
# an idle daemon then makes a few wakeups a second, not two hundred).
Environment=BUN_GC_TIMER_DISABLE=1
Restart=on-failure
# The time nothing answers in a restart: the daemon's own start, and this.
RestartSec=100ms
KillSignal=SIGTERM
TimeoutStopSec=660
# What the daemon and the servers it keeps may take: throttled above the
# first, a process of the unit killed at the second, and the unit goes on.
MemoryHigh=@HIGH@M
MemoryMax=@MAX@M
OOMPolicy=continue
# Only the daemon is signalled: background commands outlive a restart and the
# new daemon takes them up again.
KillMode=process
# None of the unit's memory goes to swap: a page of the daemon that was
# swapped out is brought back from the disk on its next use, and its loop
# waits for as long as that takes.
MemorySwapMax=0

[Install]
WantedBy=default.target
`;

// One word of an ExecStart line, as systemd reads it back: in double quotes
// with its own escapes, and with the percent sign doubled (systemd expands
// specifiers). In an argument the dollar sign is doubled too (systemd expands
// variables there, never in the executable's path). A path with spaces stays
// one word.
export function unitWord(s: string, executable = false): string {
  if (/[\n\r\0]/.test(s)) throw new Error(`a path with a line break cannot go in a unit: ${JSON.stringify(s)}`);
  // systemd itself refuses these in the path it executes, however they are written.
  if (executable && /[\x00-\x1f\x7f"'\\]/.test(s)) throw new Error(`systemd does not start an executable whose path holds a quote, a backslash or a control character: ${JSON.stringify(s)}`);
  if (/^[\w@:.,/+=-]+$/.test(s)) return s;
  const q = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${executable ? q : q.replace(/\$/g, "$$$$")}"`;
}

// The unit for a daemon started as `command` (the binary, or bun and the
// script) on `bind`, with the workspace and state folder it is to use when
// they are given. Without them the daemon uses its defaults, as before.
export function unitFor(o: { command: string[]; bind: string; workspace?: string; stateDir?: string; totalMemory?: number }): string {
  const bounds = memoryBounds(o.totalMemory ?? totalmem());
  const words = [...o.command, "serve", "--bind", o.bind];
  if (o.workspace) words.push("--workspace", o.workspace);
  if (o.stateDir) words.push("--state-dir", o.stateDir);
  return template.replace("@EXEC@", () => words.map((w, i) => unitWord(w, i === 0)).join(" ")).replace("@HIGH@", String(bounds.high / 2 ** 20)).replace("@MAX@", String(bounds.max / 2 ** 20));
}

// The lines of a unit this file owns: an installed unit gets this build's
// value of each, wherever the owner put the line, and gets the line when it
// has none. Every other line is the owner's. An Environment line is owned by
// the variable it sets.
const OWNED: { section: string; key: string; name?: string }[] = [
  { section: "Unit", key: "StartLimitIntervalSec" },
  { section: "Service", key: "RestartSec" },
  { section: "Service", key: "Environment", name: "BUN_GC_TIMER_DISABLE" },
  { section: "Service", key: "MemoryHigh" },
  { section: "Service", key: "MemoryMax" },
  { section: "Service", key: "OOMPolicy" },
];

type Line = { section: string; text: string };
const linesOf = (unit: string): Line[] => {
  let section = "";
  return unit.split("\n").map((text) => {
    const m = /^\[(\w+)\]\s*$/.exec(text);
    if (m) section = m[1]!;
    return { section, text };
  });
};
// A line that sets the key, however it is spaced (systemd takes `Key = value`).
const sets = (l: Line, o: { section: string; key: string; name?: string }) =>
  l.section === o.section && new RegExp(o.name ? `^\\s*${o.key}\\s*=\\s*"?${o.name}=` : `^\\s*${o.key}\\s*=`).test(l.text);

// An installed unit with this build's values of the owned lines. `generated`:
// a unit this build writes (unitFor). Returns the new text and what changed,
// one line each: "RestartSec=2 is now RestartSec=100ms", "added MemoryHigh=...".
export function updateUnit(installed: string, generated: string): { text: string; changed: string[] } {
  const want = linesOf(generated);
  const have = linesOf(installed.replace(/\n$/, ""));
  const changed: string[] = [];
  for (const o of OWNED) {
    const at = want.findIndex((l) => sets(l, o));
    if (at < 0) continue;
    const line = want[at]!.text;
    const found = have.findIndex((l) => sets(l, o));
    if (found >= 0) {
      if (have[found]!.text === line) continue;
      changed.push(`${have[found]!.text} is now ${line}`);
      have[found] = { section: o.section, text: line };
      continue;
    }
    // Not there: added at the end of its section, with the comment this build writes above it.
    const comment: Line[] = [];
    for (let i = at - 1; i >= 0 && want[i]!.text.startsWith("#"); i--) comment.unshift({ section: o.section, text: want[i]!.text });
    // A comment already added with a line of the same block is not written twice.
    const fresh = comment.filter((c) => !have.some((l) => l.section === o.section && l.text === c.text));
    let end = have.findLastIndex((l) => l.section === o.section);
    if (end < 0) {
      have.push({ section: "", text: "" }, { section: o.section, text: `[${o.section}]` });
      end = have.length - 1;
    }
    while (end > 0 && have[end]!.text.trim() === "") end--;
    have.splice(end + 1, 0, ...fresh, { section: o.section, text: line });
    changed.push(`added ${line}`);
  }
  return { text: `${have.map((l) => l.text).join("\n")}\n`, changed };
}
