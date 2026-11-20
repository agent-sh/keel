// A response that streams lines while its work is quiet for longer than the
// server's idle timeout arrives whole. Bun closes a response that sent nothing
// for that long (10 s as the daemon serves, checked every 4 s, so 8 to 12 s
// after the last byte): 13 s of quiet is past it.
import { expect, test } from "bun:test";
import { jsonLines } from "./streams.ts";

test("a JSON-lines response outlives the idle timeout while its work is quiet", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 10,
    fetch: () => jsonLines(async (line) => { line({ first: true }); await Bun.sleep(13_000); line({ done: true }); }),
  });
  try {
    const text = await (await fetch(server.url)).text();
    expect(text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))).toEqual([{ first: true }, { done: true }]);
  } finally {
    await server.stop(true);
  }
}, 30_000);
