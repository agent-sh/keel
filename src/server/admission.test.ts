// Who holds the other end of a loopback connection, read from the kernel's
// socket table: which line answers for a connection, which read answers a new
// one, and what the loop does for it. No page can make a connection appear
// between two reads, or two connections on one port pair.
import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { tableAddresses, uidLookup, type Tables } from "./admission.ts";

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
// A line of the table: the connection from `from` to `to`, held by `uid`.
const line = (n: number, from: string, peer: number, to: string, server: number, uid: number) =>
  `${String(n).padStart(4)}: ${tableAddresses(from).at(-1 * (from.includes(":") ? 1 : 2))}:${hex(peer)} ${tableAddresses(to).at(-1 * (to.includes(":") ? 1 : 2))}:${hex(server)} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 4567${n} 1 0000000000000000 20 4 30 10 -1\n`;
const L = "127.0.0.1";

test("an address is written the way the kernel's table writes it", () => {
  expect(tableAddresses("127.0.0.1")).toEqual(["0100007F", "0000000000000000FFFF00000100007F"]);
  expect(tableAddresses("127.0.0.2")[0]).toBe("0200007F");
  expect(tableAddresses("::1")).toEqual(["00000000000000000000000001000000"]);
  expect(tableAddresses("::ffff:127.0.0.1")).toEqual(["0100007F", "0000000000000000FFFF00000100007F"]);
  expect(tableAddresses("fe80::1:2")).toEqual(["000080FE000000000000000002000100"]);
  for (const bad of ["localhost", "", "1.2.3", "1.2.3.256", "::1::2", "12345::"]) expect(tableAddresses(bad)).toEqual([]);
});

test("a connection is told from another on the same two ports by its addresses, in the answer and in the answer kept", async () => {
  // The owner's connection from 127.0.0.1 and another account's from 127.0.0.2, on one port pair, in either order.
  for (const order of [[1000, 1001], [1001, 1000]] as const) {
    const rows = { 1000: line(0, "127.0.0.1", 40001, L, 8080, 1000), 1001: line(1, "127.0.0.2", 40001, L, 8080, 1001) };
    let reads = 0;
    const uid = uidLookup(async () => { reads++; return [HEAD + order.map((u) => rows[u]).join(""), HEAD]; }, () => 0, true);
    expect(await uid({ address: "127.0.0.1", port: 40001 }, { address: L, port: 8080 })).toBe(1000);
    expect(await uid({ address: "127.0.0.2", port: 40001 }, { address: L, port: 8080 })).toBe(1001);
    // Within the second each is answered from what was kept for it, not for the other.
    expect(uid({ address: "127.0.0.1", port: 40001 }, { address: L, port: 8080 })).toBe(1000);
    expect(uid({ address: "127.0.0.2", port: 40001 }, { address: L, port: 8080 })).toBe(1001);
    expect(reads).toBe(2);
    // The mapped form of an address is the same address; another address on that port is no one's.
    expect(await uid({ address: "::ffff:127.0.0.2", port: 40001 }, { address: L, port: 8080 })).toBe(1001);
    expect(await uid({ address: "127.0.0.3", port: 40001 }, { address: L, port: 8080 })).toBe("unlisted");
  }
  // The same client address and port to two addresses of this machine, held by two accounts.
  const two = HEAD + line(0, L, 40001, "127.0.0.1", 8080, 1000) + line(1, L, 40001, "127.0.0.2", 8080, 1001);
  const uid = uidLookup(async () => [two, HEAD], () => 0, true);
  // A daemon on one address knows which line is its own.
  expect(await uid({ address: L, port: 40001 }, { address: "127.0.0.1", port: 8080 })).toBe(1000);
  expect(await uid({ address: L, port: 40001 }, { address: "127.0.0.2", port: 8080 })).toBe(1001);
  // One on every address does not: the connection is no single account's, and is not taken for the owner's.
  expect(await uid({ address: L, port: 40001 }, { port: 8080 })).toBe("shared");
  // Two lines of one account are that account's.
  const same = uidLookup(async () => [HEAD + line(0, L, 40001, "127.0.0.1", 8080, 1000) + line(1, L, 40001, "127.0.0.2", 8080, 1000), HEAD], () => 0, true);
  expect(await same({ address: L, port: 40001 }, { port: 8080 })).toBe(1000);
  // An IPv6 connection is in the IPv6 table only.
  const six = uidLookup(async () => [HEAD, HEAD + line(0, "::1", 40001, "::1", 8080, 1000)], () => 0, true);
  expect(await six({ address: "::1", port: 40001 }, { address: "::1", port: 8080 })).toBe(1000);
  expect(await six({ address: "127.0.0.1", port: 40001 }, { address: "::1", port: 8080 })).toBe("unlisted");
  // The server's own end of a connection is not the client's: the ports are not swapped.
  expect(await uid({ address: L, port: 8080 }, { address: L, port: 40001 })).toBe("unlisted");
  // On Linux a table that cannot be read is no answer in the owner's favor; elsewhere there is no table to ask.
  expect(await uidLookup(async () => [null, null], () => 0, true)({ address: L, port: 40001 }, { address: L, port: 8080 })).toBe("unreadable");
  expect(await uidLookup(async () => [null, null], () => 0, false)({ address: L, port: 40001 }, { address: L, port: 8080 })).toBeUndefined();
  // One table missing (no IPv6 on the machine) is not unreadable.
  expect(await uidLookup(async () => [HEAD + line(0, L, 40001, L, 8080, 1000), null], () => 0, true)({ address: L, port: 40001 }, { address: L, port: 8080 })).toBe(1000);
});

test("a new connection is answered by a read that started after it arrived, and a known one by none", async () => {
  // Each read gives the table as it stands when it starts, and ends when the test lets it.
  let tables: Tables = [HEAD + line(0, L, 40001, L, 8080, 1000) + line(1, L, 8080, L, 40001, 1000) + line(2, L, 40002, L, 8080, 1001), HEAD];
  const reads: { done: () => void }[] = [];
  const read = () => {
    const now = tables;
    return new Promise<Tables>((resolve) => reads.push({ done: () => resolve(now) }));
  };
  let clock = 0;
  const lookup = uidLookup(read, () => clock, true);
  const uid = (port: number) => lookup({ address: L, port }, { address: L, port: 8080 });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  // The first connection starts a read. Two more arrive while it runs: the read under way
  // started before them, so they wait for the one after it, and share it.
  const first = uid(40001);
  expect(first).toBeInstanceOf(Promise);
  // A connection on port 40002 was there when the first read started, held by another account; it has closed
  // and the port is the owner's now. The read under way still says the other account.
  tables = [HEAD + line(0, L, 40001, L, 8080, 1000) + line(2, L, 40002, L, 8080, 1000) + line(3, L, 40003, L, 8080, 0), HEAD];
  const second = uid(40002), third = uid(40003);
  expect(reads.length).toBe(1);
  reads[0]!.done();
  expect(await first).toBe(1000);
  await settle();
  expect(reads.length).toBe(2);
  reads[1]!.done();
  expect([await second, await third]).toEqual([1000, 0]);
  expect(reads.length).toBe(2);

  // Within a second the same connection asks nothing of the kernel; after it, it reads again.
  expect(uid(40001)).toBe(1000);
  expect(uid(40002)).toBe(1000);
  expect(reads.length).toBe(2);
  clock = 1000;
  const again = uid(40001);
  expect(reads.length).toBe(3);
  reads[2]!.done();
  expect(await again).toBe(1000);
  // A connection the table does not list is told so, and that is kept for the second too.
  const missing = uid(40009);
  reads[3]!.done();
  expect(await missing).toBe("unlisted");
  expect(uid(40009)).toBe("unlisted");
});

test("the real table names this process as the holder of its own connections, one from each of two addresses on one port", async () => {
  if (process.platform !== "linux") return;
  const server = createServer((s) => s.on("data", () => {}));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const open = (opts: object) => new Promise<Socket>((resolve, reject) => { const s = connect({ host: "127.0.0.1", port, ...opts }); s.once("connect", () => resolve(s)); s.once("error", reject); });
  const first = await open({});
  // The kernel takes a second connection from 127.0.0.2 with the first one's source port.
  const second = await open({ localAddress: "127.0.0.2", localPort: first.localPort });
  try {
    const uid = uidLookup();
    const me = process.getuid!();
    expect(await uid({ address: "127.0.0.1", port: first.localPort! }, { address: "127.0.0.1", port })).toBe(me);
    expect(await uid({ address: "127.0.0.2", port: first.localPort! }, { address: "127.0.0.1", port })).toBe(me);
    expect(await uid({ address: "127.0.0.3", port: first.localPort! }, { address: "127.0.0.1", port })).toBe("unlisted");
    // The daemon's own address is part of the match: this connection did not go to 127.0.0.9.
    expect(await uid({ address: "127.0.0.1", port: first.localPort! }, { address: "127.0.0.9", port })).toBe("unlisted");
    // With no address of its own (it listens on every one), both lines of the port pair are this account's.
    expect(await uid({ address: "127.0.0.1", port: first.localPort! }, { port })).toBe(me);
  } finally {
    first.destroy();
    second.destroy();
    server.close();
  }
});

// The line of a connection is found by a plain search for its local end, and
// the pattern that decides is tried on that line alone. The answer is the one
// the pattern gives when it is matched against the whole table: over tables of
// thousands of sockets with lines that differ from the one looked for in one
// field each.
test("the holder found by searching for the line is the one the pattern finds over the whole table", async () => {
  const hex4 = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
  // As it was: the pattern over every line of both tables.
  const whole = (tables: Tables, peer: { address: string; port: number }, server: { address?: string; port: number }) => {
    const from = tableAddresses(peer.address), to = server.address ? tableAddresses(server.address) : [];
    if (!from.length || (server.address && !to.length)) return "unlisted";
    const line = new RegExp(`^\\s*\\d+: (?:${from.join("|")}):${hex4(peer.port)} ${to.length ? `(?:${to.join("|")})` : "[0-9A-F]+"}:${hex4(server.port)} (?:\\S+\\s+){4}(\\d+)`, "gm");
    const uids = new Set<number>();
    for (const t of tables) if (t !== null) for (const m of (t as string).matchAll(line)) uids.add(Number(m[1]));
    return uids.size === 0 ? "unlisted" : uids.size === 1 ? [...uids][0]! : "shared";
  };
  let rnd = 5;
  const rand = (n: number) => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) % n);
  const v4 = ["127.0.0.1", "127.0.0.2", "10.0.0.7"], v6 = ["::1", "::ffff:127.0.0.1", "fe80::1:2"];
  const rows4: string[] = [], rows6: string[] = [];
  for (let n = 0; n < 4000; n++) {
    const six = rand(3) === 0;
    // Few addresses and ports, so every line shares fields with others, and some all four with another account's.
    (six ? rows6 : rows4).push(line(n, (six ? v6 : v4)[rand(3)]!, 40000 + rand(900), (six ? v6 : v4)[rand(3)]!, 8080 + rand(3), 1000 + rand(3)));
  }
  const tables: Tables = [HEAD + rows4.join(""), HEAD + rows6.join("")];
  const uid = uidLookup(async () => tables, () => 0, true);
  const seen = new Set<string>();
  for (let n = 0; n < 1500; n++) {
    const peer = { address: [...v4, ...v6][rand(6)]!, port: 40000 + rand(905) };
    const server = { address: rand(4) === 0 ? undefined : [...v4, ...v6][rand(6)]!, port: 8080 + rand(4) };
    const want = whole(tables, peer, server);
    expect({ peer, server, owner: await uid(peer, server) }).toEqual({ peer, server, owner: want });
    seen.add(typeof want === "number" ? "one" : want);
  }
  expect([...seen].sort()).toEqual(["one", "shared", "unlisted"]);
});
