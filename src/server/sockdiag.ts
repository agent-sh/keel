// Who owns one TCP socket, asked of the kernel by the socket's own two ends:
// a sock_diag request over netlink names the address and port of each end
// and gets that socket's record back, one round trip whatever the number of
// sockets on the machine. The table of every socket (/proc/net/tcp) costs a
// read and a search of all of it for each new connection.
//
// Through bun:ffi and the C library the process already runs on: no native
// dependency. Linux only, on a little-endian machine. Anything this cannot
// do (another platform, a C library of another name, a kernel without the
// module, a reply it does not understand) is `null`, and the caller reads the
// table as before. So is "no such socket": only a socket the kernel names is
// an answer here.
import { dlopen, FFIType } from "bun:ffi";
import { endianness } from "node:os";

const AF_INET = 2, AF_INET6 = 10, AF_NETLINK = 16;
const SOCK_RAW = 3, SOCK_CLOEXEC = 0o2000000;
const NETLINK_SOCK_DIAG = 4, SOCK_DIAG_BY_FAMILY = 20, NLM_F_REQUEST = 1;
const IPPROTO_TCP = 6, MSG_DONTWAIT = 0x40, TCP_LISTEN = 10;
const HEADER = 16, REQUEST = 56, REPLY = 72;

type Lib = { socket(d: number, t: number, p: number): number; send(fd: number, b: Uint8Array, n: number, f: number): number | bigint; recv(fd: number, b: Uint8Array, n: number, f: number): number | bigint; close(fd: number): number };
let lib: Lib | null | undefined;
let fd = -1;
let seq = 0;
// Failures in a row: after a few the kernel is not asked again by this process.
let failed = 0;
const GIVE_UP = 3;

function open(): Lib | null {
  if (lib !== undefined) return lib;
  lib = null;
  if (process.platform !== "linux" || endianness() !== "LE") return lib;
  try {
    lib = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols as unknown as Lib;
  } catch {
    lib = null;
  }
  return lib;
}

// The request for the TCP socket whose local end is `local` and whose remote end is `remote`
// (addresses as 4 or 16 bytes, both of one length).
export function request(local: { bytes: number[]; port: number }, remote: { bytes: number[]; port: number }, n: number): Uint8Array {
  const b = new Uint8Array(HEADER + REQUEST), v = new DataView(b.buffer);
  v.setUint32(0, b.length, true);
  v.setUint16(4, SOCK_DIAG_BY_FAMILY, true);
  v.setUint16(6, NLM_F_REQUEST, true);
  v.setUint32(8, n, true);
  v.setUint8(16, local.bytes.length === 4 ? AF_INET : AF_INET6);
  v.setUint8(17, IPPROTO_TCP);
  v.setUint32(20, 0xffffffff, true); // every state
  v.setUint16(24, local.port, false);
  v.setUint16(26, remote.port, false);
  b.set(local.bytes, 28);
  b.set(remote.bytes, 44);
  v.setUint32(64, 0xffffffff, true); // no cookie: the ends name the socket
  v.setUint32(68, 0xffffffff, true);
  return b;
}

// The uid in a reply to request `n`, when it is the record of a connected socket with these two
// ports; null for anything else (an error, a listening socket the kernel fell back to, another reply).
export function uidIn(reply: Uint8Array, length: number, n: number, localPort: number, remotePort: number): number | null {
  if (length < HEADER + REPLY) return null;
  const v = new DataView(reply.buffer, reply.byteOffset, length);
  if (v.getUint16(4, true) !== SOCK_DIAG_BY_FAMILY || v.getUint32(8, true) !== n || v.getUint32(0, true) < HEADER + REPLY) return null;
  if (v.getUint8(17) === TCP_LISTEN || v.getUint16(20, false) !== localPort || v.getUint16(22, false) !== remotePort) return null;
  return v.getUint32(80, true);
}

// The socket's inode in the same reply (after its uid): what names it among a process's open files.
export function inodeIn(reply: Uint8Array, length: number, n: number, localPort: number, remotePort: number): number | null {
  if (uidIn(reply, length, n, localPort, remotePort) === null) return null;
  return new DataView(reply.buffer, reply.byteOffset, length).getUint32(84, true);
}

const reply = new Uint8Array(512);

// The uid that owns the TCP socket with these two ends, or null when the kernel was not asked or named none.
export const socketUid = (local: { bytes: number[]; port: number }, remote: { bytes: number[]; port: number }): number | null => ask(local, remote, uidIn);
// The inode of that socket, the same way.
export const socketInode = (local: { bytes: number[]; port: number }, remote: { bytes: number[]; port: number }): number | null => ask(local, remote, inodeIn);

function ask(local: { bytes: number[]; port: number }, remote: { bytes: number[]; port: number }, read: typeof uidIn): number | null {
  if (failed >= GIVE_UP || local.bytes.length !== remote.bytes.length || (local.bytes.length !== 4 && local.bytes.length !== 16)) return null;
  const c = open();
  if (!c) return null;
  try {
    if (fd < 0) fd = c.socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
    if (fd < 0) { failed++; return null; }
    const n = (seq = (seq + 1) >>> 0) || (seq = 1);
    const req = request(local, remote, n);
    if (Number(c.send(fd, req, req.length, 0)) !== req.length) throw new Error("send");
    // The kernel answers before send returns. A reply to an earlier request that was never read is passed over.
    for (let i = 0; i < 4; i++) {
      const got = Number(c.recv(fd, reply, reply.length, MSG_DONTWAIT));
      if (got < HEADER) throw new Error("recv");
      if (new DataView(reply.buffer).getUint32(8, true) !== n) continue;
      failed = 0;
      return read(reply, got, n, local.port, remote.port);
    }
    throw new Error("no reply");
  } catch {
    failed++;
    try { if (fd >= 0) c.close(fd); } catch {}
    fd = -1;
    return null;
  }
}
