// run_code's program as a process: what a program that went on in the background writes to its job's log
// while it runs, and when its end is known. (Its calls, the gate and the wake are the command line e2e's.)
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { running, stopJob } from "./jobs.ts";
import { runProgram } from "./codemode.ts";
import type { ToolContext } from "./types.ts";

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? ".", "codemode-")));
const ctx = (): ToolContext => {
  const dir = mkdtempSync(join(root, "c-"));
  mkdirSync(join(dir, "spill"), { recursive: true });
  return { sessionId: "s-code", cwd: dir, signal: new AbortController().signal, spillDir: join(dir, "spill"), callId: "call-1", seen: new Map() } as ToolContext;
};
const rec = { start() {}, end() {} };
const until = async (what: string, f: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (f()) return;
  throw new Error(`timed out: ${what}`);
};

test("a program that went on in the background writes what it prints to the job's log as it prints", async () => {
  const o = await runProgram(`console.log("first"); await Bun.sleep(1200); console.log("second"); await Bun.sleep(1500); console.log("third"); return "RETURNED";`, ctx(), rec, 400);
  const job = o.moved!;
  expect(o.printed).toContain("first");
  const log = () => readFileSync(job.log, "utf8");
  // Live: the second line is in the log while the program still runs, and nothing the call returned is written again.
  await until("the second line in the log", () => log().includes("second"));
  expect(running(job)).toBe(true);
  expect(log()).not.toContain("first");
  expect(log()).not.toContain("third");
  await job.exited;
  // The end adds only what had not been written: each line once, in order.
  const text = log();
  expect(text.match(/second/g)).toHaveLength(1);
  expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
  expect(text).toContain("RETURNED");
  expect(text).not.toContain("first");
  // The wake still carries everything since the call returned.
  expect(job.result).toContain("second");
  expect(job.result).toContain("RETURNED");
}, 20_000);

test("a program that has exited is ended even when a child it left holds its output open", async () => {
  const started = Date.now();
  const o = await runProgram(`Bun.spawn(["sleep", "10"], { stdout: "inherit", stderr: "inherit" }); console.log("left a child"); return "done";`, ctx(), rec);
  expect(o.finished).toBe(true);
  expect(o.printed).toContain("left a child");
  expect(Date.now() - started).toBeLessThan(5000);
}, 20_000);
