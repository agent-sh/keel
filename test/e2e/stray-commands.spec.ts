import { expect, test } from "./isolate.ts";
import { daemon, exited, ROOT, stopStrays } from "./own-daemon.ts";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Feature: what a spec's own daemon leaves running ends with the spec. A daemon killed with SIGKILL cannot end the
// commands of its sessions, and a daemon whose environment has no session bus runs them in the scope of whoever
// started the run: they stayed for days. The commands carry the run's mark, and `stopStrays(state)` ends the ones
// of that daemon (the worker's last fixture ends every one the run's daemons left).
test("a command a killed spec daemon left running is ended by stopStrays, and nothing else is", async () => {
  const state = join(ROOT, `strays-${Date.now()}`);
  const tag = String(1e9 + Math.floor(Math.random() * 8e9));
  const left = () => readdirSync("/proc").filter((n) => { try { return /^\d+$/.test(n) && readFileSync(`/proc/${n}/cmdline`, "utf8").includes(`sleep\u0000700.${tag}`); } catch { return false; } }).map(Number);
  mkdirSync(state, { recursive: true });
  const d = await daemon(state);
  // Not a command of a spec daemon: the same sleep, started by the spec itself.
  const mine = spawn("sleep", [`700.${tag}`], { stdio: "ignore" });
  try {
    const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Leaves a command" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    await call(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: `sleep 700.${tag}` } }])}` });
    await expect.poll(() => left().length, { timeout: 30_000 }).toBe(2);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    // The daemon is gone and its command is not.
    expect(left().length).toBe(2);
    expect(stopStrays(state)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => left(), { timeout: 10_000 }).toEqual([mine.pid]);
  } finally {
    mine.kill();
    d.proc.kill("SIGKILL");
    stopStrays(state);
    rmSync(state, { recursive: true, force: true });
  }
});
