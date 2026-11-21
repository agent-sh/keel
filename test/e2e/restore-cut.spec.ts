import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Feature: a daemon starts on what a restore left. A restore.pending it cannot
// read (not written by a restore) moves nothing: the daemon says so, sets the
// file aside and serves the state as it found it. Runs its own daemons on a
// scratch state folder, on the scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string; out: () => string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], {
    env: {
      ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DRAIN_MS: "300",
      KEEL_CONFIG_DIR: join(state, "config"), KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, ""), out: () => out }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("a daemon starts on a state folder whose restore.pending cannot be read", async ({ request }) => {
  const state = join(ROOT, `restore-cut-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  let d = await daemon(state);
  try {
    const made = await request.post(`${d.url}/api/sessions`, { data: { model: "scripted:stand-in", title: "Here before and after" } });
    expect(made.status()).toBe(201);
    d.proc.kill("SIGTERM");
    await exited(d.proc);

    const pending = join(state, "state", "restore.pending");
    writeFileSync(pending, "");
    d = await daemon(state);
    expect(d.out()).toContain("restore.pending in");
    expect(d.out()).toContain("could not be read, so nothing was undone: the state is as it was found");
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(`${pending}.unreadable`)).toBe(true);
    const list = (await (await request.get(`${d.url}/api/sessions`)).json()).sessions as { title: string }[];
    expect(list.map((s) => s.title)).toEqual(["Here before and after"]);
  } finally {
    d.proc.kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
  }
});
