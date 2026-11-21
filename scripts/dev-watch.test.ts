// The dev watcher's decisions, in a fixture folder with a slow fake installer.
// Run with: bun test ./scripts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holder, poke, reloader } from "./dev-watch.ts";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A checkout with one source file, and a reloader on it whose installer takes
// `ms` and exits with the next of `codes`. `events` is what happened, in order.
function fixture(ms = 40, codes: number[] = []) {
  const top = mkdtempSync(join(tmpdir(), "keel-dev-watch-"));
  made.push(top);
  mkdirSync(join(top, "src"));
  mkdirSync(join(top, "ui", "src"), { recursive: true });
  writeFileSync(join(top, "src", "a.ts"), "export {};\n");
  const events: string[] = [];
  let flying = 0, most = 0;
  const r = reloader({
    top,
    settle: { css: 5, reload: 10 },
    install: async () => {
      events.push("install starts");
      most = Math.max(most, ++flying);
      await Bun.sleep(ms);
      flying--;
      const code = codes.shift() ?? 0;
      events.push(`install ends ${code}`);
      return code;
    },
    poke: (f) => events.push(`poke ${f.slice(top.length + 1)}`),
    log: (l) => events.push(`log ${l}`),
  });
  return { r, events, most: () => most };
}

test("a burst of notifications runs one install at a time, and the last manifest change is installed before the last reload", async () => {
  const { r, events, most } = fixture();
  r.manifest("change", "package.json");
  r.source("rename", "a.ts");
  await Bun.sleep(25); // the first install is running
  for (let i = 0; i < 5; i++) {
    r.manifest("change", "bun.lock");
    r.source("rename", "a.ts");
    await Bun.sleep(12); // each notification arrives after the one before it settled
  }
  events.push("last manifest change");
  r.manifest("change", "package.json");
  await r.idle();
  expect(most()).toBe(1);
  const lastChange = events.indexOf("last manifest change");
  const lastInstall = events.lastIndexOf("install starts");
  expect(lastInstall).toBeGreaterThan(lastChange);
  expect(events.at(-1)).toBe("poke src/main.ts");
  expect(events.at(-2)).toBe("install ends 0");
});

test("a source file that came back reloads without an install; a file that is gone does not", async () => {
  const { r, events } = fixture();
  r.source("rename", "a.ts");
  r.source("rename", "gone.ts");
  r.source("change", "a.ts");
  r.manifest("change", "README.md");
  await r.idle();
  expect(events).toEqual(["poke src/main.ts"]);
});

test("a failed install is reported and reloads nothing; the next manifest change installs again", async () => {
  const { r, events } = fixture(5, [1, 0]);
  r.manifest("change", "package.json");
  await r.idle();
  expect(events.slice(0, 2)).toEqual(["install starts", "install ends 1"]);
  expect(events[2]).toContain("bun install failed (exit 1); nothing is reloaded");
  expect(events.some((e) => e.startsWith("poke"))).toBe(false);
  r.manifest("change", "bun.lock");
  await r.idle();
  expect(events.slice(3)).toEqual(["install starts", "install ends 0", "poke src/main.ts"]);
});

test("an imported stylesheet pokes styles.css; styles.css itself pokes nothing", async () => {
  const { r, events } = fixture();
  r.css("change", "styles.css");
  await r.idle();
  expect(events).toEqual([]);
  r.css("rename", "toolkit.css");
  r.css("change", "panels/bridge.css");
  r.css("change", "App.tsx");
  await r.idle();
  expect(events).toEqual(["poke ui/src/styles.css"]);
});

test("a poke changes the file's time and none of its bytes; the lock names the daemon", async () => {
  const top = mkdtempSync(join(tmpdir(), "keel-dev-watch-"));
  made.push(top);
  const f = join(top, "styles.css");
  writeFileSync(f, "@import \"./a.css\";\n");
  const before = statSync(f);
  await Bun.sleep(15);
  poke(f);
  const after = statSync(f);
  expect(readFileSync(f, "utf8")).toBe("@import \"./a.css\";\n");
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  writeFileSync(join(top, "empty.css"), "");
  poke(join(top, "empty.css"));
  poke(join(top, "missing.css"));
  expect(statSync(join(top, "empty.css")).size).toBe(0);

  expect(holder(top)).toBeUndefined();
  writeFileSync(join(top, "daemon.lock"), JSON.stringify({ pid: process.pid }));
  expect(holder(top)).toBe(process.pid);
  writeFileSync(join(top, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 1 }));
  expect(holder(top)).toBeUndefined();
});

// The launcher with a stand-in daemon: a process that takes the folder's lock,
// writes down each signal it gets, drains for a moment on the first one and
// stops at once on a second, as the daemon does. `restart` hands the folder
// to a daemon it starts and exits, as a daemon that restarts itself does.
const STAND_IN = `
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const [state, mode = "plain"] = process.argv.slice(2);
const lock = state + "/daemon.lock", me = process.pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let got = 0;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  appendFileSync(state + "/signals", me + " " + sig + "\\n");
  if (++got > 1) process.exit(0);
  await Bun.sleep(400);
  appendFileSync(state + "/signals", me + " drained\\n");
  try { if (JSON.parse(readFileSync(lock, "utf8")).pid === me) rmSync(lock); } catch {}
  process.exit(0);
});
const before = Number(process.env.STAND_IN_AFTER || 0);
while (before && alive(before)) await Bun.sleep(20);
if (mode === "slow") await Bun.sleep(1500);
writeFileSync(lock, JSON.stringify({ pid: me, started_ms: Date.now() }));
if (mode === "restart") {
  await Bun.sleep(300);
  const next = Bun.spawn(["bun", import.meta.path, state], { env: { ...process.env, STAND_IN_AFTER: String(me) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  next.unref();
  writeFileSync(lock, JSON.stringify({ ...JSON.parse(readFileSync(lock, "utf8")), pid: next.pid }));
  await Bun.sleep(100);
  process.exit(0);
}
setInterval(() => {}, 1000);
`;
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what: () => unknown, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (what()) return true; return false; };

function launcher(mode = "plain") {
  const state = mkdtempSync(join(tmpdir(), "keel-dev-launch-"));
  made.push(state);
  writeFileSync(join(state, "stand-in.ts"), STAND_IN);
  // A session of its own, as a terminal gives a command: its pid is its process group.
  const start = () => Bun.spawn(["bun", join(import.meta.dir, "dev-watch.ts"), state, "--", "bun", join(state, "stand-in.ts"), state, mode], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  const lock = () => { try { return JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")).pid as number; } catch { return 0; } };
  const signals = () => { try { return readFileSync(join(state, "signals"), "utf8").trim().split("\n"); } catch { return []; } };
  return { state, start, lock, signals };
}

test("a signal to the launcher's group reaches the daemon once, and it drains", async () => {
  const l = launcher();
  const p = l.start();
  expect(await until(l.lock)).toBe(true);
  const daemon = l.lock();
  process.kill(-p.pid, "SIGINT"); // Ctrl-C: the terminal signals the whole foreground group
  expect(await p.exited).toBe(0);
  expect(l.signals()).toEqual([`${daemon} SIGTERM`, `${daemon} drained`]);
  expect(running(daemon)).toBe(false);
}, 20_000);

test("a second signal stops the daemon at once, and the launcher", async () => {
  const l = launcher();
  const p = l.start();
  expect(await until(l.lock)).toBe(true);
  const daemon = l.lock();
  process.kill(p.pid, "SIGTERM");
  await until(() => l.signals().length === 1);
  process.kill(p.pid, "SIGTERM");
  expect(await p.exited).toBe(130);
  expect(await until(() => !running(daemon), 2000)).toBe(true);
  expect(l.signals()).toEqual([`${daemon} SIGTERM`, `${daemon} SIGTERM`]);
}, 20_000);

test("a daemon stopped from outside ends the launcher within a moment", async () => {
  const l = launcher();
  const p = l.start();
  expect(await until(l.lock)).toBe(true);
  process.kill(l.lock(), "SIGTERM");
  const t0 = Date.now();
  expect(await p.exited).toBe(0);
  expect(Date.now() - t0).toBeLessThan(4000);
}, 30_000);

test("a daemon that restarted itself is followed, and stopped with the launcher", async () => {
  const l = launcher("restart");
  const p = l.start();
  expect(await until(l.lock)).toBe(true);
  const first = l.lock();
  expect(await until(() => l.lock() && l.lock() !== first && !running(first))).toBe(true);
  const second = l.lock();
  await Bun.sleep(2500); // longer than any gap the launcher waits out
  expect(p.exitCode).toBeNull();
  expect(running(second)).toBe(true);
  process.kill(p.pid, "SIGTERM");
  expect(await p.exited).toBe(0);
  expect(l.signals()).toEqual([`${second} SIGTERM`, `${second} drained`]);
  expect(running(second)).toBe(false);
}, 30_000);

test("a lock left by a daemon that ended is never signalled", async () => {
  const l = launcher("slow");
  // Another program runs under the pid a stale lock names.
  const other = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(l.state, "daemon.lock"), JSON.stringify({ pid: other.pid, started_ms: Date.now() - 60_000 }));
  try {
    const p = l.start();
    await Bun.sleep(700); // the launcher's daemon runs and has not taken the lock yet
    process.kill(p.pid, "SIGTERM");
    await p.exited;
    expect(running(other.pid)).toBe(true);
    expect(l.signals().length).toBeGreaterThan(0);
    expect(l.signals().every((s) => !s.startsWith(`${other.pid} `))).toBe(true);
  } finally {
    other.kill();
  }
}, 30_000);
