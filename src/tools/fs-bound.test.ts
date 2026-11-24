// A path on a mount that stopped answering never holds the loop, and a Stop ends the call that waits on it.
// The stall is a real one: a FUSE mount whose server answers nothing (test/support/stallfs.py). Skipped where
// FUSE cannot be mounted.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { allHooks, registerHooks } from "../engine/hooks.ts";

const hooksAtStart = allHooks().length;
afterAll(async () => { allHooks().length = hooksAtStart; (await import("../admin/settings.ts")).loadSettings(process.env.KEEL_STATE_DIR!, () => {}); });

const SERVER = join(import.meta.dir, "../../test/support/stallfs.py");
const canMount = !!Bun.which("fusermount3") && !!Bun.which("python3") && existsSync("/dev/fuse");

// A stalled mount for `life` seconds; null (and the test skips) when it cannot be mounted or does not stall.
async function stalled(dir: string, life: number, name = "mnt") {
  const at = join(dir, name);
  mkdirSync(at);
  const server = Bun.spawn(["python3", SERVER, at, String(life)], { stdout: "pipe", stderr: "ignore" });
  const reader = server.stdout.getReader();
  const first = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), Bun.sleep(3000).then(() => "")]);
  if (!first.startsWith("mounted")) { server.kill(); return null; }
  // (No probe by a stat of a process that is then killed: a request taken back is answered by the kernel.)
  if (!(await Bun.file("/proc/self/mountinfo").text()).includes(` ${at} `)) { server.kill(); return null; }
  return { at, ended: server.exited };
}

async function engineWith(dir: string, stall = 1) {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Gate } = await import("../safety/gate.ts");
  const { Engine } = await import("../engine/turn.ts");
  const { loadSettings, patchSettings } = await import("../admin/settings.ts");
  const { claudeTools } = await import("./claude.ts");
  const store = new Store(dir), bus = new Bus();
  const s = store.createSession({ title: "Fixture", model: "fixture:m", workspace: dir });
  loadSettings(store.stateDir, () => {});
  expect(patchSettings({ files: { stall_s: stall } }).ok).toBe(true);
  const gate = new Gate(store, bus);
  gate.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
  registerHooks({ beforeTool: (session, c) => session.id === s.id ? gate.beforeTool(s, c) : undefined });
  const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  const read = claudeTools.find((t) => t.name === "Read")!;
  const run = (id: string, path: string, signal: AbortSignal) =>
    ((engine as any).runTool(s, [read], { type: "tool_use", id, name: "Read", input: { file_path: path } }, { sessionId: s.id, cwd: dir, signal, spillDir: dir, seen: new Map() })) as Promise<any>;
  return { run, done: () => { allHooks().length -= 1; patchSettings({ files: { stall_s: 10 } }); store.db.close(); } };
}

// The longest time the loop went without running a timer, while `f` ran.
async function beat<T>(f: () => Promise<T>): Promise<{ out: T; gap: number; ms: number }> {
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  const t0 = performance.now();
  try { const out = await f(); return { out, gap: Math.max(gap, performance.now() - last), ms: performance.now() - t0 }; } finally { clearInterval(timer); }
}

test.skipIf(!canMount)("a Read on a mount that does not answer ends with a result within the limit, and the loop keeps running", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "stall-"));
  const { run, done } = await engineWith(dir);
  const mount = await stalled(dir, 4);
  if (!mount) return done(), console.log("skipped: needs a FUSE mount (fusermount3, python3, /dev/fuse)");
  try {
    const file = join(mount.at, "f.txt");
    const first = await beat(() => run("r1", file, new AbortController().signal));
    expect(first.out.is_error).toBe(true);
    expect(first.out.content).toContain("did not answer within 1 s");
    expect(first.out.content).toContain("Nothing was read or written");
    expect(first.ms).toBeLessThan(3000);
    expect(first.gap).toBeLessThan(500);
    // The mount is remembered: the next call is refused at once, not after another wait.
    const second = await beat(() => run("r2", join(mount.at, "other.txt"), new AbortController().signal));
    expect(second.out.content).toContain("still does not");
    expect(second.ms).toBeLessThan(300);
    expect(second.gap).toBeLessThan(500);
  } finally {
    await mount.ended;
    done();
  }
}, 20_000);

test.skipIf(!canMount)("a Stop ends a call that waits on a mount that does not answer, and says the read did not start", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "stall-"));
  const { run, done } = await engineWith(dir, 5);
  const mount = await stalled(dir, 4);
  if (!mount) return done(), console.log("skipped: needs a FUSE mount (fusermount3, python3, /dev/fuse)");
  try {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 1200);
    const r = await beat(() => run("r3", join(mount.at, "f.txt"), stop.signal));
    expect(r.out.is_error).toBe(true);
    expect(r.out.content).toContain("Interrupted");
    expect(r.out.content).toContain("had not answered for 1 s");
    expect(r.ms).toBeLessThan(2500);
    expect(r.gap).toBeLessThan(500);
  } finally {
    await mount.ended;
    done();
  }
}, 20_000);

const scratch = () => mkdtempSync(join(process.env.TMPDIR ?? ".", "stall-"));

test.skipIf(!canMount)("a stall reached through a link is the mount it resolves to: a healthy file beside the link is not refused", async () => {
  const dir = scratch();
  const mount = await stalled(dir, 5);
  if (!mount) return console.log("skipped: needs a FUSE mount (fusermount3, python3, /dev/fuse)");
  const { answers } = await import("./fs-bound.ts");
  try {
    const link = join(dir, "lnk");
    symlinkSync(mount.at, link);
    writeFileSync(join(dir, "ok.txt"), "fine");
    const first = await answers([join(link, "f0")], { ms: 800 });
    expect(first?.why).toBe("limit");
    expect(first?.mount).toBe(mount.at);
    // A healthy file on the mount that holds the link answers.
    expect(await answers([join(dir, "ok.txt"), dir, "/usr"], { ms: 800 })).toBeNull();
    // Another name through the link is known to be stalled without another wait.
    const t0 = performance.now();
    const again = await answers([join(link, "f1")], { ms: 800 });
    expect(again?.why).toBe("still");
    expect(again?.mount).toBe(mount.at);
    expect(performance.now() - t0).toBeLessThan(300);
  } finally { await mount.ended; }
}, 20_000);

test.skipIf(!canMount)("a call that names many paths on a stalled mount leaves the pool a thread for the rest of the daemon", async () => {
  const dir = scratch();
  const mount = await stalled(dir, 5);
  if (!mount) return console.log("skipped: needs a FUSE mount (fusermount3, python3, /dev/fuse)");
  const { answers } = await import("./fs-bound.ts");
  try {
    const paths = Array.from({ length: 32 }, (_, i) => join(mount.at, `f${i}`));
    const asked = answers(paths, { ms: 1500 });
    await Bun.sleep(300);
    // Any other stat of the daemon is answered while they wait (a pool with every thread taken would hold it).
    const t0 = performance.now();
    const other = await Promise.race([stat("/usr").then(() => "answered"), Bun.sleep(1000).then(() => "held")]);
    expect(other).toBe("answered");
    expect(performance.now() - t0).toBeLessThan(500);
    expect((await asked)?.why).toBe("limit");
  } finally { await mount.ended; }
}, 20_000);

test.skipIf(!canMount || availableParallelism() < 12)("nine stalled mounts do not stop a healthy path from being asked", async () => {
  const dir = scratch();
  const mounts = (await Promise.all(Array.from({ length: 9 }, (_, i) => stalled(dir, 14, `m${i}`)))).filter((m) => m !== null);
  if (mounts.length < 9) return console.log("skipped: needs nine FUSE mounts");
  const { answers } = await import("./fs-bound.ts");
  try {
    for (const m of mounts) expect((await answers([join(m.at, "f")], { ms: 300 }))?.why).toBe("limit");
    writeFileSync(join(dir, "ok.txt"), "fine");
    expect(await answers([join(dir, "ok.txt")], { ms: 300 })).toBeNull();
    // A path on one of them is still refused at once.
    expect((await answers([join(mounts[0]!.at, "g")], { ms: 300 }))?.why).toBe("still");
  } finally { await Promise.all(mounts.map((m) => m.ended)); }
}, 40_000);
