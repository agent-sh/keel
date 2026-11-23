// A server process never outlives its daemon: ended at the daemon's exit, and
// by the next daemon when the one before was killed.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { born, reapLeft, track } from "./procs.ts";

const alive = (pid: number) => born(pid) !== null;
// Waits for the state, however long it takes: a test that never sees it ends at its time limit. What it
// returns is what it saw, not a second look (a pid that ended can be another process's a moment later).
const until = async (ok: () => boolean) => { while (!ok()) await Bun.sleep(25); return true; };
// The process that had the pid when `mark` was read has ended (a later one with the pid is another process).
const ended = (pid: number, mark: string | null) => born(pid) !== mark;
// A process that ignores its input closing and the polite signal.
const stubborn = () => Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
const linux = born(process.pid) !== null;

test.skipIf(!linux)("a server the daemon before left running is ended at the next start, by its pid and start time and nothing else", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-mcp-procs-"));
  const left = stubborn(), other = stubborn();
  try {
    // As a killed daemon leaves its record: two servers it ran. One pid has since gone to another process (another start time).
    writeFileSync(join(state, "mcp-procs.json"), JSON.stringify({ [left.pid]: { born: born(left.pid), name: "left" }, [other.pid]: { born: "1", name: "reused" }, 999999999: { born: "5", name: "gone" } }));
    expect(reapLeft(state, 100)).toEqual(["left"]);
    // It ignores the polite signal: killed after the grace. The process that only shares a pid is untouched.
    // (It has ended: by the kill, or by the polite signal when that came before its shell had set the trap.)
    expect([137, 143]).toContain(await left.exited);
    expect(alive(other.pid)).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "mcp-procs.json"), "utf8"))).toEqual({});
    // A server of this daemon is written down while it runs and taken out when it ends; a start leaves it alone.
    track(state, other, "mine");
    expect(JSON.parse(readFileSync(join(state, "mcp-procs.json"), "utf8"))).toEqual({ [other.pid]: { born: born(other.pid), name: "mine" } });
    expect([reapLeft(state, 100), alive(other.pid)]).toEqual([[], true]);
    other.kill("SIGKILL");
    await other.exited;
    expect(await until(() => readFileSync(join(state, "mcp-procs.json"), "utf8") === "{}")).toBe(true);
  } finally {
    left.kill("SIGKILL");
    other.kill("SIGKILL");
  }
});

test.skipIf(!linux)("a server that ignores its input closing and the polite signal ends with the daemon's process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-mcp-procs-"));
  // A process that starts such a server, as a daemon does, and then just exits.
  const script = join(dir, "daemon.ts");
  writeFileSync(script, `process.env.KEEL_CONFIG_DIR = ${JSON.stringify(join(dir, "config"))};
const { track } = await import(${JSON.stringify(join(import.meta.dir, "procs.ts"))});
const p = Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
track(${JSON.stringify(join(dir, "state"))}, p, "stubborn");
console.log(p.pid);
await Bun.sleep(100);
process.exit(0);
`);
  const d = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "inherit" });
  // The server's pid and start time, read while the daemon still runs (it waits a moment before it exits).
  const reader = d.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) { const { value, done } = await reader.read(); if (done) break; line += new TextDecoder().decode(value); }
  const pid = Number(line.trim());
  const mark = born(pid);
  expect(mark).not.toBeNull();
  await d.exited;
  expect(pid).toBeGreaterThan(1);
  expect(await until(() => ended(pid, mark))).toBe(true);
}, 30_000);
