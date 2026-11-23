import { expect, test } from "bun:test";
import { CARRY_MAX, carryText, jobLine, stalled, writesPath } from "./wait-carry.ts";

test("the job that writes a waited file: a redirection or tee into it, with ~, $HOME and the command's own variables put in", () => {
  const at = (cmd: string, path = "/h/w/logs/e2e.log") => writesPath(cmd, "/h/repo", "/h", path);
  expect(at("bunx playwright test > ~/w/logs/e2e.log 2>&1")).toBe(true);
  expect(at("S=~/w; scripts/smoke.sh >> $S/logs/e2e.log 2>&1")).toBe(true);
  expect(at('L="$HOME/w/logs"; bun test 2>&1 | tee -a ${L}/e2e.log')).toBe(true);
  expect(at("bun test &> ../w/logs/e2e.log", "/h/w/logs/e2e.log")).toBe(true);
  expect(at("bun test > logs/e2e.log", "/h/repo/logs/e2e.log")).toBe(true);
  // A command that reads it, one that writes another file, a variable not known here: not its writer.
  expect(at("tail -5 ~/w/logs/e2e.log")).toBe(false);
  expect(at("bun test > ~/w/logs/e2e.log.old")).toBe(false);
  expect(at("bun test > $OUT/e2e.log")).toBe(false);
});

test("what a wake carries of a file: what it gained, its end when more, cut at a line's start, with where the rest is", () => {
  const base = { path: "/x/log", from: 10, size: 40, fromStart: false, unchanged: false, binary: false };
  expect(carryText({ ...base, text: "ok 1\nok 2\n" })).toBe("What /x/log gained since the wait began (from byte 10 of 40):\nok 1\nok 2");
  expect(carryText({ ...base, fromStart: true, from: 0, text: "all\n" })).toBe("/x/log (40 bytes):\nall");
  expect(carryText({ ...base, text: "" })).toBe("Nothing was added to /x/log since the wait began.");
  expect(carryText({ ...base, unchanged: true, text: "end\n" })).toStartWith("The end of /x/log (nothing was added since the wait began):");
  expect(carryText({ ...base, binary: true, text: "" })).toBe("/x/log holds binary data (40 bytes): it is not carried.");
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const big = carryText({ ...base, size: lines.length, text: lines });
  const body = big.split("\n").slice(2).join("\n");
  expect(body.length).toBeLessThanOrEqual(CARRY_MAX);
  expect(body).toStartWith("line ");
  expect(body).toEndWith(`line 3999 ${"x".repeat(20)}`);
  expect(big.split("\n")[1]).toMatch(/^\[\d+ characters before this are not carried: Read the file for them\]$/);
  // Bytes the read left out before what it read are said too, and a line it began inside of is not carried in part.
  expect(carryText({ ...base, text: "tail of a line\nwhole\n", skipped: 500 })).toBe("What /x/log gained since the wait began (from byte 10 of 40):\n[500 bytes and 15 characters before this are not carried: Read the file for them]\nwhole");
});

test("what is known of the job, in a line", () => {
  const now = 10 * 60_000;
  const j = { id: "b1", command: "bun test  ./x\n", started: 0, running: true, live: true, lastOutput: now - 30_000 };
  expect(jobLine(j, now)).toBe("Job b1 (`bun test ./x`) that writes it is running, for 10 min, its last output 30 s ago.");
  expect(jobLine({ ...j, running: false, live: false, exit: 1, ended: now - 120_000 }, now)).toBe("Job b1 (`bun test ./x`) that writes it ended 2 min ago (exit 1), its last output 30 s ago.");
  expect(jobLine({ ...j, running: false, live: true, exit: 0, ended: now - 1000, lastOutput: undefined }, now)).toBe("Job b1 (`bun test ./x`) that writes it ended 1 s ago (exit 0); processes it started still run.");
});

test("a stall: quiet past its time, and no process of it waits on something else", () => {
  expect(stalled({ now: 1000, since: 0, waiting: false, after: 1000 })).toBe(true);
  expect(stalled({ now: 999, since: 0, waiting: false, after: 1000 })).toBe(false);
  expect(stalled({ now: 5000, since: 0, waiting: true, after: 1000 })).toBe(false);
});
