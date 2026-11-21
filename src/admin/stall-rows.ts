// Words for a stall's cause that the page shares with the daemon (the
// Daemon panel's list, the Errors row): nothing here reads a file.
import type { CauseKind } from "./stall-cause.ts";

// What a list of stalls calls each kind, and whose it is to fix: the
// daemon's own doing (its code, a call it made, a child it waited for), or
// the machine's (no processor, a stop, a sleep).
export const CAUSE_LABEL: Record<CauseKind, string> = {
  compute: "Own code", call: "System call", child: "Child process", disk: "Disk", cpu_wait: "No processor", memory: "No memory", stopped: "Stopped", suspended: "Suspended", unknown: "Not known",
};
export const ownDoing = (kind: string) => kind === "compute" || kind === "call" || kind === "child" || kind === "disk";

export const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
