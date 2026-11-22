// The client against a stand-in server (test/e2e/fixtures/lsp-standin.ts): the
// cases that need a server's timing, which no pure test reaches and an e2e
// cannot shorten.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { LspClient } from "./client.ts";

const standin = join(import.meta.dir, "../../test/e2e/fixtures/lsp-standin.ts");
const start = (mode: string, pause = 0, limits: Record<string, number> = {}) => {
  let ended = "";
  const client = new LspClient({ name: mode, argv: [process.execPath, standin, mode, String(pause)], cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "" }, root: import.meta.dir, limits, onEnd: (why) => { ended = why; } });
  return { client, why: () => ended };
};

test("the question about a file as it was is answered although the file moved on before the server was ready", async () => {
  const { client } = start("slowinit", 400);
  // Both texts are given, and both questions asked, while the server has not answered initialize yet.
  const before = client.diagnostics("/w/a.txt", client.sync("/w/a.txt", "fine\n", "plaintext"));
  const after = client.diagnostics("/w/a.txt", client.sync("/w/a.txt", "an ERROR\n", "plaintext"));
  expect(await before).toEqual([]);
  expect((await after)!.map((d) => d.line)).toEqual([1]);
  expect(client.readyMs).toBeGreaterThanOrEqual(350);
  await client.stop();
});

test("a server that pushes and stops answering is ended, however many questions follow one another", async () => {
  const { client, why } = start("deaf", 0, { requestMs: 300 });
  await client.ready;
  // A new text every 50 ms: each question takes the last one's place, and none is answered.
  const asked: Promise<unknown>[] = [];
  for (let i = 0; i < 12 && !client.ended; i++) { asked.push(client.diagnostics("/w/a.txt", client.sync("/w/a.txt", `text ${i}\n`, "plaintext"))); await Bun.sleep(50); }
  await Bun.sleep(400);
  expect(client.ended).toContain("it stopped answering");
  expect(why()).toContain("it stopped answering");
  expect(await Promise.all(asked)).toEqual(Array(asked.length).fill(null));
});

test("pushes for files nobody opened and work nobody ends fill nothing, and an ended client holds nothing", async () => {
  const { client } = start("pushmany");
  const got = await client.diagnostics("/w/a.txt", client.sync("/w/a.txt", "an ERROR\n", "plaintext"));
  expect(got).toHaveLength(1);
  expect(client.held).toMatchObject({ docs: 1, pushed: 1 });
  expect(client.held.progress).toBeLessThanOrEqual(256);
  await client.stop();
  expect(client.held).toEqual({ docs: 0, pushed: 0, pulled: 0, waiters: 0, progress: 0 });
});
