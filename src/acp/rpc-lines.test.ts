import { expect, test } from "bun:test";
import { pumpLines } from "../core/proc.ts";
import { AcpConnection, LINE_MAX } from "./rpc.ts";

const pipe = (...parts: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });

test("a line over the limit is dropped up to its newline, however it is cut into pieces, and the lines around it are kept", async () => {
  const got: string[] = [];
  const over: number[] = [];
  await pumpLines(pipe("a\nbb", "bbbbbbbbbb", "bbbbb\nc\n", "dddddddddddddddddddd", "\ne"), (l) => got.push(l), "t", { max: 12, over: (n) => over.push(n) });
  expect(got).toEqual(["a", "c", "e"]);
  expect(over).toEqual([17, 20]);
});

test("a line over the limit at the end of the stream is told, and a limit changes nothing for lines within it", async () => {
  const got: string[] = [], over: number[] = [];
  await pumpLines(pipe("x\n", "y".repeat(30)), (l) => got.push(l), "t", { max: 10, over: (n) => over.push(n) });
  expect(got).toEqual(["x"]);
  expect(over).toEqual([30]);
  const all: string[] = [];
  await pumpLines(pipe("p\nq", "r\n"), (l) => all.push(l), "t", { max: 10, over: () => {} });
  expect(all).toEqual(["p", "qr"]);
});

test("a line of an agent over the most Keel reads is not parsed, the agent's next messages are, and the owner's hook hears of it", async () => {
  const code = `const big = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: "z".repeat(${LINE_MAX + 10}) } });
process.stdout.write(big + "\\n" + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { ok: 1 } }) + "\\n");`;
  const c = new AcpConnection([process.execPath, "-e", code], { cwd: "/" }, () => {});
  const seen: any[] = [], sizes: number[] = [];
  c.onNotification = (_m, p) => seen.push(p);
  c.onOversize = (n) => sizes.push(n);
  await c.exited;
  await Bun.sleep(50);
  expect(seen).toEqual([{ ok: 1 }]);
  expect(sizes).toHaveLength(1);
  expect(sizes[0]).toBeGreaterThan(LINE_MAX);
});
