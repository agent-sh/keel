// A create on a mount that answers nothing (a network file system whose server is gone) holds neither the loop
// nor a Stop: the open waits on the thread pool, and the call that waits on it ends when the turn is stopped.
// The stall is real: a FUSE mount whose server never answers (test/support/stallfs.py). Skipped where FUSE
// cannot be mounted.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./types.ts";

const SERVER = join(import.meta.dir, "../../test/support/stallfs.py");
const canMount = !!Bun.which("fusermount3") && !!Bun.which("python3") && existsSync("/dev/fuse");

// A stalled mount for `life` seconds; null (and the test skips) when it cannot be mounted.
async function stalled(dir: string, life: number) {
  const at = join(dir, "mnt");
  mkdirSync(at);
  const server = Bun.spawn(["python3", SERVER, at, String(life)], { stdout: "pipe", stderr: "ignore" });
  const reader = server.stdout.getReader();
  const first = await Promise.race([reader.read().then((r) => new TextDecoder().decode(r.value)), Bun.sleep(3000).then(() => "")]);
  if (!first.startsWith("mounted") || !(await Bun.file("/proc/self/mountinfo").text()).includes(` ${at} `)) { server.kill(); return null; }
  return { at, ended: server.exited };
}

// The longest time the loop went without running a timer, while `f` ran.
async function beat<T>(f: () => Promise<T>): Promise<{ out: T; gap: number; ms: number }> {
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  const t0 = performance.now();
  try { const out = await f(); return { out, gap: Math.max(gap, performance.now() - last), ms: performance.now() - t0 }; } finally { clearInterval(timer); }
}

test.skipIf(!canMount)("a create on a mount that stops answering does not hold the loop, and a Stop ends the call", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "stall-"));
  const mount = await stalled(dir, 5);
  if (!mount) return console.log("skipped: needs a FUSE mount (fusermount3, python3, /dev/fuse)");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Engine } = await import("../engine/turn.ts");
  const { writeFile } = await import("./files.ts");
  mkdirSync(join(dir, "state"));
  const store = new Store(join(dir, "state")), bus = new Bus();
  try {
    const s = store.createSession({ title: "Fixture", model: "fixture:m", workspace: dir });
    const engine = new Engine(store, bus, {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
    // The file's whole path is the mount's: its folder is opened, then the name is made, on the mount.
    const target = join(mount.at, "made.txt");
    const create: Tool = {
      name: "Create", readOnly: false, description: "", input_schema: { type: "object", properties: {} },
      run: async (_input, ctx) => { const no = await writeFile(target, "x", ctx); return { type: "tool_result", tool_use_id: "c1", content: no ?? "made" } as any; },
    } as Tool;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 800);
    const r = await beat(() => (engine as any).runTool(s, [create], { type: "tool_use", id: "c1", name: "Create", input: {} },
      { sessionId: s.id, cwd: dir, signal: stop.signal, spillDir: dir, seen: new Map() }) as Promise<any>);
    expect(r.out.is_error).toBe(true);
    expect(r.out.content).toContain("Interrupted");
    // Ended by the Stop, not by the mount going away (it lives five seconds).
    expect(r.ms).toBeLessThan(3000);
    expect(r.gap).toBeLessThan(400);
    // Nothing is held for the name after the call ended.
    const { ioOf } = await import("./files.ts");
    expect(ioOf(target)).toBe(target);
  } finally {
    await mount.ended;
    store.db.close();
  }
}, 20_000);
