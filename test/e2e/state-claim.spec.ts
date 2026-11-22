import { expect, test } from "./isolate.ts";
import { freePort } from "./ports.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Feature: one daemon per state folder. Of two daemons started on one folder
// (other ports) one owns it; the other stops before it opens the database. A
// start after the owner was killed takes the folder over. Runs its own
// daemons on scratch state folders.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

const made: string[] = [];
type Started = { proc: ChildProcess; exited: Promise<number | null>; out: () => string; port: number };
const procs: Started[] = [];
test.afterAll(() => {
  for (const p of procs) p.proc.kill("SIGKILL");
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function start(state: string, port: number): Started {
  mkdirSync(join(state, "config"), { recursive: true });
  if (!made.includes(state)) made.push(state);
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", state], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config"), KEEL_DESKTOP_NOTIFY: "off" },
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once("exit", (c) => r(c)));
  const p = { proc, exited, out: () => out, port };
  procs.push(p);
  return p;
}

// The database, read and written beside the daemon (bun:sqlite, in a bun of its own).
const sql = (state: string, code: string) =>
  execFileSync("bun", ["-e", `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(join(state, "keel.db"))}); ${code}; db.close();`], { encoding: "utf8" }).trim();

const settled = async (p: Started) => {
  await expect.poll(() => p.out().includes("keel listening") || p.proc.exitCode !== null, { timeout: 60_000 }).toBe(true);
  return p.proc.exitCode === null ? "owns" : `exit ${p.proc.exitCode}`;
};

test("two daemons on one state folder: one owns it, the other opens nothing", async ({ request }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();

  // Started at once, three times over: exactly one owns the folder each time.
  for (let round = 0; round < 3; round++) {
    const state = join(ROOT, `claim-${stamp}-${round}`);
    const pair = [start(state, await freePort()), start(state, await freePort())];
    const ends = await Promise.all(pair.map(settled));
    // (With what each daemon said, should it fail: two that both gave up say why only there.)
    expect([...ends].sort(), pair.map((p, i) => `daemon ${i + 1} on port ${p.port}:\n${p.out().slice(-600)}`).join("\n---\n")).toEqual(["exit 1", "owns"]);
    const winner = pair[ends.indexOf("owns")]!, loser = pair[ends.indexOf("exit 1")]!;
    expect(loser.out()).toContain(`uses ${state}`);
    expect(loser.out()).not.toContain("keel listening");
    const d = await (await request.get(`http://127.0.0.1:${winner.port}/api/daemon`)).json();
    expect(d).toMatchObject({ pid: winner.proc.pid, state_dir: state });
    expect(JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")).pid).toBe(winner.proc.pid);
    winner.proc.kill("SIGKILL");
    await winner.exited;
  }

  // A daemon that owns a folder with a turn open. A second start on the folder
  // would reset that session at its own start, were it to open the database.
  const state = join(ROOT, `claim-${stamp}-owned`);
  const a = start(state, await freePort());
  expect(await settled(a)).toBe("owns");
  const now = Date.now();
  sql(state, `db.run("INSERT INTO sessions (id, model, workspace, created, updated, phase) VALUES ('s1', 'none', '/', ${now}, ${now}, 'working')")`);
  const b = start(state, await freePort());
  expect(await settled(b)).toBe("exit 1");
  expect(b.out()).toContain(`another daemon (pid ${a.proc.pid}, http://127.0.0.1:${a.port}) uses ${state}`);
  expect(sql(state, `console.log(db.query("SELECT phase FROM sessions WHERE id = 's1'").get().phase)`)).toBe("working");
  expect((await (await request.get(`http://127.0.0.1:${a.port}/api/daemon`)).json()).pid).toBe(a.proc.pid);

  // The owner is killed: what it left names a dead process, and the next start owns the folder.
  a.proc.kill("SIGKILL");
  await a.exited;
  expect(JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")).pid).toBe(a.proc.pid);
  const c = start(state, await freePort());
  expect(await settled(c)).toBe("owns");
  expect((await (await request.get(`http://127.0.0.1:${c.port}/api/daemon`)).json())).toMatchObject({ pid: c.proc.pid, state_dir: state });
  expect(JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8"))).toMatchObject({ pid: c.proc.pid, url: `http://127.0.0.1:${c.port}` });
  // The turn the killed daemon left open is the new owner's to close.
  expect(sql(state, `console.log(db.query("SELECT phase FROM sessions WHERE id = 's1'").get().phase)`)).toBe("idle");
});
