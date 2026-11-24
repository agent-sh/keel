// What the sandbox's syscall filter is doing, in words: from the status the daemon sends
// (`seccomp`, and `seccompReason` when it is off). A daemon that knows no filter sends neither, and
// nothing is said. Pure: the permission menu and the network panel read it.
export type FilterInfo = { available?: boolean; seccomp?: boolean; seccompReason?: string };
export type FilterSaid = { on: boolean; words: string };

export function filterSaid(sb: FilterInfo | null | undefined): FilterSaid | undefined {
  if (!sb?.available || typeof sb.seccomp !== "boolean") return undefined;
  if (sb.seccomp) return { on: true, words: "The syscall filter is on: a confined command may make only the system calls the filter allows." };
  return { on: false, words: `The syscall filter is off${sb.seccompReason ? `: ${sb.seccompReason}` : ""}. Commands are still confined by the sandbox's mounts and namespaces.` };
}
