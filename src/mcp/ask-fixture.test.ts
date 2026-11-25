// The ask-mcp stand-in server of the browser specs ends with the process that started it, even when its stdin
// never ends (a sibling holds the write end): servers left by a killed test daemon ran for days.
import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/ask-mcp.ts");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the ask-mcp fixture exits when its parent is killed while its stdin stays open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-ask-fixture-"));
  const fifo = join(dir, "stdin");
  let pid = 0, held = -1;
  try {
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    held = openSync(fifo, "r+"); // the write end stays open here: the fixture's stdin never ends
    // The "daemon": starts the fixture on that stdin, says its pid, and a second later is killed without a word.
    const daemon = Bun.spawn(["bun", "-e", `
      const p = Bun.spawn(["bun", ${JSON.stringify(FIXTURE)}], { stdin: Bun.file(${JSON.stringify(fifo)}), stdout: "ignore", stderr: "ignore" });
      console.log(p.pid);
      await Bun.sleep(1500);
      process.kill(process.pid, "SIGKILL");
    `], { stdout: "pipe", stderr: "ignore" });
    pid = Number((await new Response(daemon.stdout).text()).trim());
    await daemon.exited;
    expect(pid).toBeGreaterThan(1);
    // Up first, so the check below means the fixture ended and did not just never start.
    expect(alive(pid)).toBe(true);
    const until = Date.now() + 8000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  } finally {
    if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    if (held >= 0) closeSync(held);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
