import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";

// Feature: a daemon a spec starts from the run's environment ({ ...process.env },
// as the specs that start their own daemons do) finds none of the owner's own
// tools or setups, whatever shell ran the specs: no tacit (his memory store), no
// parlar (his mic and speaker), no Hermes gateway (his phone), and no harness
// setups or sessions from his home (playwright.config.ts names the defaults).
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const under = (p: string, dir: string) => !relative(dir, p).startsWith("..");

test("a spec's own daemon finds none of the owner's tools or setups", async ({ request }) => {
  // What the daemon would find, from the environment it would take: checked before one starts.
  // A program is looked for as findBin (src/integrations/tacit.ts) and discoverParlar
  // (src/integrations/voice.ts) look: the variable when it is set, else PATH and ~/.local/bin.
  const env = { ...process.env };
  const found = (variable: string, name: string) => {
    const given = env[variable]?.trim();
    if (given) return existsSync(given) ? given : null;
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
    return existsSync(join(homedir(), ".local/bin", name)) ? join(homedir(), ".local/bin", name) : null;
  };
  expect(found("TACIT_BIN", "tacit"), "tacit found").toBeNull();
  expect(found("KEEL_PARLAR", "parlar"), "parlar found").toBeNull();
  const phone = env.KEEL_PHONE_SOCKET ?? "";
  expect(!!phone && !under(phone, join(homedir(), ".hermes")), `phone socket ${phone}`).toBe(true);
  // The other harnesses' setups and sessions: read from folders under the e2e state, not the home.
  for (const k of ["KEEL_IMPORT_HOME", "KEEL_IMPORT_CLAUDE_DIR", "KEEL_IMPORT_CODEX_DIR", "KEEL_IMPORT_AGY_DIR", "KEEL_IMPORT_HERMES_DIR", "KEEL_IMPORT_OPENCODE_DIR", "KEEL_IMPORT_KEEL_DB"]) {
    expect(!!env[k] && (!under(env[k]!, homedir()) || under(env[k]!, join(homedir(), ".cache"))), `${k}=${env[k]}`).toBe(true);
  }

  // A daemon started so says the memory and voice servers are not installed.
  const state = join(ROOT, `spec-env-${Date.now().toString(36)}`);
  mkdirSync(state, { recursive: true });
  let proc: ChildProcess | undefined;
  try {
    proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], {
      env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config"), KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
      const on = (d: Buffer) => { out += d; const m = out.match(/keel listening on (http:\/\/\S+?)\/? /); if (m) { clearTimeout(t); resolve(m[1]!); } };
      proc!.stdout!.on("data", on);
      proc!.stderr!.on("data", on);
    });
    const servers = (await (await request.get(`${url}/api/mcp/servers`)).json()).servers as { name: string; state: string }[];
    const of = (n: string) => servers.find((s) => s.name === n)?.state;
    expect(of("tacit")).toBe("missing");
    expect(of("parlar")).toBe("missing");
  } finally {
    proc?.kill("SIGTERM");
    await new Promise((r) => (proc && proc.exitCode === null ? proc.once("exit", r) : r(null)));
    rmSync(state, { recursive: true, force: true });
  }
});
