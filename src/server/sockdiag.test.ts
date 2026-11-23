// The kernel asked for one socket's owner by its two ends: the request's
// bytes, what is taken from a reply, and a live connection of this process.
// No e2e reaches this: a page cannot tell which way its connection's owner was read.
import { expect, test } from "bun:test";
import { connect, createServer } from "node:net";
import { endsOf, uidLookup } from "./admission.ts";
import { readdirSync, readlinkSync } from "node:fs";
import { holderOf } from "./caller.ts";
import { request, socketInode, socketUid, uidIn } from "./sockdiag.ts";

test("the request names both ends in network order, and only a connected socket's record with those ports is an answer", () => {
  const req = request({ bytes: [127, 0, 0, 1], port: 40001 }, { bytes: [127, 0, 0, 2], port: 8080 }, 7);
  const v = new DataView(req.buffer);
  expect([req.length, v.getUint32(0, true), v.getUint16(4, true), v.getUint16(6, true), v.getUint32(8, true)]).toEqual([72, 72, 20, 1, 7]);
  expect([v.getUint8(16), v.getUint8(17), v.getUint16(24, false), v.getUint16(26, false)]).toEqual([2, 6, 40001, 8080]);
  expect([...req.slice(28, 32), ...req.slice(44, 48)]).toEqual([127, 0, 0, 1, 127, 0, 0, 2]);
  expect(request({ bytes: Array(15).fill(0).concat(1), port: 1 }, { bytes: Array(15).fill(0).concat(1), port: 2 }, 1)[16]).toBe(10);
  // A reply: the header, then the socket's record with its uid at byte 80.
  const reply = (over: { type?: number; seq?: number; state?: number; sport?: number; dport?: number; uid?: number; length?: number }) => {
    const b = new Uint8Array(96), r = new DataView(b.buffer);
    r.setUint32(0, 88, true); r.setUint16(4, over.type ?? 20, true); r.setUint32(8, over.seq ?? 7, true);
    r.setUint8(16, 2); r.setUint8(17, over.state ?? 1);
    r.setUint16(20, over.sport ?? 40001, false); r.setUint16(22, over.dport ?? 8080, false);
    r.setUint32(80, over.uid ?? 1000, true);
    return uidIn(b, over.length ?? 88, 7, 40001, 8080);
  };
  expect(reply({})).toBe(1000);
  expect(reply({ uid: 0 })).toBe(0);
  // An error (no such socket), a reply to another request, a short one: no answer.
  expect([reply({ type: 2 }), reply({ seq: 6 }), reply({ length: 36 })]).toEqual([null, null, null]);
  // The listening socket the kernel falls back to when no connection has these ends, and a socket of other ports.
  expect([reply({ state: 10, dport: 0 }), reply({ dport: 0 }), reply({ sport: 40002 }), reply({ dport: 8081 })]).toEqual([null, null, null, null]);
});

test.skipIf(process.platform !== "linux")("a live connection's owner is this account; ends that name no connection are no answer", async () => {
  const me = process.getuid!();
  for (const host of ["127.0.0.1", "::1"]) {
    const srv = createServer((c) => { c.on("error", () => {}); });
    try { await new Promise<void>((ok, no) => { srv.once("error", no); srv.listen(0, host, () => ok()); }); } catch { continue; } // no IPv6 here
    const port = (srv.address() as { port: number }).port;
    const s = connect({ host, port });
    await new Promise<void>((ok) => s.once("connect", () => ok()));
    const peer = { address: s.localAddress!, port: s.localPort! }, server = { address: host, port };
    const ask = (p: typeof peer, z: { address?: string; port: number }) => { const e = endsOf(p, z); return e ? socketUid(e[0], e[1]) : null; };
    expect({ host, uid: ask(peer, server) }).toEqual({ host, uid: me });
    // Its inode is the one this process's open file links to: the caller of a request is found by it (caller.ts).
    const e = endsOf(peer, server)!;
    const inode = socketInode(e[0], e[1])!;
    const mine = readdirSync("/proc/self/fd").map((f) => { try { return readlinkSync(`/proc/self/fd/${f}`); } catch { return ""; } });
    expect(mine).toContain(`socket:[${inode}]`);
    expect(holderOf(inode, [process.pid])).toBe(process.pid);
    expect(holderOf(inode, [process.pid], () => ["socket:[1]", "pipe:[2]"])).toBeUndefined();
    // The same connection named with a mapped address, where it has one.
    if (host === "127.0.0.1") expect(ask({ address: `::ffff:${peer.address}`, port: peer.port }, { address: "::ffff:127.0.0.1", port })).toBe(me);
    // The listening socket's own end, the ends the other way round with another port, a port nobody has, a daemon on every address.
    expect([ask({ address: host, port }, { address: host, port: peer.port + 1 }), ask(peer, { address: host, port: port === 65535 ? 1 : port + 1 }), ask(peer, { port })]).toEqual([null, null, null]);
    // The lookup gives the kernel's answer without reading the table, and the table's when the kernel names none.
    let reads = 0;
    const lookup = uidLookup(async () => { reads++; return [null, null]; }, () => 0, true, ask);
    expect([await lookup(peer, server), reads]).toEqual([me, 0]);
    expect([await lookup({ address: host, port: 9 }, server), reads]).toEqual(["unreadable", 1]);
    s.destroy();
    await new Promise<void>((ok) => srv.close(() => ok()));
    // Closed: no connection has these ends any more (a socket still winding down is not this account's to claim: 0 or none).
    await Bun.sleep(50);
    expect([null, 0]).toContain(ask(peer, server));
  }
});
