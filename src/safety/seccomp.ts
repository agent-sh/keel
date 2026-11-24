// The syscall filter of the command sandbox: a seccomp-BPF program that denies a
// short list of kernel calls a sandboxed command has no use for, and allows the
// rest. bubblewrap loads it with `--seccomp FD` before it starts the command, so
// the command and everything it starts is under it and cannot remove it.
//
// This is a deny list over an otherwise open sandbox, not a policy of what a
// command may do. It exists because the sandbox gives its commands a network
// namespace of their own, and these calls are ways to act outside it:
//
// - The kernel keyring (add_key, request_key, keyctl). The keyrings are not
//   namespaced by the user or network namespace the sandbox makes. request_key
//   asks the kernel to run /sbin/request-key in the host's root, outside the
//   sandbox and its network namespace, to build a key (request-key(8),
//   keyrings(7)); a key put in the session or user keyring is seen by every
//   process of the user outside the sandbox. A sandbox that has no keys of its
//   own needs none of this.
// - The x32 ABI (x86_64 only). x32 calls reach the kernel with the 0x40000000 bit
//   set on an x86_64 syscall number; a filter that matches calls by number, as
//   this one and any other does, can be passed by setting the bit
//   (seccomp(2): "x32 ... a filter must check the architecture and the bit").
//   Nothing a build or a test runs uses x32, so the whole range is denied.
//
// Both are the ones Codex's Linux sandbox denies. A denied call returns EPERM,
// never kills the process: a program that probes for a keyring (a credential
// helper, glibc's NSS) falls back as it does on a kernel that has none.
//
// The program is made here, as the bytes bubblewrap reads (an array of
// `struct sock_filter`, native byte order, seccomp(2)): no library is linked.
import { createHash } from "node:crypto";
import { endianness } from "node:os";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitViewsDir } from "../core/git.ts";

// The ABIs a call can reach the kernel by, with the value seccomp reports for each (AUDIT_ARCH_*, linux/audit.h:
// the ELF machine, 0x80000000 for 64 bit, 0x40000000 for little endian).
export type Abi = "x86_64" | "i386" | "aarch64" | "arm";
export const AUDIT_ARCH: Record<Abi, number> = { x86_64: 0xc000003e, i386: 0x40000003, aarch64: 0xc00000b7, arm: 0x40000028 };
// A host runs its own ABI and the 32 bit one its kernel can emulate: both are filtered, with their own call numbers.
export const HOST_ABIS: Record<string, Abi[]> = { x64: ["x86_64", "i386"], arm64: ["aarch64", "arm"] };

// The calls denied by number. Numbers are those of each ABI's own table (arch/x86/entry/syscalls/syscall_64.tbl and
// syscall_32.tbl, include/uapi/asm-generic/unistd.h for aarch64, arch/arm/tools/syscall.tbl).
export type Denied = { name: string; why: string; nr: Record<Abi, number> };
export const DENIED: Denied[] = [
  { name: "add_key", why: "puts a key in a keyring the host's processes of this user share: keyrings are not namespaced", nr: { x86_64: 248, i386: 286, aarch64: 217, arm: 309 } },
  { name: "request_key", why: "makes the kernel run /sbin/request-key in the host's root, outside the sandbox and its network namespace", nr: { x86_64: 249, i386: 287, aarch64: 218, arm: 310 } },
  { name: "keyctl", why: "reads and changes the keys and keyrings of the host's processes of this user, and joins their session keyring", nr: { x86_64: 250, i386: 288, aarch64: 219, arm: 311 } },
];
// x86_64 numbers with this bit set are the x32 ABI's: all of them are denied, whatever the call.
export const X32_BIT = 0x40000000;
export const X32_WHY = "the x32 ABI is the x86_64 one with this bit set on the call number, which a filter matching numbers does not see unless it checks the bit; nothing a build runs uses it";

const ERRNO_EPERM = 0x00050000 | 1; // SECCOMP_RET_ERRNO | EPERM
const ALLOW = 0x7fff0000; // SECCOMP_RET_ALLOW
// seccomp_data: { int nr; __u32 arch; ... }
const AT_NR = 0, AT_ARCH = 4;
// BPF opcodes (linux/filter.h)
const LD_W_ABS = 0x20, JEQ_K = 0x15, JGE_K = 0x35, RET_K = 0x06;

type Ins = { code: number; k: number; jt?: string | number; jf?: string | number };

// The program for the ABIs, as instructions with named jump targets resolved to the forward offsets BPF needs.
// Layout: load the arch; one test per ABI that jumps to its block; an arch that is none of them is denied (it
// cannot happen on these hosts, and a program that cannot say what the call is should not run it); each block
// loads the call number, denies the x32 range and the listed numbers and allows the rest; the deny is last.
function assemble(abis: Abi[]): { code: number; k: number; jt: number; jf: number }[] {
  const code: (Ins & { label?: string })[] = [{ code: LD_W_ABS, k: AT_ARCH }];
  for (const a of abis) code.push({ code: JEQ_K, k: AUDIT_ARCH[a], jt: `abi:${a}`, jf: 0 });
  code.push({ code: RET_K, k: ERRNO_EPERM });
  for (const a of abis) {
    code.push({ code: LD_W_ABS, k: AT_NR, label: `abi:${a}` });
    if (a === "x86_64") code.push({ code: JGE_K, k: X32_BIT, jt: "deny", jf: 0 });
    for (const d of DENIED) code.push({ code: JEQ_K, k: d.nr[a], jt: "deny", jf: 0 });
    code.push({ code: RET_K, k: ALLOW });
  }
  code.push({ code: RET_K, k: ERRNO_EPERM, label: "deny" });
  const at = new Map<string, number>();
  code.forEach((c, i) => c.label && at.set(c.label, i));
  return code.map((c, i) => {
    const off = (t: string | number | undefined): number => (typeof t === "string" ? at.get(t)! - i - 1 : t ?? 0);
    return { code: c.code, k: c.k, jt: off(c.jt), jf: off(c.jf) };
  });
}

// `struct sock_filter { __u16 code; __u8 jt; __u8 jf; __u32 k; }`, eight bytes, in the machine's byte order.
export function filterBytes(abis: Abi[]): Uint8Array {
  const prog = assemble(abis);
  const out = new Uint8Array(prog.length * 8);
  const v = new DataView(out.buffer);
  const le = endianness() === "LE";
  prog.forEach((c, i) => {
    if (c.jt > 255 || c.jf > 255) throw new Error("seccomp: a jump is past what BPF can reach");
    v.setUint16(i * 8, c.code, le);
    v.setUint8(i * 8 + 2, c.jt);
    v.setUint8(i * 8 + 3, c.jf);
    v.setUint32(i * 8 + 4, c.k, le);
  });
  return out;
}

// The program this machine's sandbox uses, none for a CPU whose ABIs are not in the tables.
export const hostAbis = (): Abi[] | undefined => (process.platform === "linux" ? HOST_ABIS[process.arch] : undefined);

// The program as a file of Keel's state folder, named by its bytes: bubblewrap reads it through a descriptor the
// command's wrapper opens (src/safety/sandbox.ts). Written whole by a rename, made again when it is gone.
export function filterFile(abis: Abi[] | undefined = hostAbis()): string | undefined {
  if (!abis) return undefined;
  const bytes = filterBytes(abis);
  const dir = join(dirname(gitViewsDir()), "seccomp");
  const file = join(dir, `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.bpf`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  }
  return file;
}

// The descriptor bubblewrap is told to read the program from: one digit, because dash takes no more in a redirection,
// and not 7, 8 or 9, which the layer wrapper uses. The wrapper opens it for the one command it execs.
export const FILTER_FD = 6;
// The head that puts the program on that descriptor and becomes the command that follows it.
export const withFilter = (file: string): string[] => ["/bin/sh", "-c", `exec "$@" ${FILTER_FD}<"$0"`, file];
