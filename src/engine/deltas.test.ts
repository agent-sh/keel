// A stream's pieces joined into frames: the text is the stream's, in order,
// the first piece is not held, and what a scan holds back goes out with the
// block's end. No page can count the frames it was not sent.
import { expect, test } from "bun:test";
import { StreamScan, Vault } from "../safety/secrets.ts";
import { DeltaJoin, type Delta } from "./deltas.ts";

const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

test("a stream's pieces go on as a frame a moment, the first at once, and its end sends what waits", async () => {
  const frames: (Delta & { session: string; at: number })[] = [];
  const t0 = performance.now();
  const join = new DeltaJoin((session, d) => frames.push({ session, ...d, at: performance.now() - t0 }), 40);
  // Two sessions stream at once, a few characters a piece, every 2 ms for 200 ms.
  const said: Record<string, string> = { a: "", b: "" };
  for (let i = 0; i < 100; i++) {
    for (const s of ["a", "b"]) { const text = `w${i} `; said[s] += text; join.push(s, { index: 1, kind: "text", text }); }
    await Bun.sleep(2);
  }
  // The first piece of each went on at once, alone.
  expect(frames.filter((f) => f.session === "a")[0]).toMatchObject({ text: "w0 ", index: 1, kind: "text" });
  expect(frames[0]!.at).toBeLessThan(20);
  join.end("a");
  join.end("b");
  // The text is the stream's, in order, in far fewer frames than pieces, a frame every 40 ms or so.
  for (const s of ["a", "b"]) {
    const mine = frames.filter((f) => f.session === s);
    expect(mine.map((f) => f.text).join("")).toBe(said[s]!);
    expect(mine.length).toBeGreaterThan(3);
    expect(mine.length).toBeLessThan(16);
  }
  // After the end nothing waits: a late timer sends nothing.
  const n = frames.length;
  await Bun.sleep(80);
  expect(frames.length).toBe(n);
});

test("blocks keep their order and their kind, and a block the stream left is sent whole before the next", () => {
  const frames: Delta[] = [];
  let now = 0;
  const join = new DeltaJoin((_s, d) => frames.push(d), 40, () => now);
  join.push("s", { index: 0, kind: "thinking", text: "let me " });
  now = 5;
  join.push("s", { index: 0, kind: "thinking", text: "think" });
  join.push("s", { index: 1, kind: "text", text: "The answer " });
  join.push("s", { index: 1, kind: "text", text: "is 4." });
  join.push("s", { index: 2, kind: "tool_input", text: '{"command":', name: "Bash" });
  join.push("s", { index: 2, kind: "tool_input", text: '"ls"}', name: "Bash" });
  join.end("s");
  expect(frames).toEqual([
    { index: 0, kind: "thinking", text: "let me " },
    { index: 0, kind: "thinking", text: "think" },
    { index: 1, kind: "text", text: "The answer is 4." },
    { index: 2, kind: "tool_input", name: "Bash", text: '{"command":"ls"}' },
  ]);
});

test("a secret cut between two pieces never goes on, and the end of a block is sent when the stream moves on", () => {
  const frames: Delta[] = [];
  let now = 0;
  const join = new DeltaJoin((_s, d) => frames.push(d), 40, () => now);
  const vault = new Vault();
  const scan = new StreamScan(vault);
  join.scan = { piece: (s, i, text) => scan.piece(`${s} ${i}`, s, text), end: (s, i) => scan.end(`${s} ${i}`, s) };
  // Each piece is sent as it comes (the clock moves past the joining time between them).
  const pieces = ["The token is gh", `p_${GH.slice(4, 20)}`, `${GH.slice(20)} and`, " that is all", "."];
  for (const text of pieces) { join.push("s", { index: 0, kind: "thinking", text }); now += 50; }
  join.push("s", { index: 1, kind: "text", text: "Done" });
  now += 50;
  join.push("s", { index: 1, kind: "text", text: " now" });
  join.end("s");
  const shown = (i: number) => frames.filter((f) => f.index === i).map((f) => f.text).join("");
  expect(shown(0)).toBe(`The token is ${vault.redact(GH, "s", "output")} and that is all.`);
  expect(shown(1)).toBe("Done now");
  for (const f of frames) for (let n = 8; n <= GH.length; n++) expect(f.text.includes(GH.slice(0, n))).toBe(false);
  // The thinking block's last word was held (it could have grown) and went out before the text block's first frame.
  const firstText = frames.findIndex((f) => f.index === 1);
  expect(frames.slice(0, firstText).map((f) => f.text).join("")).toBe(shown(0));
});
