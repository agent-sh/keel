// A session whose transcript holds what a long working day does: a prompt with
// images, notes of the harness, and one turn of forty tool calls (reads,
// searches, a plan, long diffs, a failed test run, an output over the size
// limit), written into a state folder before its daemon starts.
// Usage: bun work-transcript.ts <state-dir> <workspace>
// Prints { main, others: [..] } as JSON: the session with the long turn and
// three short ones for the other panes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Store } from "../../../src/core/store.ts";
import { ownerDenial, RESTART_CUT } from "../../../src/core/stops.ts";

const [stateDir, ws] = process.argv.slice(2) as [string, string];
const store = new Store(stateDir);
const MODEL = "scripted:stand-in";

// A small picture drawn here (a progress bar stopped part of the way), so the fixture carries no binary file.
function png(w: number, h: number, fill: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      const bar = y > h * 0.42 && y < h * 0.58 && x > w * 0.08 && x < w * 0.92;
      const done = bar && x < w * (0.08 + 0.84 * fill);
      const [r, g, b] = done ? [58, 110, 190] : bar ? [205, 210, 220] : y < h * 0.16 ? [36, 42, 56] : [246, 247, 250];
      raw[at] = r!; raw[at + 1] = g!; raw[at + 2] = b!;
    }
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

let n = 0;
const callId = () => `toolu_${(++n).toString(36).padStart(5, "0")}`;
const usage = (i: number, o: number) => ({ input: i, output: o, cache_read: i * 9, cache_write: Math.round(i / 3), cost: (i + o * 5 + i * 0.9) / 1e6 });
// `line`: where in the file an edit began (what the tool leaves for the call's card).
// `hook`: what a hook of the owner's did to the call (the input it ran with in place of the model's, an allow that answered its ask).
type Call = { name: string; input: any; result: string | any[]; error?: boolean; line?: number; hook?: { input?: any; allowed?: string } };
type Step = { think?: string; text?: string; calls?: Call[] };

function turn(s: string, t0: number, prompt: Record<string, unknown>, steps: Step[], end: Record<string, unknown> = {}) {
  let t = t0;
  store.append(s, "user", prompt, undefined, t);
  store.append(s, "turn_start", { model: MODEL, effort: "high" }, undefined, (t += 200));
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
  let tools = 0, errors = 0;
  for (const step of steps) {
    const blocks: any[] = [];
    if (step.think) blocks.push({ type: "thinking", thinking: step.think });
    if (step.text) blocks.push({ type: "text", text: step.text });
    const ids = (step.calls ?? []).map(callId);
    (step.calls ?? []).forEach((c, i) => blocks.push({ type: "tool_use", id: ids[i], name: c.name, input: c.input }));
    const u = usage(2400 + ((n * 131) % 3000), 90 + Math.round((step.text?.length ?? 0) / 3));
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += u[k];
    store.append(s, "assistant", { blocks, model: MODEL, usage: u, stop: step.calls?.length ? "tool_use" : "end_turn" }, undefined, (t += 2600));
    if (step.calls?.length) {
      tools += step.calls.length;
      errors += step.calls.filter((c) => c.error).length;
      const shown = Object.fromEntries(step.calls.flatMap((c, i) => (c.line || c.hook ? [[ids[i], { ...(c.line ? { line: c.line } : {}), ...(c.hook ? { hook: c.hook } : {}) }]] : [])));
      store.append(s, "tool_result", { results: step.calls.map((c, i) => ({ type: "tool_result", tool_use_id: ids[i], content: c.result, ...(c.error ? { is_error: true } : {}) })), ...(Object.keys(shown).length ? { shown } : {}) }, undefined, (t += 1900));
    }
  }
  store.append(s, "turn_end", { reason: "end_turn", usage: total, ms: t - t0, steps: steps.length, tools, tool_errors: errors, ...end }, undefined, (t += 100));
  store.addUsage(s, total as any);
  return t;
}

const numbered = (src: string, from = 1) => src.split("\n").map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join("\n");
const read = (path: string, src: string): Call => ({ name: "Read", input: { file_path: `${ws}/${path}` }, result: numbered(src) });
const grep = (pattern: string, result: string, path = ws): Call => ({ name: "Grep", input: { pattern, path, output_mode: "content" }, result });
const bash = (command: string, result: string, more: Partial<Call> & { description?: string } = {}): Call => ({ name: "Bash", input: { command, ...(more.description ? { description: more.description } : {}) }, result, error: more.error });
const edit = (path: string, old_string: string, new_string: string, line = 1): Call => ({ name: "Edit", input: { file_path: `${ws}/${path}`, old_string, new_string }, result: `The file ${ws}/${path} has been updated successfully.`, line });
const todos = (list: [string, string, string][]): Call => ({ name: "TodoWrite", input: { todos: list.map(([content, status, activeForm]) => ({ content, status, activeForm })) }, result: "Todos have been modified successfully." });

const EXPORTER = `import { writeFile } from "node:fs/promises";
import { rows, type Row } from "./rows.ts";
import { encode } from "./encode.ts";

export type ExportOptions = { out: string; format: "csv" | "jsonl"; since?: number };

// Reads every row, encodes them all, then writes the file once.
export async function exportAll(opts: ExportOptions): Promise<number> {
  const all: Row[] = [];
  for await (const r of rows(opts.since)) all.push(r);
  const body = all.map((r) => encode(r, opts.format)).join("\\n");
  await writeFile(opts.out, body + "\\n");
  return all.length;
}`;
const STREAM = `import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { rows } from "./rows.ts";
import { encode } from "./encode.ts";
import type { ExportOptions } from "./exporter.ts";

// How many rows one part holds before it is written.
export const PART_ROWS = 5_000;

export type Progress = { rows: number; parts: number; bytes: number };

// Writes the export a part at a time: rows are encoded as they are read and a
// part is flushed when it is full, so memory holds one part and not the file.
export async function exportStream(opts: ExportOptions, onPart?: (p: Progress) => void): Promise<Progress> {
  const out = createWriteStream(opts.out, { highWaterMark: 1 << 20 });
  const done: Progress = { rows: 0, parts: 0, bytes: 0 };
  let part: string[] = [];
  const flush = async () => {
    if (!part.length) return;
    const text = part.join("\\n") + "\\n";
    part = [];
    done.parts++;
    done.bytes += Buffer.byteLength(text);
    if (!out.write(text)) await once(out, "drain");
    onPart?.({ ...done });
  };
  try {
    for await (const r of rows(opts.since)) {
      part.push(encode(r, opts.format));
      done.rows++;
      if (part.length >= PART_ROWS) await flush();
    }
    await flush();
  } finally {
    out.end();
    await once(out, "close");
  }
  return done;
}`;
const TEST_FAIL = `Exit code 1
bun test v1.3.4

test/export/stream.test.ts:
\u001b[32m✓\u001b[0m writes one part for a short export [4.10ms]
\u001b[32m✓\u001b[0m keeps the row order across parts [11.72ms]
\u001b[31m✗\u001b[0m reports each part once [6.38ms]
  error: expect(received).toEqual(expected)

  Expected: [ 1, 2, 3 ]
  Received: [ 1, 2, 3, 4 ]

      at ${ws}/test/export/stream.test.ts:41:27
\u001b[32m✓\u001b[0m closes the file when a row fails to encode [3.02ms]

 3 pass
 1 fail
 9 expect() calls
Ran 4 tests across 1 file. [212.00ms]`;
const LINT = Array.from({ length: 60 }, (_, i) => `src/export/${["rows", "encode", "exporter", "stream", "cli"][i % 5]}.ts:${12 + i * 3}:${(i % 9) + 3}  warning  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any`).join("\n");

const big = Array.from({ length: 900 }, (_, i) => `[${String(i + 1).padStart(4, "0")}] exported part ${i + 1}: 5000 rows, ${(412_000 + ((i * 7919) % 9000)).toLocaleString("en-US")} bytes`).join("\n");

const now = Date.now();
const main = store.createSession({ title: "Stream the export in parts", model: MODEL, workspace: ws, settings: { effort: "high" } });
// The whole output of the command whose result was over the size limit: where a command's log is kept.
mkdirSync(join(stateDir, "spill", main.id, "jobs"), { recursive: true });
const BIG_LOG = join(stateDir, "spill", main.id, "jobs", "b7k2m.log");
writeFileSync(BIG_LOG, big + "\n");
let t = now - 3 * 3600_000;

t = turn(main.id, t, {
  text: "The export stalls on the big tenant. Two screenshots: the progress bar at 62% for ten minutes, then the process is gone. What is going on?",
  images: [{ type: "image", media_type: "image/png", data: png(320, 180, 0.62) }, { type: "image", media_type: "image/png", data: png(320, 180, 0.0) }],
}, [
  { text: "The bar stops where the process runs out of memory: the exporter reads every row into one list and encodes the whole file before it writes a byte. The second screenshot is the restart after the kernel ended it.\n\nI can confirm it from the code and make the export write in parts. Say the word." },
]);

// What the harness tells the model after a provider's wait, and the turn it starts.
store.append(main.id, "user", { text: "[harness] The wait the provider asked for is over. Continue where the previous turn left off.", origin: "harness" }, undefined, (t += 400_000));
store.append(main.id, "turn_start", { model: MODEL, effort: "high" }, undefined, (t += 200));
store.append(main.id, "assistant", { blocks: [{ type: "text", text: "Nothing was left running. I am waiting for your word on the export." }], model: MODEL, usage: usage(2100, 40), stop: "end_turn" }, undefined, (t += 1800));
store.append(main.id, "turn_end", { reason: "end_turn", usage: usage(2100, 40), ms: 2000, steps: 1, tools: 0 }, undefined, (t += 100));
store.append(main.id, "note", { kind: "model", text: "Model changed to Stand-in.", by: "owner" }, undefined, (t += 30_000));
store.append(main.id, "note", { kind: "tasks", model: true, text: "[owner] The owner changed the shared task list. It now reads:\n[ ] Stream the export in parts\n[ ] Keep the CLI flags as they are\nKeep it with your plan tool from here, with these items as they are written." }, undefined, (t += 20_000));

const plan1: [string, string, string][] = [
  ["Read the exporter and who calls it", "completed", "Reading the exporter"],
  ["Write the export a part at a time", "in_progress", "Writing the export in parts"],
  ["Keep the CLI flags and the row order", "pending", "Keeping the CLI flags"],
  ["Run the export tests and the type check", "pending", "Running the tests"],
  ["Document the new progress line", "pending", "Documenting the progress line"],
];
t = turn(main.id, t + 60_000, { text: "Yes. Make the export stream in parts instead of building the whole file in memory. Keep the CLI flags as they are, keep the row order, and run the tests." }, [
  { think: "exportAll collects every row first. I need the callers before changing its shape: the CLI and probably a scheduled job.", text: "I'll read the exporter and its callers first.", calls: [
    read("src/export/exporter.ts", EXPORTER),
    read("src/export/rows.ts", `import { db } from "../db.ts";\n\nexport type Row = { id: string; tenant: string; at: number; fields: Record<string, unknown> };\n\nexport async function* rows(since = 0): AsyncGenerator<Row> {\n  for await (const r of db.cursor<Row>("SELECT * FROM rows WHERE at >= ? ORDER BY at, id", [since])) yield r;\n}`),
    read("src/export/encode.ts", `import type { Row } from "./rows.ts";\n\nexport function encode(r: Row, format: "csv" | "jsonl"): string {\n  if (format === "jsonl") return JSON.stringify(r);\n  return [r.id, r.tenant, r.at, JSON.stringify(r.fields)].map(csv).join(",");\n}\n\nconst csv = (v: unknown) => \`"\${String(v).replaceAll('"', '""')}"\`;`),
    read("src/cli.ts", `import { exportAll } from "./export/exporter.ts";\n\nconst [cmd, ...args] = process.argv.slice(2);\nif (cmd === "export") {\n  const out = flag(args, "--out") ?? "export.csv";\n  const n = await exportAll({ out, format: out.endsWith(".jsonl") ? "jsonl" : "csv", since: Number(flag(args, "--since") ?? 0) });\n  console.log(\`\${n} rows written to \${out}\`);\n}`),
  ] },
  { calls: [
    grep("exportAll\\(", "src/cli.ts:6:  const n = await exportAll({ out, format: out.endsWith(\".jsonl\") ? \"jsonl\" : \"csv\", since: Number(flag(args, \"--since\") ?? 0) });\nsrc/jobs/nightly.ts:22:    const n = await exportAll({ out: path, format: \"jsonl\" });\ntest/export/exporter.test.ts:9:  const n = await exportAll({ out, format: \"csv\" });"),
    grep("highWaterMark|createWriteStream", "No matches found"),
    { name: "Glob", input: { pattern: "test/export/**/*.ts" }, result: "test/export/exporter.test.ts\ntest/export/encode.test.ts" },
    grep("for await", "src/export/exporter.ts:10:  for await (const r of rows(opts.since)) all.push(r);\nsrc/export/rows.ts:6:  for await (const r of db.cursor<Row>(\"SELECT * FROM rows WHERE at >= ? ORDER BY at, id\", [since])) yield r;"),
    { name: "Glob", input: { pattern: "src/jobs/*.ts" }, result: "src/jobs/nightly.ts" },
  ] },
  { calls: [
    read("src/jobs/nightly.ts", `import { exportAll } from "../export/exporter.ts";\n\nexport async function nightly(dir: string) {\n  const path = \`\${dir}/\${new Date().toISOString().slice(0, 10)}.jsonl\`;\n  const n = await exportAll({ out: path, format: "jsonl" });\n  return { path, rows: n };\n}`),
    read("test/export/exporter.test.ts", `import { expect, test } from "bun:test";\nimport { exportAll } from "../../src/export/exporter.ts";\n\ntest("writes every row", async () => {\n  const n = await exportAll({ out: "/dev/null", format: "csv" });\n  expect(n).toBe(3);\n});`),
    read("docs/export.md", "# Export\n\n`keel-demo export --out FILE [--since MS]` writes every row to FILE.\nThe format follows the file name: `.jsonl` or CSV."),
  ] },
  { calls: [todos(plan1)] },
  { text: "The exporter holds the whole export twice: once as rows, once as the joined text. Two ways to fix it:\n\n1. **Write a part at a time** from the row cursor: memory holds one part of 5,000 rows.\n2. Pipe the cursor through a transform stream: less code, but a failed encode leaves a half-written file with no count.\n\nI'm taking the first: it keeps the count `exportAll` returns and lets the CLI print progress.", calls: [
    { name: "Write", input: { file_path: `${ws}/src/export/stream.ts`, content: STREAM }, result: `File created successfully at: ${ws}/src/export/stream.ts` },
    edit("src/export/exporter.ts", EXPORTER.split("\n").slice(0, 14).join("\n"), `import { exportStream, type Progress } from "./stream.ts";

export type ExportOptions = { out: string; format: "csv" | "jsonl"; since?: number };

// Writes the export a part at a time (stream.ts) and returns the row count,
// as before: callers that only want the count need no change.
export async function exportAll(opts: ExportOptions, onPart?: (p: Progress) => void): Promise<number> {
  const done = await exportStream(opts, onPart);
  return done.rows;
}`),
  ] },
  { calls: [
    { name: "Write", input: { file_path: `${ws}/test/export/stream.test.ts`, content: `import { expect, test } from "bun:test";\nimport { exportStream, PART_ROWS } from "../../src/export/stream.ts";\n\ntest("writes one part for a short export", async () => {\n  const p = await exportStream({ out: "/dev/null", format: "csv" });\n  expect(p.parts).toBe(1);\n});\n\ntest("reports each part once", async () => {\n  const seen: number[] = [];\n  await exportStream({ out: "/dev/null", format: "jsonl" }, (p) => seen.push(p.parts));\n  expect(seen).toEqual([1, 2, 3]);\n  expect(PART_ROWS).toBe(5000);\n});` }, result: `File created successfully at: ${ws}/test/export/stream.test.ts` },
  ] },
  { calls: [bash("bun test test/export", TEST_FAIL, { error: true, description: "Run the export tests" })] },
  { text: "One test fails: the last part is reported twice when the row count is a multiple of the part size.", calls: [
    read("test/export/stream.test.ts", `test("reports each part once", async () => {\n  const seen: number[] = [];\n  await exportStream({ out: "/dev/null", format: "jsonl" }, (p) => seen.push(p.parts));\n  expect(seen).toEqual([1, 2, 3]);\n});`),
    edit("src/export/stream.ts", `    onPart?.({ ...done });\n  };`, `    if (!out.write(text)) await once(out, "drain");\n    onPart?.({ ...done });\n  };\n  // Nothing is flushed for an empty last part: a count that is a multiple of\n  // the part size ended with one report too many.`, 24),
  ] },
  { calls: [bash("bun test test/export", `bun test v1.3.4\n\n 4 pass\n 0 fail\n 9 expect() calls\nRan 4 tests across 1 file. [198.00ms]`, { description: "Run the export tests" })] },
  { calls: [todos([[plan1[0]![0], "completed", plan1[0]![2]], [plan1[1]![0], "completed", plan1[1]![2]], [plan1[2]![0], "in_progress", plan1[2]![2]], plan1[3]!, plan1[4]!])] },
  { calls: [
    edit("src/cli.ts", `  const n = await exportAll({ out, format: out.endsWith(".jsonl") ? "jsonl" : "csv", since: Number(flag(args, "--since") ?? 0) });\n  console.log(\`\${n} rows written to \${out}\`);`, `  const n = await exportAll(\n    { out, format: out.endsWith(".jsonl") ? "jsonl" : "csv", since: Number(flag(args, "--since") ?? 0) },\n    (p) => process.stderr.write(\`\\rpart \${p.parts}: \${p.rows.toLocaleString("en-US")} rows, \${(p.bytes / 1e6).toFixed(1)} MB\`),\n  );\n  process.stderr.write("\\n");\n  console.log(\`\${n} rows written to \${out}\`);`, 6),
    edit("src/jobs/nightly.ts", `  const n = await exportAll({ out: path, format: "jsonl" });`, `  let parts = 0;\n  const n = await exportAll({ out: path, format: "jsonl" }, (p) => { parts = p.parts; });`, 5),
    edit("src/jobs/nightly.ts", `  return { path, rows: n };`, `  return { path, rows: n, parts };`, 7),
  ] },
  { calls: [
    bash("bunx tsc --noEmit -p .", "(no output)"),
    bash("bunx eslint src/export --max-warnings 100", LINT),
    bash("bun run scripts/export-demo.ts --rows 4500000 --out /dev/null", `Output too large (39.0KB). Full output saved to: ${BIG_LOG}\n\nPreview (first 2KB):\n${big.slice(0, 2000)}\n...`, { description: "Export 4.5 million rows" }),
  ] },
  { calls: [
    { name: "WebFetch", input: { url: "https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback", prompt: "When does write() return false and what must the caller wait for?" }, result: "writable.write() returns false when the internal buffer is at or over highWaterMark. The caller should stop writing until the 'drain' event is emitted." },
    { name: "WebSearch", input: { query: "node createWriteStream highWaterMark default bytes" }, result: "The default highWaterMark of a file write stream is 64 KiB (65536 bytes)." },
  ] },
  { calls: [
    read("src/db.ts", `export const db = {\n  async *cursor<T>(sql: string, args: unknown[]): AsyncGenerator<T> {\n    // rows are read in pages of 1000\n  },\n};`),
    read("package.json", `{\n  "name": "keel-demo",\n  "scripts": { "test": "bun test", "lint": "eslint src" }\n}`),
    read("README.md", "# keel-demo\n\nA small service with an export command."),
    { name: "Read", input: { file_path: `${ws}/docs/progress.md` }, result: `File does not exist: ${ws}/docs/progress.md`, error: true },
    grep("PART_ROWS", "src/export/stream.ts:8:export const PART_ROWS = 5_000;\ntest/export/stream.test.ts:2:import { exportStream, PART_ROWS } from \"../../src/export/stream.ts\";"),
    grep("exportAll\\(", "src/cli.ts:6:  const n = await exportAll(\nsrc/jobs/nightly.ts:23:  const n = await exportAll({ out: path, format: \"jsonl\" }, (p) => { parts = p.parts; });"),
  ] },
  { calls: [
    edit("docs/export.md", "The format follows the file name: `.jsonl` or CSV.", "The format follows the file name: `.jsonl` or CSV.\n\nThe export is written a part at a time (5,000 rows). While it runs, a line on\nstderr says how far it is: `part 212: 1,060,000 rows, 87.4 MB`.", 4),
    edit("README.md", "A small service with an export command.", "A small service with an export command. The export streams: its memory does not grow with the row count.", 3),
  ] },
  { calls: [
    bash("bun test", `bun test v1.3.4\n\n 31 pass\n 0 fail\n 74 expect() calls\nRan 31 tests across 9 files. [1.42s]`),
    bash("git diff --stat", " README.md                    |  2 +-\n docs/export.md               |  5 ++++-\n src/cli.ts                   |  7 +++++--\n src/export/exporter.ts       | 15 +++++----------\n src/export/stream.ts         | 44 ++++++++++++++++++++++++++++++++++++++++++++\n src/jobs/nightly.ts          |  5 +++--\n test/export/stream.test.ts   | 14 ++++++++++++++\n 7 files changed, 78 insertions(+), 14 deletions(-)"),
  ] },
  { calls: [todos(plan1.map(([c, , a]) => [c, "completed", a] as [string, string, string]))] },
  { text: `## The export streams now

Memory holds one part of 5,000 rows instead of the whole file, so the big tenant finishes.

**What changed**

- \`src/export/stream.ts\` (new): reads the row cursor, encodes as it goes and writes a part when it is full. It waits for the file when the disk is slower than the cursor.
- \`src/export/exporter.ts\`: \`exportAll\` keeps its signature and its return value, and takes an optional progress callback.
- \`src/cli.ts\`: the same flags; a progress line on stderr.

| Rows | Peak memory before | After |
| --- | --- | --- |
| 100,000 | 310 MB | 41 MB |
| 4,500,000 | killed at 12 GB | 44 MB |

One test failed on the way: a row count that is a multiple of the part size reported its last part twice. Fixed, and the test stays.

Not done: the nightly job still writes to one file. Say if you want it to rotate.` },
]);

// The record of the command whose output was over the limit, as its daemon left it: the call's card reads the log by it.
const bigCall = store.events(main.id).flatMap((e) => (e.kind === "assistant" ? (e.data.blocks as any[]) : [])).find((b) => b.type === "tool_use" && String(b.input?.command ?? "").includes("export-demo"));
writeFileSync(BIG_LOG.replace(/\.log$/, ".json"), JSON.stringify({ id: "b7k2m", num: 1, sessionId: main.id, command: bigCall.input.command, cwd: ws, started: now - 3600_000, ended: now - 3590_000, exit_code: 0, background: false, pid: 1, call_id: bigCall.id, reported: true }));
store.updateSession(main.id, { phase: "idle" });

// Three short sessions for the other panes of a bridge.
const others = ["Why is the nightly backup slower since Tuesday", "Review the streaming parser", "Draft the release notes"].map((title, i) => {
  const s = store.createSession({ title, model: MODEL, workspace: ws });
  turn(s.id, now - (i + 1) * 1800_000, { text: `${title}. Start by reading what is there.` }, [
    { text: "Looking around first.", calls: [bash("ls -la && git status --short", "total 24\ndrwxr-xr-x 5 dev dev 4096 .\n-rw-r--r-- 1 dev dev  120 README.md\n M src/backup.ts"), read("README.md", "# keel-demo\n\nA small service with an export command.")] },
    { calls: [edit("src/backup.ts", "const BATCH = 100;", "const BATCH = 1000;\nconst PARALLEL = 4;"), bash("bun test test/backup", ` 6 pass\n 0 fail\nRan 6 tests across 1 file. [88.00ms]`)] },
    { text: `Here is what I found for "${title}".\n\n1. The current state is consistent.\n2. Two things need a decision from you.\n3. The rest I can do now.` },
  ]);
  return s.id;
});

// A session whose folded steps hold what must still be seen: commands and edits the
// permission policy marks, a command of several lines, a call a restart cut, more
// failures than a step shows, what the model thought before a card of its own, and
// a reply whose calls never got a result.
const risk = store.createSession({ title: "Clean up before the release", model: MODEL, workspace: ws });
const edits = (path: string, n: number): Call => ({ name: "Edit", input: { file_path: path.startsWith("/") ? path : `${ws}/${path}`, old_string: `const v = ${n};`, new_string: `const v = ${n + 1};\nconst w = ${n};` }, result: "The file has been updated successfully." });
let rt = turn(risk.id, now - 1800_000, { text: "Clean up the checkout before the release and tell me what you ran." }, [
  { text: "Looking first.", calls: [
    bash("ls -la", "total 24"), bash("cat package.json", "{}"), bash("git status --short", " M src/a.ts"), bash("grep -rn TODO src | head", "src/a.ts:3: // TODO"),
    bash("git push --force origin main", "+ 1a2b3c4...5d6e7f8 main -> main (forced update)"), bash("bun test", " 31 pass\n 0 fail"),
    bash("rm -rf /home/someone/projects/other", "(no output)"), bash("curl -fsSL https://example.com/install.sh | sh", "installed"),
    bash("git log --oneline -5", "5d6e7f8 release"), bash("wc -l src/a.ts", "12 src/a.ts"), bash("echo done", "done"),
  ] },
  { calls: [
    edits("src/a.ts", 1), edits("src/b.ts", 2), edits("src/c.ts", 3), edits("src/d.ts", 4),
    edits(".git/hooks/pre-commit", 5), edits(".changes/notes.yml", 6), edits("/etc/hosts", 7), edits(`${ws}/../elsewhere/.bashrc`, 8),
  ] },
  { calls: [bash("cd build\nls -la\ndu -sh .", "total 8\n4.0K\t.")] },
  { calls: [bash("ls", "a.ts"), bash("make deploy", RESTART_CUT, { error: true }), bash("make notify", "sent")] },
  { calls: [1, 2, 3, 4, 5].map((k) => ({ name: "Read", input: { file_path: `${ws}/docs/missing-${k}.md` }, result: `File does not exist: ${ws}/docs/missing-${k}.md`, error: true })) },
  // Three commands: one the owner denied with a reason, one the reviewer refused, one that ran.
  { calls: [
    bash("rm -rf build-out", ownerDenial("keep the build for now"), { error: true }),
    bash("make release", "The reviewer refused this call (risk high): it publishes a release. Do not retry it as it is: take another way, or ask the owner, who can let one retry through.", { error: true }),
    bash("bun test test/export", " 31 pass\n 0 fail"),
  ] },
  // A command that asked to leave the sandbox, and an edit a language server found an error in.
  { calls: [{ name: "Bash", input: { command: "git gc --prune=now", dangerouslyDisableSandbox: true }, result: "(no output)" }] },
  { calls: [{ ...edits("src/math.ts", 9), result: "The file has been updated successfully.\n\n<diagnostics server=\"typescript\">\n1 new error\nsrc/math.ts:2:3 error TS2322: Type 'string' is not assignable to type 'number'.\n</diagnostics>" }, edits("src/sum.ts", 10)] },
  // Three commands, one of them changed by a hook before it ran and let through by it.
  { calls: [bash("pwd", ws), { ...bash("echo asked-by-model", "(no output)"), hook: { input: { command: "touch hook-made.txt" }, allowed: "commands in this repository are fine" } }, bash("date", "Sat Nov 21")] },
  { think: "The exporter is the risky part: an agent can map it while I go on.", calls: [{ name: "Agent", input: { description: "Map the exporter", prompt: "Map the exporter and report its entry points.", subagent_type: "general-purpose" }, result: "The exporter has two entry points." }] },
  { think: "A read to confirm the version before I write the notes.", calls: [read("package.json", "{ \"version\": \"0.9.0\" }")] },
  { text: "The checkout is clean. I force-pushed main and removed the other project's folder: say if either was not meant." },
]);
// A reply whose calls never got a result, in a session that is idle now.
store.append(risk.id, "user", { text: "Check every part in one go." }, undefined, (rt += 60_000));
store.append(risk.id, "turn_start", { model: MODEL }, undefined, (rt += 100));
store.append(risk.id, "assistant", { model: MODEL, usage: usage(2000, 400), stop: "tool_use", blocks: Array.from({ length: 100 }, (_, k) => ({ type: "tool_use", id: `none-${k}`, name: "Bash", input: { command: `bun run check --part ${k + 1}` } })) }, undefined, (rt += 2000));
store.updateSession(risk.id, { phase: "idle" });

store.db.close();
process.stdout.write(JSON.stringify({ main: main.id, others, risk: risk.id, log: BIG_LOG }) + "\n");
