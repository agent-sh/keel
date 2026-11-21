// Who holds the other end of a loopback connection, read from the kernel's
// socket table: which read answers a new connection, and what the loop does
// for it. No page can make a connection appear between two reads.
import { expect, test } from "bun:test";
import { uidLookup, type Tables } from "./admission.ts";

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const v4 = (n: number, peer: number, server: number, uid: number) =>
  `${String(n).padStart(4)}: 0100007F:${peer.toString(16).toUpperCase().padStart(4, "0")} 0100007F:${server.toString(16).toUpperCase().padStart(4, "0")} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 4567${n} 1 0000000000000000 20 4 30 10 -1\n`;
const v6 = (n: number, peer: number, server: number, uid: number) =>
  `${String(n).padStart(4)}: 00000000000000000000000001000000:${peer.toString(16).toUpperCase().padStart(4, "0")} 00000000000000000000000001000000:${server.toString(16).toUpperCase().padStart(4, "0")} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 9876${n} 1 0000000000000000 20 4 30 10 -1\n`;

test("a new client port is answered by a read that started after it arrived, and a known one by none", async () => {
  // Each read gives the table as it stands when it starts, and ends when the test lets it.
  let tables: Tables = [HEAD + v4(0, 40001, 8080, 1000) + v4(1, 8080, 40001, 1000), HEAD];
  const reads: { done: () => void }[] = [];
  const read = () => {
    const now = tables;
    return new Promise<Tables>((resolve) => reads.push({ done: () => resolve(now) }));
  };
  let clock = 0;
  const uid = uidLookup(read, () => clock);

  // The first connection starts a read; a second one arriving meanwhile is not in it.
  const first = uid(40001, 8080);
  expect(first).toBeInstanceOf(Promise);
  tables = [tables[0]!, HEAD + v6(0, 40002, 8080, 1001)];
  const second = uid(40002, 8080);
  expect(reads.length).toBe(1);
  reads[0]!.done();
  expect(await first).toBe(1000);
  // It waited for the read under way, did not find itself, and read again.
  await Bun.sleep(0);
  expect(reads.length).toBe(2);
  reads[1]!.done();
  expect(await second).toBe(1001);

  // Within a second the same port asks nothing of the kernel; after it, it reads again.
  expect(uid(40001, 8080)).toBe(1000);
  expect(uid(40002, 8080)).toBe(1001);
  expect(reads.length).toBe(2);
  clock = 1000;
  const again = uid(40001, 8080);
  expect(reads.length).toBe(3);
  // Connections that arrive during one read share it when it lists them.
  tables = [HEAD + v4(0, 40001, 8080, 1000) + v4(1, 40003, 8080, 0), HEAD];
  reads[2]!.done();
  expect(await again).toBe(1000);
  const a = uid(40003, 8080), b = uid(40003, 8080);
  expect(reads.length).toBe(4);
  reads[3]!.done();
  expect([await a, await b]).toEqual([0, 0]);
  expect(reads.length).toBe(4);

  // The server's own end of a connection is not the client's: the ports are not swapped.
  clock = 5000;
  const swapped = uid(8080, 40001);
  reads[4]!.done();
  expect(await swapped).toBeNull();
  // A connection the table does not list is told apart from a machine with no table.
  const missing = uid(40009, 8080);
  reads[5]!.done();
  expect(await missing).toBeNull();
  const none = uidLookup(async () => [null, null], () => clock);
  expect(await none(40001, 8080)).toBeUndefined();
});

test("the real table names this process as the owner of its own connection", async () => {
  if (process.platform !== "linux") return;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => Response.json(srv.requestIP(req)) });
  try {
    // A kept connection: its line is in the table while the lookup runs.
    const res = await fetch(`http://127.0.0.1:${server.port}/`, { keepalive: true });
    const peer = (await res.json()) as { port: number };
    expect(await uidLookup()(peer.port, server.port!)).toBe(process.getuid!());
  } finally {
    server.stop(true);
  }
});
