// A long transcript of mixed replies (images, tool calls, code, math, tables, tall and short
// replies), written into a state folder before its daemon starts.
// Usage: bun mixed-transcript.ts <state-dir> <workspace> <turns> <title>
import { deflateSync } from "node:zlib";
import { Store } from "../../../src/core/store.ts";

const [stateDir, workspace, count, title] = process.argv.slice(2);
const store = new Store(stateDir!);
function png(w: number, h: number, fill: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const at = y * (w * 3 + 1) + 1 + x * 3; const d = x < w * fill; raw[at] = d ? 58 : 220; raw[at + 1] = d ? 110 : 224; raw[at + 2] = d ? 190 : 230; }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const usage = { input: 1200, output: 300, cache_read: 40_000, cache_write: 900, cost: 0.0123 };
const words = "the parser reads each line and keeps the offsets so a later pass can report where a token began without reading the file again".split(" ");
const say = (k: number, n: number) => Array.from({ length: n }, (_, i) => words[(k * 7 + i * 3) % words.length]).join(" ");
const s = store.createSession({ title: title!, model: "scripted:stand-in", workspace: workspace! });
const id = s.id;
const add = (kind: Parameters<Store["append"]>[1], data: unknown) => store.append(id, kind, data);
const T = Number(count);
for (let t = 1; t <= T; t++) {
  const img = t % 5 === 0;
  add("user", { text: `Prompt ${t}: ${say(t, 14)}? Marker Zorblax${t}x`, ...(img ? { images: [{ type: "image", media_type: "image/png", data: png(320 + (t % 3) * 80, 140 + (t % 4) * 40, 0.3 + (t % 5) / 10) }] } : {}) });
  add("turn_start", { model: "scripted:stand-in" });
  const calls = 1 + (t % 4);
  for (let c = 1; c <= calls; c++) {
    const idc = `call-${t}-${c}`;
    const tool = c % 3 === 0 ? { name: "Edit", input: { file_path: `src/parse/file${c}.ts`, old_string: `const a = ${t};\nconst b = ${c};`, new_string: `const a = ${t + 1};\nconst b = ${c};\nconst z = ${say(t, 4).length};` } }
      : c % 3 === 2 ? { name: "Read", input: { file_path: `src/parse/file${c}.ts` } }
      : { name: "Bash", input: { command: `rg -n "token ${t}" src | head -20`, description: `Search for token ${t}` } };
    add("assistant", { model: "scripted:stand-in", usage, stop: "tool_use", blocks: [
      { type: "text", text: `Step ${c} of turn ${t}: ${say(t + c, 10 + (t * c) % 25)}.` },
      { type: "tool_use", id: idc, ...tool },
    ] });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: idc, content: Array.from({ length: 4 + ((t * c) % 40) }, (_, i) => `src/parse/file${i}.ts:${t + i}: ${say(t + i, 9)}`).join("\n") }] });
  }
  const tall = t % 4 === 0;
  const body = [
    `## Result ${t}`, `${say(t + 2, tall ? 120 : 30)}. Needle Qwertyuiop${t}z here.`,
    `- First: \`src/parse/file1.ts:${t}\` ${say(t + 3, 8)}\n- Second: ${say(t + 4, 10)}`,
    ...(t % 3 === 0 ? [`$$\\int_0^${t} x^2\\,dx = \\frac{${t}^3}{3}$$`, `Inline $e^{i\\pi}+1=0$ here.`] : []),
    ...(t % 2 === 0 ? [`| col a | col b | col c |\n|---|---|---|\n| ${t} | ${say(t, 2)} | ${say(t + 1, 3)} |\n| ${t + 1} | x | y |`] : []),
    "```ts\n" + Array.from({ length: tall ? 30 : 6 }, (_, i) => `export function step${t}_${i}(input: string): string[] { return input.split("\\n").filter(Boolean); }`).join("\n") + "\n```",
    `Reply ${t} ends here.`,
  ].join("\n\n");
  add("assistant", { model: "scripted:stand-in", usage, stop: "end_turn", blocks: [{ type: "text", text: body }] });
  add("turn_end", { reason: "end_turn", usage, ms: 4200, steps: calls + 1, tools: calls });
}
add("compaction", { mode: "summary", summary: "Goal: a generated history.", auto: true, tokens_before: 6400 });
store.db.close();
process.stdout.write(JSON.stringify([id]) + "\n");
