import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// Feature: one daemon per port. A second daemon on a port another one serves
// (another state folder) refuses to start and names the holder, instead of
// both answering. Runs its own daemons on scratch state folders.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });

function start(state: string, port: number) {
  mkdirSync(state, { recursive: true });
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", state], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once("exit", (c) => r(c)));
  return { proc, exited, out: () => out };
}

test("a second daemon on a taken port refuses to start", async ({ request }) => {
  const port = await freePort();
  const stamp = Date.now();
  const a = start(join(ROOT, `port-a-${stamp}`), port);
  try {
    await expect.poll(() => a.out(), { timeout: 30_000 }).toContain("keel listening");
    const pidA = (await (await request.get(`http://127.0.0.1:${port}/api/daemon`)).json()).pid;

    const b = start(join(ROOT, `port-b-${stamp}`), port);
    expect(await Promise.race([b.exited, new Promise((r) => setTimeout(() => r("still running"), 30_000))])).toBe(1);
    expect(b.out()).toContain(`127.0.0.1:${port} is already in use by a Keel daemon (pid ${pidA}`);
    expect(b.out()).not.toContain("keel listening");
    // The first one still answers, alone.
    expect((await (await request.get(`http://127.0.0.1:${port}/api/daemon`)).json()).pid).toBe(pidA);
  } finally {
    a.proc.kill("SIGKILL");
  }
});
