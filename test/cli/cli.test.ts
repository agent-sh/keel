// The command line, end to end: the compiled binary, a real daemon it starts
// (`keel serve`) or runs inside itself (`keel run` with none answering), and
// the scripted stand-in model, so every path is deterministic and free.
// Run: bun test ./test/cli   (builds the binary first)
// Each run works in a folder of its own, so two runs at once do not collide:
// KEEL_CLI_SCRATCH names it (default: one per process, removed at the end).
// KEEL_CLI_BIN runs a binary built before instead of building one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRATCH = process.env.KEEL_CLI_SCRATCH || join(process.env.HOME!, ".cache/keel-work/bun", `cli-test-${process.pid}`);
const BIN = join(SCRATCH, "keel");
const WS = join(SCRATCH, "ws");
const ENV = {
  ...process.env,
  // The binary has no test guard of its own: its config folder is named here, whatever folder the run starts in.
  KEEL_CONFIG_DIR: join(SCRATCH, "keel-config"),
  KEEL_SCRIPTED_PROVIDER: "1",
  KEEL_DEFAULT_MODEL: "scripted:stand-in",
  KEEL_URL: "",
  KEEL_IMPORT_CLAUDE_DIR: join(SCRATCH, "claude"),
  KEEL_IMPORT_CODEX_DIR: join(SCRATCH, "codex"),
  KEEL_IMPORT_KEEL_DB: join(SCRATCH, "none.db"),
  KEEL_IMPORT_AGY_DIR: join(SCRATCH, "agy"),
  KEEL_BROWSER: "true",
  KEEL_PHONE_SOCKET: join(SCRATCH, "phone.sock"), // never the owner's Hermes gateway
};

type Ran = { code: number; out: string; err: string };
async function keel(args: string[], o: { state: string; stdin?: string; cwd?: string; signalAfterMs?: number; env?: Record<string, string> } ): Promise<Ran> {
  const p = Bun.spawn([BIN, ...args], {
    cwd: o.cwd ?? WS,
    env: { ...ENV, KEEL_STATE_DIR: o.state, ...o.env },
    stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (o.signalAfterMs) setTimeout(() => p.kill("SIGINT"), o.signalAfterMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const json = (s: string) => JSON.parse(s);
const lines = (s: string) => s.trim().split("\n").filter(Boolean).map(json);

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  if (process.env.KEEL_CLI_BIN) return symlinkSync(process.env.KEEL_CLI_BIN, BIN);
  // Built from a folder that is not the repository: the script finds its sources by itself.
  const b = Bun.spawnSync(["bun", join(ROOT, "scripts/build.ts"), BIN], { cwd: SCRATCH, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) throw new Error(`build failed: ${b.stderr}`);
  for (const f of [BIN, `${BIN}-ui.tar.gz`]) if (!existsSync(f)) throw new Error(`the build did not write ${f}`);
}, 120_000);
// A run's own default folder goes with it; a named one is the caller's to keep.
afterAll(() => { if (!process.env.KEEL_CLI_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true }); });

describe("help, usage and completion", () => {
  const state = join(SCRATCH, "state-help");
  test("help per command, a short usage for an unknown one, completion for bash, zsh and fish", async () => {
    const top = await keel(["--help"], { state });
    expect(top.code).toBe(0);
    for (const c of ["run", "send", "sessions", "show", "stop", "resume", "import", "completion"]) expect(top.out).toContain(`  ${c} `);
    const runHelp = await keel(["run", "--help"], { state });
    expect(runHelp.code).toBe(0);
    expect(runHelp.out).toContain("--output-format");
    const unknown = await keel(["frobnicate"], { state });
    expect(unknown.code).toBe(3);
    expect(unknown.err).toContain("unknown command");
    const bad = await keel(["run", "--bogus"], { state });
    expect(bad.code).toBe(3);
    expect(bad.err).toContain("keel run [PROMPT]");

    // A --bind with no port a daemon can listen on is a usage error, said before a state folder is made.
    const unbound = join(SCRATCH, "state-bind");
    for (const b of ["127.0.0.1", "127.0.0.1:http", "127.0.0.1:65536"]) {
      const r = await keel(["serve", "--bind", b, "--state-dir", unbound], { state });
      expect(r.code).toBe(3);
      expect(r.err).toContain(`--bind is HOST:PORT with a port from 0 to 65535, not "${b}"`);
      expect(r.err).toContain("keel serve [--bind HOST:PORT]");
    }
    expect(existsSync(unbound)).toBe(false);

    const script = await keel(["completion", "bash"], { state });
    expect(script.code).toBe(0);
    writeFileSync(join(SCRATCH, "completion.bash"), script.out);
    const probe = Bun.spawnSync(["bash", "-c", `PATH=${SCRATCH}:$PATH; source ${SCRATCH}/completion.bash; COMP_WORDS=(keel ru); COMP_CWORD=1; _keel; echo "\${COMPREPLY[@]}"; COMP_WORDS=(keel run --output-f); COMP_CWORD=2; _keel; echo "\${COMPREPLY[@]}"; COMP_WORDS=(keel import --); COMP_CWORD=2; _keel; echo "\${COMPREPLY[@]}"`], { env: { ...ENV, KEEL_STATE_DIR: state } });
    const [words, flags, importFlags] = probe.stdout.toString().trim().split("\n");
    expect(words).toContain("run");
    expect(flags).toBe("--output-format");
    // Every flag a command's help names, also the ones written in brackets or after a bar.
    expect(importFlags!.split(" ")).toEqual(["--all", "--cursor", "--cwd", "--harness", "--json", "--limit", "--mode", "--path", "--show", "--sort", "--title"]);

    // zsh: its function, over stand-ins for the completion calls zsh has only inside its line editor.
    // The words it offers for a command, a flag, a flag's value and a first argument.
    const zsh = await keel(["completion", "zsh"], { state });
    expect(zsh.code).toBe(0);
    expect(zsh.out.split("\n")[0]).toBe("#compdef keel");
    if (Bun.which("zsh")) {
      writeFileSync(join(SCRATCH, "completion.zsh"), zsh.out);
      const ask = (...w: string[]) => `words=(keel ${w.map((x) => JSON.stringify(x)).join(" ")}); CURRENT=${w.length + 1}; _keel | tr '\\n' ' '; echo`;
      const z = Bun.spawnSync(["zsh", "-f", "-c", `PATH=${SCRATCH}:$PATH; compadd() { [[ $1 == -- ]] && shift; print -l -- "$@" }; compdef() { : }; _files() { print FILES }; source ${SCRATCH}/completion.zsh; ${ask("ru")}; ${ask("run", "--out")}; ${ask("run", "--output-format", "")}; ${ask("completion", "")}; ${ask("run", "")}; ${ask("import", "--mo")}`], { env: { ...ENV, KEEL_STATE_DIR: state } });
      const [zWords, zFlags, zValues, zShells, zFiles, zImport] = z.stdout.toString().trimEnd().split("\n").map((l) => l.trim());
      expect(zImport!.split(" ")).toContain("--mode");
      expect(z.stderr.toString()).toBe("");
      expect(zWords!.split(" ")).toContain("run");
      expect(zFlags!.split(" ")).toContain("--output-format");
      expect([zValues, zShells, zFiles]).toEqual(["text json stream-json", "bash zsh fish", "FILES"]);
    }
    // fish: what fish itself offers for the same lines (run where fish is installed).
    const fish = await keel(["completion", "fish"], { state });
    expect(fish.code).toBe(0);
    expect(fish.out).toContain("complete -c keel");
    if (Bun.which("fish")) {
      writeFileSync(join(SCRATCH, "completion.fish"), fish.out);
      const offers = (line: string) => Bun.spawnSync(["fish", "--no-config", "-c", `source ${SCRATCH}/completion.fish; complete -C ${JSON.stringify(line)}`], { env: { ...ENV, KEEL_STATE_DIR: state, PATH: `${SCRATCH}:${process.env.PATH}`, HOME: SCRATCH } })
        .stdout.toString().trim().split("\n").map((l) => l.split("\t")[0]);
      expect(offers("keel ru")).toContain("run");
      expect(offers("keel run --output-f")).toEqual(["--output-format"]);
      expect(offers("keel run --output-format ")).toEqual(["json", "stream-json", "text"]);
      expect(offers("keel completion ")).toEqual(["bash", "fish", "zsh"]);
      expect(offers("keel import --mo")).toEqual(["--mode"]);
    }
    // A shell there is no script for is a usage error that names the three.
    const none = await keel(["completion", "tcsh"], { state });
    expect(none.code).toBe(3);
    expect(none.err).toContain("keel completion bash|zsh|fish");
  });
});

// The words of a unit's ExecStart line as systemd reads them: split at blanks
// outside double quotes, a backslash escapes inside them, %% is a percent
// sign and $$ a dollar sign.
function execWords(line: string): string[] {
  const out: string[] = [];
  let cur = "", open = false, any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (open) {
      if (c === "\\") cur += line[++i];
      else if (c === '"') open = false;
      else cur += c;
    } else if (c === '"') { open = true; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; }
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out.map((w) => w.replaceAll("%%", "%").replaceAll("$$", "$"));
}

describe("keel service install", () => {
  const state = join(SCRATCH, "state-service");
  const config = join(SCRATCH, "service config");
  // The paths hold what a unit file reads specially: spaces, a percent sign, a dollar sign and,
  // where systemd takes one (not in the executable's path), a quote.
  const odd = join(SCRATCH, "odd 100% $HOME dir");
  const exec = join(odd, "bin dir", "keel");
  const workspace = join(odd, 'work "space"');
  const stateDir = join(odd, "state dir");
  const args = ["service", "install", "--bind", "127.0.0.1:0", "--exec", exec, "--workspace", workspace, "--state-dir", stateDir];
  const unitPath = join(config, "systemd/user/keel-bun.service");
  beforeAll(() => {
    mkdirSync(join(odd, "bin dir"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    symlinkSync(BIN, exec);
  });

  test("the unit keeps the executable, workspace and state paths as single words", async () => {
    // --print shows the unit and writes nothing.
    const printed = await keel([...args, "--print"], { state, env: { XDG_CONFIG_HOME: config } });
    expect(printed.code).toBe(0);
    expect(existsSync(config)).toBe(false);
    const line = printed.out.split("\n").find((l) => l.startsWith("ExecStart="))!;
    expect(execWords(line.slice("ExecStart=".length))).toEqual([exec, "serve", "--bind", "127.0.0.1:0", "--workspace", workspace, "--state-dir", stateDir]);

    // Installed: the unit file and nothing else. Nothing links it in (not enabled) and no daemon runs.
    const installed = await keel(args, { state, env: { XDG_CONFIG_HOME: config } });
    expect(installed.code).toBe(0);
    expect(readFileSync(unitPath, "utf8")).toBe(printed.out);
    expect(readdirSync(config, { recursive: true }).map(String).sort()).toEqual(["systemd", "systemd/user", "systemd/user/keel-bun.service"]);
    expect(existsSync(stateDir)).toBe(false);

    // systemd reads it the same way: it finds the executable at its whole path.
    if (Bun.which("systemd-analyze")) {
      const v = Bun.spawnSync(["systemd-analyze", "--user", "verify", unitPath], { stdout: "pipe", stderr: "pipe" });
      expect(v.stderr.toString().split("\n").filter((l) => l.includes("keel-bun.service"))).toEqual([]);
    }

    // Without the two paths the unit is the plain one: the daemon keeps its defaults.
    const plain = await keel(["service", "install", "--print"], { state, env: { XDG_CONFIG_HOME: config } });
    expect(plain.out).toMatch(/^ExecStart=\S+ serve --bind 127\.0\.0\.1:47960$/m);

    // An executable systemd would refuse is refused here, and the unit on disk stays as it was.
    const quoted = await keel(["service", "install", "--exec", join(odd, 'the "keel"')], { state, env: { XDG_CONFIG_HOME: config } });
    expect([quoted.code, quoted.out, quoted.err.trim()]).toEqual([1, "", `keel: systemd does not start an executable whose path holds a quote, a backslash or a control character: ${JSON.stringify(join(odd, 'the "keel"'))}`]);
    // A tab or a delete character too: systemd reads neither in the path it executes.
    for (const name of ["the\tkeel", "the\x7fkeel"]) {
      const control = await keel(["service", "install", "--print", "--exec", join(odd, name)], { state, env: { XDG_CONFIG_HOME: config } });
      expect([control.code, control.out, control.err.trim()]).toEqual([1, "", `keel: systemd does not start an executable whose path holds a quote, a backslash or a control character: ${JSON.stringify(join(odd, name))}`]);
    }
    expect(readFileSync(unitPath, "utf8")).toBe(printed.out);
  }, 30_000);

  test("a daemon started by the unit's command line uses the workspace and state it names", async () => {
    const line = readFileSync(unitPath, "utf8").split("\n").find((l) => l.startsWith("ExecStart="))!;
    const p = Bun.spawn(execWords(line.slice("ExecStart=".length)), { cwd: SCRATCH, env: { ...ENV, KEEL_SUPERVISED: "", KEEL_DRAIN_MS: "300" }, stdout: "pipe", stderr: "pipe" });
    try {
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of p.stdout) { out += dec.decode(chunk); if (/keel listening on \S+/.test(out)) break; }
      const url = out.match(/keel listening on (http:\/\/\S+?)\/? /)![1]!;
      const daemon = await (await fetch(`${url}/api/daemon`)).json() as any;
      const spaces = await (await fetch(`${url}/api/workspaces`)).json() as any;
      expect({ state: daemon.state_dir, workspace: spaces.default }).toEqual({ state: stateDir, workspace });
    } finally {
      p.kill();
      await p.exited;
    }
  }, 60_000);
});

describe("keel serve on a port taken after its check", () => {
  // The port is bound by a program that does not listen: a connection to it is refused, as
  // on a free port, so the daemon's own check passes and its bind fails.
  test.skipIf(!Bun.which("python3"))("exits with the reason, and leaves the state folder free", async () => {
    const state = join(SCRATCH, "state-taken");
    const holder = Bun.spawn(["python3", "-c", 'import socket,time; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1], flush=True); time.sleep(60)'], { stdout: "pipe", stderr: "ignore" });
    try {
      const reader = holder.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      expect(port).toBeGreaterThan(0);
      const p = Bun.spawn([BIN, "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "pipe" });
      // A daemon that stayed would outlive this wait: it ended by itself.
      const code = await Promise.race([p.exited, Bun.sleep(15_000).then(() => "still running")]);
      if (code === "still running") p.kill("SIGKILL");
      const err = await new Response(p.stderr).text();
      expect([code, err.trim()]).toEqual([1, `keel serve: 127.0.0.1:${port} could not be bound: port ${port} is in use (it was taken after it was checked). Stop what holds it, or pick another --bind.`]);
      expect(await new Response(p.stdout).text()).not.toContain("keel listening");
      expect(existsSync(join(state, "daemon.lock"))).toBe(false);
      // The folder is free: a daemon starts on it at once.
      const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: { ...ENV, KEEL_DRAIN_MS: "300" }, stdout: "pipe", stderr: "ignore" });
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of d.stdout) { out += dec.decode(chunk); if (out.includes("keel listening")) break; }
      expect(out).toContain(`(state ${state})`);
      d.kill();
      await d.exited;
    } finally {
      holder.kill();
    }
  }, 60_000);
});

describe("keel serve after a daemon whose pid is still there", () => {
  // A daemon that was killed keeps its pid until its parent reads its end. Under a parent that
  // never does (here: a sleep), it is there for good, and it holds nothing: not the folder, not the port.
  const under = async (state: string, port: number, log: string) => {
    const sh = Bun.spawn(["sh", "-c", '"$0" serve --bind "127.0.0.1:$1" --state-dir "$2" --workspace "$3" > "$4" 2>&1 & echo $!; exec sleep 600', BIN, String(port), state, WS, log],
      { cwd: WS, env: { ...ENV, KEEL_DRAIN_MS: "300" }, stdout: "pipe", stderr: "ignore" });
    const reader = sh.stdout.getReader();
    const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    return { pid, parent: sh };
  };
  const answers = async (url: string, not?: number, ms = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const pid = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }).then(async (r) => ((await r.json()) as { pid: number }).pid, () => undefined);
      if (pid && pid !== not) return { pid, ms: Date.now() - t0 };
      if (Date.now() - t0 > ms) return { pid: undefined, ms: Date.now() - t0 };
      await Bun.sleep(50);
    }
  };
  const listens = (port: number) => Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, error() {} } }).then((c) => (c.end(), true), () => false);
  const state = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2)[0]; } catch { return "gone"; } };

  test.skipIf(process.platform !== "linux")("a killed daemon is replaced at once, and a restart does not wait for the daemon it replaces to be read by its parent", async () => {
    const dir = join(SCRATCH, "state-zombie"), port = freePort(), url = `http://127.0.0.1:${port}`;
    mkdirSync(dir, { recursive: true });
    const first = await under(dir, port, join(SCRATCH, "zombie-1.log"));
    let second: Awaited<ReturnType<typeof under>> | undefined;
    let last: number | undefined;
    try {
      expect((await answers(url)).pid).toBe(first.pid);
      process.kill(first.pid, "SIGKILL");
      while (await listens(port)) await Bun.sleep(25);
      // Its pid is still there, and the lock file still names it.
      for (let i = 0; i < 200 && state(first.pid) !== "Z"; i++) await Bun.sleep(25);
      expect([state(first.pid), json(readFileSync(join(dir, "daemon.lock"), "utf8")).pid]).toEqual(["Z", first.pid]);
      // A start on its folder and its port takes both.
      second = await under(dir, port, join(SCRATCH, "zombie-2.log"));
      const took = await answers(url, first.pid);
      expect([took.pid, readFileSync(join(SCRATCH, "zombie-2.log"), "utf8")]).toEqual([second.pid, expect.stringContaining("keel listening")]);
      // A restart: the daemon that drained stays as a zombie under its parent, and the one it started answers
      // without the minute a start gives a daemon before it to go.
      const drained = await (await fetch(`${url}/api/drain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout_seconds: 1, restart: true }) })).json();
      expect(drained).toMatchObject({ ok: true, restart: true });
      const next = await answers(url, second.pid, 45_000);
      last = next.pid;
      expect(next.pid).toBeGreaterThan(0);
      expect(next.ms).toBeLessThan(30_000);
      expect(state(second.pid)).toBe("Z");
    } finally {
      for (const pid of [first.pid, second?.pid, last]) if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
      first.parent.kill("SIGKILL");
      second?.parent.kill("SIGKILL");
    }
  }, 120_000);
});

describe("keel help serve", () => {
  const state = join(SCRATCH, "state-help-serve");
  test("prints the serve usage, as serve --help does, and starts no daemon", async () => {
    const viaHelp = await keel(["help", "serve"], { state });
    const viaFlag = await keel(["serve", "--help"], { state });
    expect([viaHelp.code, viaHelp.out, viaFlag.code, existsSync(state)]).toEqual([0, viaFlag.out, 0, false]);
    expect(viaHelp.out).toStartWith("keel serve [--bind HOST:PORT]");
  });
});

// The daemon's administration, against a stand-in that records what it is asked.
describe("admin commands", () => {
  const state = join(SCRATCH, "state-admin");
  const asked: string[] = [];
  let answers: Record<string, unknown> = {};
  let stand: ReturnType<typeof Bun.serve>;
  const k = (args: string[]) => keel([...args, "--url", `http://127.0.0.1:${stand.port}`], { state, env: { XDG_CONFIG_HOME: join(SCRATCH, "config") } });
  beforeAll(() => {
    stand = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      const u = new URL(req.url);
      asked.push(`${req.method} ${u.pathname}${u.search}${req.method === "POST" ? ` ${await req.text()}` : ""}`);
      return Response.json(u.pathname === "/api/health" ? { ok: true, pid: 1 } : answers[u.pathname] ?? {});
    } });
  });
  afterAll(() => stand?.stop(true));

  test("a malformed option prints the usage, exits 3 and asks the daemon nothing", async () => {
    asked.length = 0;
    const bogus = await k(["status", "--bogus"]);
    // --bind with no value, last on the line; the unit file would go under the scratch config.
    const bind = await keel(["service", "install", "--bind"], { state, env: { XDG_CONFIG_HOME: join(SCRATCH, "config") } });
    const trace = /\n\s+at /;
    expect({ bogus: [bogus.code, bogus.out, bogus.err.split("\n")[0], bogus.err.includes("\n\nkeel status [--url URL] [--json]"), trace.test(bogus.err)],
      bind: [bind.code, bind.out, bind.err.split("\n")[0], bind.err.includes("\n\nkeel service install [--bind HOST:PORT]"), trace.test(bind.err)],
      asked, written: existsSync(join(SCRATCH, "config")) }).toEqual({
      bogus: [3, "", "keel status: Unknown option '--bogus'", true, false],
      bind: [3, "", "keel service: Option '--bind <value>' argument missing", true, false],
      asked: [], written: false,
    });
  }, 30_000);

  test("-h is --help for a command, and asks the daemon nothing", async () => {
    asked.length = 0;
    const got: Record<string, [number, boolean, string]> = {};
    for (const c of ["status", "drain", "backups", "service", "ui", "debug", "pair", "devices", "notify", "acp"]) {
      const short = await keel([c, "-h"], { state });
      const long = await keel([c, "--help"], { state });
      got[c] = [short.code, short.out === long.out && short.out.startsWith("keel "), short.err];
    }
    expect(got).toEqual(Object.fromEntries(Object.keys(got).map((c) => [c, [0, true, ""]])));
    expect((await k(["status", "-h"])).out).toStartWith("keel status [--url URL] [--json]");
    expect(asked).toEqual([]);
  }, 60_000);

  test("ui install: a missing bundle or a folder is a local error and asks the daemon nothing", async () => {
    asked.length = 0;
    const missing = join(SCRATCH, "no-such-bundle.tar.gz");
    const gone = await k(["ui", "install", missing]);
    const folder = await k(["ui", "install", SCRATCH]);
    expect({ gone: [gone.code, gone.out, gone.err.trim()], folder: [folder.code, folder.out, folder.err.trim()], asked }).toEqual({
      gone: [1, "", `keel: no UI bundle at ${missing}`],
      folder: [1, "", `keel: ${SCRATCH} is a folder, not a UI bundle (bun scripts/build.ts --ui OUT.tar.gz makes one)`],
      asked: [],
    });
    // A real file and no daemon at the address: the connection is what is reported.
    const real = join(SCRATCH, "a-bundle.tar.gz");
    writeFileSync(real, "not read: nothing answers");
    const dead = await keel(["ui", "install", real, "--url", "http://127.0.0.1:9"], { state, env: { XDG_CONFIG_HOME: join(SCRATCH, "config") } });
    expect([dead.code, dead.out, dead.err.trim()]).toEqual([1, "", "keel: no daemon answers at http://127.0.0.1:9 (pass --url or set KEEL_URL)"]);
  }, 30_000);

  test("port --apply exits by its result with --json as without", async () => {
    const item = { id: "skills:one", area: "skills", source: "claude", title: "one", state: "new", pick: true };
    const got: unknown[] = [];
    for (const [failed, it] of [[1, { ...item, error: "could not be copied" }], [0, { ...item, result: "copied" }]] as [number, Record<string, unknown>][]) {
      answers = { "/api/port": { items: [it], counts: { applied: 1 - failed, failed } } };
      const asJson = await k(["port", "--apply", "--json"]);
      const asText = await k(["port", "--apply"]);
      got.push([failed, asJson.code, json(asJson.out), asText.code, asText.out.includes(String(it.error ?? it.result))]);
    }
    expect(got).toEqual([
      [1, 3, { items: [{ ...item, error: "could not be copied" }], counts: { applied: 0, failed: 1 } }, 3, true],
      [0, 0, { items: [{ ...item, result: "copied" }], counts: { applied: 1, failed: 0 } }, 0, true],
    ]);
  }, 30_000);

  test("upgrade --help says it restarts the binary in place and installs nothing", async () => {
    const up = await k(["upgrade", "--help"]);
    const re = await k(["restart", "--help"]);
    // The alias still asks for the same drain with a restart.
    answers = { "/api/daemon": { pid: 1 }, "/api/drain": { running: [] } };
    asked.length = 0;
    const ran = await k(["upgrade", "--no-wait", "--timeout", "5"]);
    expect({ up: [up.code, up.out.split("\n").slice(0, 3)], re: [re.code, re.out], ran: [ran.code, ran.out, asked.at(-1)] }).toEqual({
      up: [0, ["keel upgrade [--timeout SECONDS] [--no-wait] [--url URL]", "  Restarts the daemon from the binary already at its path, the same as keel restart.", "  It installs nothing: put a new binary there first."]],
      re: [0, "keel restart [--timeout SECONDS] [--no-wait] [--url URL]\n  Stops new work, lets running turns finish (default 120 s), parks the rest so they continue after the start, then starts the daemon again from its binary.\n"],
      ran: [0, "draining: 0 turns running, up to 5 s\n", 'POST /api/drain {"timeout_seconds":5,"restart":true}'],
    });
  }, 30_000);

  test("usage --days takes a number of days above 0, and nothing else", async () => {
    const sinceOf = async (args: string[]) => {
      asked.length = 0;
      const r = await k(["usage", "--json", ...args]);
      const since = Number(asked.join(" ").match(/since_ms=(\d+)/)?.[1]);
      return [r.code, asked.length, Math.round((Date.now() - since) / 3_600_000)];
    };
    const got: Record<string, unknown> = { none: await sinceOf([]), two: await sinceOf(["--days", "2"]), half: await sinceOf(["--days=0.5"]) };
    for (const bad of ["soon", "0", "-3", "Infinity", ""]) {
      asked.length = 0;
      const r = await k(["usage", `--days=${bad}`]);
      got[`bad ${bad}`] = [r.code, asked.length, r.err.includes("--days is a number of days above 0") && r.err.includes("keel usage [--days N]")];
    }
    const refused = [3, 0, true];
    expect(got).toEqual({ none: [0, 1, 168], two: [0, 1, 48], half: [0, 1, 12], "bad soon": refused, "bad 0": refused, "bad -3": refused, "bad Infinity": refused, "bad ": refused });
  }, 60_000);
});

describe("an address another program answers on", () => {
  const state = join(SCRATCH, "state-other");
  test("is said to be no Keel daemon, not shown as the daemon's refusal", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "Not found" }, { status: 404 }) });
    try {
      const url = `http://127.0.0.1:${other.port}`;
      for (const args of [["status"], ["restart", "--no-wait"], ["sessions"]]) {
        const r = await keel([...args, "--url", url], { state });
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(`no Keel daemon answers at ${url}`);
        expect(r.err).not.toContain("Not found");
      }
    } finally {
      other.stop(true);
    }
  });
});

describe("keel run with no daemon", () => {
  const state = join(SCRATCH, "state-headless");
  test("prints the answer, a result object, or stream lines, and exits by the outcome", async () => {
    const text = await keel(["-p", "hello"], { state });
    expect(text.code).toBe(0);
    expect(text.out).toBe("Scripted reply.\n");

    const one = await keel(["run", "--output-format", "json", "again"], { state });
    expect(one.code).toBe(0);
    const r = json(one.out);
    expect(r).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "Scripted reply.", outcome: "success", num_turns: 1, on_ask: "deny" });
    expect(r.total_cost_usd).toBeGreaterThan(0);

    // Piped input next to a prompt is context; partial text streams.
    const stream = await keel(["run", "--stream-json", "--include-partial-messages", "sum it up"], { state, stdin: "the piped context\n" });
    expect(stream.code).toBe(0);
    const ls = lines(stream.out);
    expect(ls[0]).toMatchObject({ type: "system", subtype: "init", model: "scripted:stand-in" });
    expect(ls.find((l) => l.type === "user").message.content[0].text).toContain("<stdin>\nthe piped context\n</stdin>");
    // The streamed text is the reply, once and before its message, also when
    // the turn ended before this command could listen to it.
    const streamed = ls.filter((l) => l.type === "stream_event" && l.event.delta.type === "text_delta");
    expect(streamed.map((l) => l.event.delta.text).join("")).toBe("Scripted reply.");
    expect(ls.indexOf(streamed.at(-1))).toBeLessThan(ls.findIndex((l) => l.type === "assistant"));
    expect(ls.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // The workbench's session continues later: --continue picks the newest of the folder.
    const cont = await keel(["run", "-c", "--output-format", "json", "one more"], { state });
    expect(json(cont.out).session_id).toBe(ls[0].session_id);

    // A card nobody can answer is refused, and the turn goes on.
    const ask = await keel(["-p", "--permission-mode", "ask", "script:write-tool"], { state });
    expect(ask.code).toBe(0);
    expect(ask.out).toBe("Finished after the tool.\n");
    expect(ask.err).toContain("refused 1");
    const exitAsk = await keel(["-p", "--on-ask", "exit", "x"], { state });
    expect(exitAsk.code).toBe(3);

    const slow = await keel(["run", "--output-format", "json", "--timeout", "1", "script:slow"], { state });
    expect(slow.code).toBe(124);
    expect(json(slow.out)).toMatchObject({ subtype: "timeout", timed_out: true });

    const sig = await keel(["-p", "script:slow"], { state, signalAfterMs: 1200 });
    expect(sig.code).toBe(130);

    const none = await keel(["-p"], { state });
    expect(none.code).toBe(3);
  }, 60_000);

  // --json-schema: the answer is one JSON value checked against the schema.
  // It is printed alone, or as structured_output of the result object; an
  // answer that does not match is sent back, and one that never matches
  // exits non-zero with no structured_output.
  test("an answer checked against a JSON schema", async () => {
    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false };
    const file = join(SCRATCH, "schema.json");
    writeFileSync(file, JSON.stringify(schema));
    const replies = (...texts: string[]) => `script:replies ${JSON.stringify(texts)}`;

    // The schema from a file; the value alone on standard output.
    const text = await keel(["run", "-p", "--json-schema", file, replies('{"count": 3}')], { state });
    expect(text.err).not.toContain("never matched");
    expect(text.code).toBe(0);
    expect(text.out).toBe('{"count":3}\n');

    // The schema inline; the value in the result object, read out of a fenced answer.
    const one = await keel(["run", "--output-format", "json", "--json-schema", JSON.stringify(schema), replies('Here it is:\n```json\n{"count": 4}\n```')], { state });
    expect(one.code).toBe(0);
    expect(json(one.out)).toMatchObject({ subtype: "success", is_error: false, structured_output: { count: 4 }, num_turns: 1 });

    // A first answer that does not match is sent back with what is wrong; the second matches.
    const fixed = await keel(["run", "--stream-json", "--output-schema", file, replies('{"count": "three"}', '{"count": 3}')], { state });
    expect(fixed.code).toBe(0);
    const ls = lines(fixed.out);
    expect(ls.at(-1)).toMatchObject({ type: "result", subtype: "success", structured_output: { count: 3 }, num_turns: 2 });
    const asked = ls.filter((l) => l.type === "user").map((l) => l.message.content[0].text as string);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(`must be only one JSON value that matches this JSON schema, with no other text:\n${JSON.stringify(schema)}`);
    expect(asked[1]).toBe("Your answer does not match the JSON schema you were given: $.count: expected integer, got string. Reply with only the JSON value, nothing else.");

    // One that never matches: non-zero, no structured_output, nothing but the reason.
    const never = await keel(["run", "--output-format", "json", "--json-schema", file, replies("I would rather not.")], { state });
    expect(never.code).toBe(3);
    const n = json(never.out);
    expect(n).toMatchObject({ subtype: "error_max_structured_output_retries", is_error: true, num_turns: 3 });
    expect(n.structured_output).toBeUndefined();
    const plain = await keel(["run", "-p", "--json-schema", file, replies("Still no.")], { state });
    expect(plain.code).toBe(3);
    expect(plain.out).toBe("");
    expect(plain.err).toContain("the answer never matched the schema (the answer is not JSON)");

    // A schema that is none is refused before anything is sent.
    const bad = await keel(["run", "-p", "--json-schema", "{not json", "x"], { state });
    expect(bad.code).toBe(3);
    expect(bad.err).toContain("--json-schema is not JSON");
    const missing = await keel(["run", "-p", "--json-schema", join(SCRATCH, "no-such.json"), "x"], { state });
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("--json-schema is a JSON schema or a file that holds one");
  }, 120_000);
});

// A command whose standard input stays open: a line is written to it, and its
// output lines are read as they come.
function held(args: string[], state: string, env: Record<string, string> = {}) {
  const p = Bun.spawn([BIN, ...args], { cwd: WS, env: { ...ENV, KEEL_STATE_DIR: state, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const got: any[] = [];
  const read = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of p.stdout) {
      buf += dec.decode(c, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    }
  })();
  const err = new Response(p.stderr).text();
  return {
    got,
    write: (m: unknown) => { p.stdin.write(JSON.stringify(m) + "\n"); p.stdin.flush(); },
    // The place of the first line from `from` on that fits.
    until: async (fits: (l: any) => boolean, from = 0, ms = 30_000) => {
      for (const t0 = Date.now(); ; await Bun.sleep(25)) {
        const i = got.findIndex((l, n) => n >= from && fits(l));
        if (i >= 0) return i;
        if (Date.now() - t0 > ms) throw new Error(`no such line after ${from}:\n${got.slice(from).map((l) => JSON.stringify(l).slice(0, 300)).join("\n")}\n${await Promise.race([err, Bun.sleep(100).then(() => "")])}`);
      }
    },
    end: async () => { p.stdin.end(); await read; return { code: await p.exited, err: await err }; },
    kill: () => p.kill(),
  };
}
const said = (text: string, uuid?: string) => ({ type: "user", message: { role: "user", content: text }, ...(uuid ? { uuid } : {}) });
// A port for a daemon that must come back on the same one: nothing listens on it now, and it
// is below the range the kernel gives to outgoing connections (32768 and up), where a port
// that was free a moment ago is taken before the daemon binds it. A number drawn without a
// look fails a test on a machine that runs other services.
const freePort = () => {
  for (let i = 0; i < 100; i++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    try { Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true); return port; } catch {}
  }
  throw new Error("no port between 20000 and 32000 is free on 127.0.0.1");
};

// A daemon on one port and one state folder that is restarted in place:
// gracefully (it drains, parks its turns and starts itself again) or killed
// and started again. Every start's output is kept, and each wait is on what
// the daemon itself does (its process, its lock, what it says of its drain),
// so a start that fails says why at once and a slow one is waited for.
async function restartable(state: string) {
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...ENV, KEEL_DRAIN_MS: "300", KEEL_RESUME_AT_ONCE: "1" };
  const logs = `${state}-logs`;
  mkdirSync(logs, { recursive: true });
  let log = "", starts = 0, drained: unknown;
  // The daemon this test started last, and how it ended (a graceful restart's successor is no child of the test).
  let child: { pid: number; code: number | null } | undefined;
  const exists = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const lockPid = () => { try { return JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")).pid as number; } catch { return undefined; } };
  const status = async () => (await (await fetch(`${url}/api/daemon`, { signal: AbortSignal.timeout(5000) })).json()) as { pid: number; draining: unknown; restart_failed: { error: string } | null };
  const listens = () => Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, error() {} } }).then((c) => (c.end(), true), () => false);
  const known = () => {
    let tail = "";
    try { tail = readFileSync(log, "utf8").trim().split("\n").slice(-12).join("\n"); } catch {}
    return `${drained === undefined ? "" : `\nthe drain's answer: ${JSON.stringify(drained)}`}\nthe lock names pid ${lockPid() ?? "none"}${child ? `; the daemon this test started (pid ${child.pid}) ${child.code === null ? "runs" : `exited ${child.code}`}` : ""}\nthe daemon's output (${log}):\n${tail || "(none)"}`;
  };
  // Waits for a daemon other than `old` to answer. It goes on waiting while one is on its way (the old one says it
  // drains, or a process that is to answer is there), and stops when none is: the start exited, the restart was called off.
  const up = async (old?: number) => {
    const t0 = Date.now();
    let moved = t0;
    for (;;) {
      const d = await status().catch(() => null);
      if (d && d.pid !== old) return d.pid;
      if (d && !d.draining && d.restart_failed) throw new Error(`the restart was called off: ${d.restart_failed.error}${known()}`);
      if (!old && child && child.code !== null) throw new Error(`the daemon exited ${child.code} before it answered at ${url}${known()}`);
      const lock = lockPid();
      if ((d && d.draining) || exists(old) || (child?.code === null && exists(child.pid)) || (lock !== old && exists(lock))) moved = Date.now();
      if (Date.now() - moved > 20_000) throw new Error(`no daemon came up at ${url}, and none is on its way${known()}`);
      if (Date.now() - t0 > 180_000) throw new Error(`no daemon answered at ${url} in three minutes${known()}`);
      await Bun.sleep(50);
    }
  };
  // The daemon's port is closed: its files are, so its claim on the folder is free.
  const down = async (pid: number) => {
    const t0 = Date.now();
    while (await listens()) {
      if (Date.now() - t0 > 60_000) throw new Error(`the daemon at ${url} (pid ${pid}, ${exists(pid) ? "still a process" : "no process any more"}) did not go down${known()}`);
      await Bun.sleep(25);
    }
  };
  const start = () => {
    log = join(logs, `start-${++starts}.log`);
    const fd = openSync(log, "w");
    const p = Bun.spawn([BIN, "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", WS], { cwd: WS, env, stdout: fd, stderr: fd });
    closeSync(fd);
    const mine = (child = { pid: p.pid, code: null as number | null });
    void p.exited.then((code) => (mine.code = code));
    return up();
  };
  let now = await start();
  const api = async (path: string, body?: unknown) =>
    (await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
  return {
    url, api,
    graceful: async () => { const old = now; drained = await api("/api/drain", { timeout_seconds: 1, restart: true }); now = await up(old); },
    // Started again as soon as the port is closed: the killed daemon's pid may still be there.
    killed: async () => { drained = undefined; process.kill(now, "SIGKILL"); await down(now); now = await start(); },
    stop: async () => { try { process.kill(now, "SIGTERM"); await down(now); } catch {} },
  };
}
const isResult = (l: any) => l.type === "result";

// docs/headless.md: keel run --input-format stream-json.
describe("a session a script holds open", () => {
  const state = join(SCRATCH, "state-stream");
  let dm: Awaited<ReturnType<typeof daemonAt>>;
  beforeAll(async () => { dm = await daemonAt(state); }, 30_000);
  afterAll(() => dm?.d.kill("SIGTERM"));

  test("three prompts in one session, and a permission refused because no one answers", async () => {
    const s = held(["run", "--input-format", "stream-json", "--permission-mode", "ask"], state);
    try {
      s.write(said("one", "u1"));
      let at = await s.until(isResult);
      expect(s.got[0]).toMatchObject({ type: "system", subtype: "init", schema_version: 1, model: "scripted:stand-in", permission_mode: "ask", on_ask: "deny" });
      const id = s.got[0].session_id;
      expect(s.got[at]).toMatchObject({ subtype: "success", is_error: false, result: "Scripted reply.", session_id: id, num_turns: 1, user_message_uuids: ["u1"] });
      expect(s.got[at].total_cost_usd).toBeGreaterThan(0);
      for (const [n, text] of [[2, "two"], [3, "three"]] as const) {
        s.write(said(text));
        at = await s.until(isResult, at + 1);
        expect(s.got[at]).toMatchObject({ subtype: "success", result: "Scripted reply.", session_id: id, num_turns: n });
      }
      // The three prompts are three turns of one session, in the order written.
      expect(s.got.filter((l) => l.type === "user" && l.message.content[0].type === "text").map((l) => l.message.content[0].text)).toEqual(["one", "two", "three"]);

      // The mode asks before this command and no one answers here: the call is
      // refused, the stream says so, and the turn goes on without it.
      s.write(said('script:calls [{"name":"Bash","input":{"command":"touch stream-refused.txt"}}]'));
      const denied = await s.until((l) => l.type === "system" && l.subtype === "permission_denied", at + 1);
      expect(s.got[denied]).toMatchObject({ tool_name: "Bash", session_id: id });
      at = await s.until(isResult, at + 1);
      expect(s.got[at]).toMatchObject({ subtype: "success", refused_approvals: 1 });
      expect(s.got.slice(denied, at).some((l) => l.type === "user" && l.message.content[0]?.type === "tool_result" && l.message.content[0].is_error)).toBe(true);
      expect(existsSync(join(WS, "stream-refused.txt"))).toBe(false);

      // What the session may do without asking is not widened over the stream, and a line that is no message is said back.
      s.write({ type: "control_request", request_id: "r2", request: { subtype: "set_permission_mode", mode: "full-auto" } });
      const no = await s.until((l) => l.type === "control_response" && l.response.request_id === "r2", at + 1);
      expect(s.got[no].response).toMatchObject({ subtype: "error", error: expect.stringContaining("--permission-mode") });
      expect((await dm.api(`/api/sessions/${id}/permissions`)).perm.mode).toBe("ask");
      s.write("not a message");
      await s.until((l) => l.type === "system" && l.subtype === "input_error", at + 1);

      const end = await s.end();
      expect([end.code, s.got.filter(isResult).length]).toEqual([0, 4]);
    } finally {
      s.kill();
    }
  }, 120_000);

  test("the script answers and interrupts: a call allowed once, one refused with its words, a question, a turn stopped, a request refused when its input closes", async () => {
    // Through an address that records every call and passes no socket: the events are read by seq alone.
    const calls = new Set<string>();
    // The first answer to a card is turned away once, as a restarting daemon does.
    let turnedAway = 0;
    const fr = front(dm.url, (method, path) => {
      calls.add(`${method} ${path}`);
      if (method === "POST" && path.includes("/approvals/") && !turnedAway++) return Response.json({ error: "Keel is restarting: answer again in a moment, when it is back" }, { status: 503 });
    });
    const s = held(["run", "--input-format", "stream-json", "--permission-mode", "ask", "--on-ask", "stdin", "--archived", "--url", fr.url], state);
    const asked = (l: any) => l.type === "control_request" && l.request.subtype === "can_use_tool";
    const answer = (request_id: string, response: unknown) => s.write({ type: "control_response", response: { subtype: "success", request_id, response } });
    try {
      s.write(said('script:calls [{"name":"Bash","input":{"command":"touch stream-allowed.txt"}},{"name":"Bash","input":{"command":"touch stream-denied.txt"}}]'));
      let q = await s.until(asked);
      expect(s.got[q].request).toMatchObject({ tool_name: "Bash", input: { command: "touch stream-allowed.txt" } });
      // An answer the daemon did not take leaves the request open: the same answer again is taken.
      answer(s.got[q].request_id, { behavior: "allow" });
      const not = await s.until((l) => l.type === "system" && l.subtype === "input_error" && l.request_id === s.got[q].request_id, q);
      expect(s.got[not].error).toContain("still open");
      expect(existsSync(join(WS, "stream-allowed.txt"))).toBe(false);
      answer(s.got[q].request_id, { behavior: "allow", updatedInput: { command: "touch stream-allowed.txt" } });
      q = await s.until(asked, q + 1);
      answer(s.got[q].request_id, { behavior: "deny", message: "not this one" });
      let at = await s.until(isResult);
      expect(s.got[at]).toMatchObject({ subtype: "success", refused_approvals: 1 });
      expect([existsSync(join(WS, "stream-allowed.txt")), existsSync(join(WS, "stream-denied.txt"))]).toEqual([true, false]);
      expect(JSON.stringify(s.got.slice(q, at).filter((l) => l.type === "user"))).toContain("not this one");
      expect(s.got[at].permission_denials).toEqual([{ tool_name: "Bash", tool_use_id: expect.any(String), tool_input: { command: "touch stream-denied.txt" } }]);
      // An allow that changes the call's input runs nothing: the call is refused and both are told why.
      s.write(said('script:calls [{"name":"Bash","input":{"command":"touch stream-asked.txt"}}]'));
      q = await s.until(asked, at + 1);
      answer(s.got[q].request_id, { behavior: "allow", updatedInput: { command: "touch stream-changed.txt" } });
      await s.until((l) => l.type === "system" && l.subtype === "input_error" && /updatedInput/.test(l.error), q);
      at = await s.until(isResult, at + 1);
      expect([existsSync(join(WS, "stream-asked.txt")), existsSync(join(WS, "stream-changed.txt")), s.got[at].refused_approvals]).toEqual([false, false, 1]);
      expect(JSON.stringify(s.got.slice(q, at).filter((l) => l.type === "user"))).toContain("another input");
      // A question of the model is the script's to answer too.
      s.write(said(`script:calls ${JSON.stringify([{ name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } }])}`));
      q = await s.until((l) => l.type === "control_request" && l.request.subtype === "ask_question", at + 1);
      expect(s.got[q].request.input.questions[0].question).toBe("Which color should I use?");
      answer(s.got[q].request_id, { answers: { 0: { picked: ["Amber"] } } });
      at = await s.until(isResult, at + 1);
      expect(s.got[at].result).toContain("Amber");
      // An interrupt ends the turn that runs (a command the script allowed), and the session stays open.
      // The command is long and ends in a write: a long one that only reads runs unasked, with no request to allow.
      s.write(said('script:calls [{"name":"Bash","input":{"command":"sleep 30; touch stream-slept.txt"}}]'));
      q = await s.until(asked, at + 1);
      answer(s.got[q].request_id, { behavior: "allow" });
      await Bun.sleep(300);
      s.write({ type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
      await s.until((l) => l.type === "control_response" && l.response.request_id === "r1" && l.response.subtype === "success", at + 1);
      at = await s.until(isResult, at + 1);
      expect(s.got[at]).toMatchObject({ subtype: "cancelled", outcome: "cancelled", num_turns: 4 });
      expect(existsSync(join(WS, "stream-slept.txt"))).toBe(false);
      // One stopped while its request is open: the request is withdrawn on the stream.
      s.write(said('script:calls [{"name":"Bash","input":{"command":"touch stream-never.txt"}}]'));
      q = await s.until(asked, at + 1);
      s.write({ type: "control_request", request_id: "r2", request: { subtype: "interrupt" } });
      await s.until((l) => l.type === "control_cancel_request" && l.request_id === s.got[q].request_id, q);
      at = await s.until(isResult, at + 1);
      expect(s.got[at]).toMatchObject({ subtype: "cancelled", num_turns: 5 });
      // The allow was for that one call: the same command asks again.
      s.write(said('script:calls [{"name":"Bash","input":{"command":"touch stream-allowed.txt"}}]'));
      q = await s.until(asked, at + 1);
      // Its input closes with the request open: no one can answer, so it is refused and the turn ends.
      const end = await s.end();
      const closed = s.got.findIndex((l, n) => n > q && l.type === "system" && l.subtype === "permission_denied");
      expect(s.got[closed]).toMatchObject({ request_id: s.got[q].request_id, reason: expect.stringContaining("closed") });
      expect([end.code, s.got.at(-1)]).toEqual([0, expect.objectContaining({ type: "result", subtype: "success", num_turns: 6 })]);
      expect((await dm.api(`/api/sessions/${s.got[0].session_id}?events=0`)).session.archived).toBe(true);

      // Every route the command called is one docs/http-api.md lists as stable, and the daemon serves them all.
      const table = await dm.api("/api/routes");
      expect([table.api_version, table.missing]).toEqual([1, []]);
      const stable = table.routes.flatMap((r: any) => r.stable.map((m: string) => ({ m, re: new RegExp(`^${r.path.replace(/:[a-z_]+/g, "[^/]+")}$`) })));
      expect([...calls].filter((c) => !stable.some((x: any) => c.startsWith(`${x.m} `) && x.re.test(c.split(" ")[1]!)))).toEqual([]);
      expect(calls.size).toBeGreaterThan(6);
    } finally {
      s.kill();
      fr.stop();
    }
  }, 120_000);

  test("a failed turn's result carries its own error, and the next turn's carries none of it", async () => {
    const stdin = [said("script:billing"), said("script:rate-limit-always"), said("fine now")].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const r = await keel(["run", "--input-format", "stream-json"], { state, stdin });
    const results = lines(r.out).filter(isResult);
    expect(results.map((x) => [x.subtype, x.is_error, x.num_turns])).toEqual([["error_during_execution", true, 1], ["error_during_execution", true, 2], ["success", false, 3]]);
    expect(results[0].result).toContain("HTTP 402");
    expect(results[1].result).toContain("HTTP 429");
    expect(results[1].result).not.toContain("402");
    expect([results[2].result, r.code]).toEqual(["Scripted reply.", 0]);
  }, 60_000);

  test("a daemon restart under a held session: the command waits, the cut turn goes on, and its result comes once", async () => {
    const own = join(SCRATCH, "state-stream-restart");
    const port = freePort();
    const serve = async () => {
      const d = Bun.spawn([BIN, "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", own, "--workspace", WS], { cwd: WS, env: { ...ENV, KEEL_DRAIN_MS: "300", KEEL_RESUME_AT_ONCE: "1" }, stdout: "pipe", stderr: "ignore" });
      const reader = d.stdout.getReader();
      let seen = "";
      while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
      reader.releaseLock();
      return d;
    };
    let d = await serve();
    const s = held(["run", "--input-format", "stream-json", "--permission-mode", "full-auto"], own);
    try {
      s.write(said("script:long-tool", "p1"));
      await s.until((l) => l.type === "assistant" && l.message.content.some((b: any) => b.type === "tool_use"));
      await Bun.sleep(300);
      d.kill("SIGTERM");
      await d.exited;
      // A prompt written while no daemon answers waits for it.
      s.write(said("after the restart", "p2"));
      await s.until((l) => l.type === "system" && l.subtype === "daemon_away");
      d = await serve();
      await s.until((l) => l.type === "system" && l.subtype === "daemon_back");
      const first = await s.until(isResult);
      expect(s.got[first]).toMatchObject({ subtype: "success", result: "Continued after the restart.", num_turns: 1, user_message_uuids: ["p1"] });
      const second = await s.until(isResult, first + 1);
      expect(s.got[second]).toMatchObject({ subtype: "success", result: "Scripted reply.", num_turns: 2, user_message_uuids: ["p2"] });
      const end = await s.end();
      expect([end.code, s.got.filter(isResult).length]).toEqual([0, 2]);
    } finally {
      s.kill();
      d.kill("SIGTERM");
      await d.exited;
    }
  }, 120_000);

  // Whatever waits on an answer when the daemon restarts waits again after it,
  // under the same request, and the turn it is in gets one result: the one of
  // its continuation. Each kind of thing that can wait, a restart that drains
  // and one that kills, the script answering and the owner answering.
  test("a request open across a daemon restart is asked again, its answer is taken, and its turn gets one result", async () => {
    const d = await restartable(join(SCRATCH, "state-stream-cards"));
    const calls = (name: string, input: unknown) => `script:calls ${JSON.stringify([{ name, input }])}`;
    const kinds = {
      approval: { mode: "ask", list: "approvals", subtype: "can_use_tool", prompt: (tag: string) => calls("Bash", { command: `touch restart-${tag}.txt` }) },
      question: { mode: "ask", list: "questions", subtype: "ask_question", prompt: () => calls("AskUserQuestion", { questions: [{ header: "Color", question: "Which color?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] }) },
      plan: { mode: "plan", list: "plans", subtype: "approve_plan", prompt: () => calls("present_plan", { plan: "1. Read it.\n2. Change it.", title: "The plan" }) },
      secret: { mode: "ask", list: "secrets", subtype: "give_secret", prompt: (tag: string) => calls("request_secret", { name: `STREAM_${tag.toUpperCase().replace(/-/g, "_")}`, purpose: "for the restart test" }) },
    } as const;
    const seen: Record<string, unknown> = {};
    const want: Record<string, unknown> = {};
    try {
      for (const how of ["graceful", "killed"] as const) for (const onAsk of ["stdin", "wait"] as const) for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
        const k = kinds[kind], tag = `${kind}-${how}-${onAsk}`;
        const s = held(["run", "--input-format", "stream-json", "--permission-mode", k.mode, "--on-ask", onAsk, "--url", d.url], join(SCRATCH, "state-stream-cards"));
        try {
          s.write(said(k.prompt(tag), tag));
          const init = await s.until((l) => l.type === "system" && l.subtype === "init");
          const sid = s.got[init].session_id as string;
          const open = async () => { for (let i = 0; i < 600; i++) { const st = await d.api(`/api/cli/state/${sid}`).catch(() => null); if (st?.[k.list]?.length) return st[k.list][0]; await Bun.sleep(50); } throw new Error(`${tag}: nothing waits`); };
          const asked = (l: any) => l.type === "control_request" && l.request.subtype === k.subtype;
          await open();
          if (onAsk === "stdin") await s.until(asked);
          await d[how]();
          const card = await open();
          // The answer: the script's on the stream, the owner's on the daemon. A plan is the owner's to approve; a script can only decline it.
          if (onAsk === "stdin") {
            // The request as the script holds it now: asked again after a drain withdrew it, or still the first one.
            const again = async () => { for (let i = 0; i < 400; i++) { const c = s.got.findLastIndex((l) => l.type === "control_cancel_request"), r = s.got.findLastIndex(asked); if (r > c) return s.got[r]; await Bun.sleep(50); } throw new Error(`${tag}: not asked again:\n${s.got.slice(-6).map((l) => JSON.stringify(l).slice(0, 200)).join("\n")}`); };
            const req = await again();
            expect(kind === "question" ? req.request.input.questions[0].question : kind === "plan" ? req.request.plan : kind === "secret" ? req.request.name : req.request.input.command).toBeTruthy();
            const response = kind === "approval" ? { behavior: "allow" } : kind === "question" ? { answers: { 0: { picked: ["Amber"] } } } : kind === "plan" ? { behavior: "deny", message: "not yet" } : { behavior: "allow", value: "s3cret-from-the-script" };
            s.write({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } });
          } else {
            const [path, body] = kind === "approval" ? [`approvals/${card.id}`, { choice: "once" }] : kind === "question" ? [`questions/${card.call_id}`, { answers: { 0: { picked: ["Amber"] } } }]
              : kind === "plan" ? [`plan/${card.id}`, { approve: true, mode: "ask" }] : [`secrets/${card.id}`, { value: "s3cret-from-the-owner" }];
            expect(await d.api(`/api/sessions/${card.session_id}/${path}`, body)).toMatchObject({ ok: true });
          }
          const at = await s.until(isResult, 0, 60_000);
          const end = await s.end();
          const told = JSON.stringify(s.got.filter((l) => l.type === "user" && l.message.content[0]?.type === "tool_result").at(-1) ?? null);
          seen[tag] = [s.got.filter(isResult).map((l) => [l.subtype, l.user_message_uuids, l.num_turns]), end.code,
            kind === "approval" ? existsSync(join(WS, `restart-${tag}.txt`)) : kind === "question" ? told.includes("Amber") : kind === "plan" ? told.includes(onAsk === "stdin" ? "not yet" : "approved the plan") : told.includes("The owner gave STREAM_"),
            JSON.stringify(s.got).includes("s3cret-from")];
          want[tag] = [[["success", [tag], 1]], 0, true, false];
          expect(at).toBeGreaterThan(0);
        } finally {
          s.kill();
        }
      }
      expect(seen).toEqual(want);
    } finally {
      await d.stop();
    }
  }, 600_000);

  test("a prompt whose answer was lost is stored once and keeps its id; a daemon that takes no refusal, or is another one, ends the command with a result", async () => {
    // An address that lets the daemon take the second prompt and drops the connection before the answer; it is back a moment later.
    const port = freePort();
    let runs = 0, dropped = 0;
    let fr: ReturnType<typeof Bun.serve>;
    const serve = () => (fr = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 60, fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return new Response("no socket here", { status: 404 });
      const r = await fetch(dm.url + u.pathname + u.search, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
      const body = await r.arrayBuffer();
      if (req.method === "POST" && u.pathname === "/api/run" && ++runs === 2) {
        dropped++;
        const old = fr;
        setTimeout(serve, 400);
        void old.stop(true);
        await Bun.sleep(1000);
      }
      return new Response(body, { status: r.status, headers: { "content-type": "application/json" } });
    } }));
    serve();
    const s = held(["run", "--input-format", "stream-json", "--url", `http://127.0.0.1:${port}`], state);
    try {
      s.write(said("first", "a"));
      let at = await s.until(isResult);
      s.write(said("second, its answer lost", "b"));
      at = await s.until(isResult, at + 1);
      expect([dropped, s.got[at].subtype, s.got[at].user_message_uuids, s.got[at].num_turns]).toEqual([1, "success", ["b"], 2]);
      s.write(said("third", "c"));
      at = await s.until(isResult, at + 1);
      const end = await s.end();
      // Three prompts, three turns, three results, each with its id; the second is in the session once.
      expect([end.code, s.got.filter(isResult).map((l) => [l.subtype, l.user_message_uuids])]).toEqual([0, [["success", ["a"]], ["success", ["b"]], ["success", ["c"]]]]);
      const events = (await dm.api(`/api/sessions/${s.got.find((l) => l.session_id).session_id}/events`)).events as any[];
      expect(events.filter((e) => e.kind === "user").map((e) => e.data.text)).toEqual(["first", "second, its answer lost", "third"]);
    } finally {
      s.kill();
      fr!.stop(true);
    }

    // A daemon that answers and takes no refusal of a request: the command does not try for ever.
    const deaf = front(dm.url, (method, path) => (method === "POST" && path.includes("/approvals/") ? Response.json({ error: "nothing is taken here" }, { status: 500 }) : undefined));
    const t0 = Date.now();
    const r = await keel(["run", "--input-format", "stream-json", "--permission-mode", "ask", "--url", deaf.url], { state, stdin: JSON.stringify(said('script:calls [{"name":"Bash","input":{"command":"touch stream-deaf.txt"}}]', "d")) + "\n", env: { KEEL_STREAM_AWAY_MS: "1500" } });
    deaf.stop();
    const last = lines(r.out).filter(isResult).at(-1);
    expect([r.code, last.subtype, last.result, Date.now() - t0 < 20_000, existsSync(join(WS, "stream-deaf.txt"))]).toEqual([3, "error_during_execution", expect.stringContaining("took no answer to a request"), true, false]);
    await dm.api(`/api/sessions/${last.session_id}/interrupt`, {});

    // The address answers again as a daemon of another state folder: the command says so in a result and ends.
    const one = join(SCRATCH, "state-stream-one"), other = join(SCRATCH, "state-stream-other"), p2 = freePort();
    const start = async (dir: string) => {
      const d = Bun.spawn([BIN, "serve", "--bind", `127.0.0.1:${p2}`, "--state-dir", dir, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
      const reader = d.stdout.getReader();
      let text = "";
      while (!text.includes("listening")) text += new TextDecoder().decode((await reader.read()).value);
      reader.releaseLock();
      return d;
    };
    let d = await start(one);
    const h = held(["run", "--input-format", "stream-json", "--url", `http://127.0.0.1:${p2}`], one);
    try {
      h.write(said("here", "e"));
      const first = await h.until(isResult);
      d.kill("SIGKILL");
      await d.exited;
      d = await start(other);
      h.write(said("still here?", "f"));
      const gone = await h.until(isResult, first + 1);
      const end = await h.end();
      expect([end.code, h.got[gone].subtype, h.got[gone].result]).toEqual([3, "error_during_execution", expect.stringContaining("another daemon answers there now")]);
    } finally {
      h.kill();
      d.kill("SIGTERM");
      await d.exited;
    }
  }, 180_000);

  test("prompts piped in one go run one after another, with no daemon running", async () => {
    const alone = join(SCRATCH, "state-stream-alone");
    // A line that is no message comes first: the first line written says the schema version all the same.
    const picture = { type: "user", uuid: "c", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: DOT } }] } };
    const began = Date.now();
    const r = await keel(["run", "--input-format", "stream-json"], { state: alone, stdin: "junk\n" + [said("first", "a"), said("second", "b"), picture].map((m) => JSON.stringify(m)).join("\n") + "\n" });
    const ls = lines(r.out);
    const results = ls.filter(isResult);
    expect([ls[0].subtype, ls[0].schema_version, ls.find((l) => l.subtype === "init").schema_version, ls.filter((l) => "schema_version" in l).length]).toEqual(["input_error", 1, 1, 2]);
    // An image alone is a prompt, as in the workbench.
    expect([r.code, results.map((x) => [x.subtype, x.result, x.num_turns, x.user_message_uuids])]).toEqual([0, [["success", "Scripted reply.", 1, ["a"]], ["success", "Scripted reply.", 2, ["b"]], ["success", "Scripted reply.", 3, ["c"]]]]);
    // A result's time is its own turn's: together they are no longer than the command ran.
    expect(results.reduce((n, x) => n + x.duration_ms, 0)).toBeLessThan(Date.now() - began);
    expect(new Set(ls.map((l) => l.session_id).filter(Boolean)).size).toBe(1);
    // The second prompt went in after the first one's result.
    expect(ls.findIndex((l) => l.type === "user" && l.message.content[0].text === "second")).toBeGreaterThan(ls.indexOf(results[0]));
    // The flags that do not fit a held session are refused before anything is sent.
    const bad = await keel(["run", "--input-format", "stream-json", "--output-format", "json"], { state: alone, stdin: "" });
    expect([bad.code, bad.out]).toEqual([3, ""]);
    const schema = await keel(["run", "--input-format", "stream-json", "--json-schema", '{"type":"object"}'], { state: alone, stdin: "" });
    expect([schema.code, schema.out, schema.err.split("\n")[0]]).toEqual([3, "", expect.stringContaining("--json-schema does not go with --input-format stream-json")]);
    expect((await keel(["run", "--on-ask", "stdin", "hi"], { state: alone })).err).toContain("--on-ask stdin needs --input-format stream-json");
  }, 60_000);
});

describe("client commands against a running daemon", () => {
  const state = join(SCRATCH, "state-daemon");
  let daemon: Bun.Subprocess<"ignore", "pipe", "ignore">;
  const k = (args: string[], o: { stdin?: string; signalAfterMs?: number } = {}) => keel(args, { state, ...o });

  beforeAll(async () => {
    daemon = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = daemon.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
  }, 30_000);
  afterAll(() => daemon?.kill("SIGTERM"));

  test("run, approve, resume, idempotency", async () => {
    // The daemon is found from the state folder alone.
    expect(json(readFileSync(join(state, "daemon.lock"), "utf8")).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const quick = await k(["run", "--json", "hi"]);
    expect(quick.code).toBe(0);
    const id = json(quick.out).session_id;

    const again = await k(["run", "--json", "--idempotency-key", "k1", "keyed"]);
    const replay = await k(["run", "--json", "--idempotency-key", "k1", "keyed"]);
    expect(json(replay.out)).toMatchObject({ session_id: json(again.out).session_id, replayed: true });
    // The same key with another prompt is refused, and nothing is sent.
    const reused = await k(["run", "--json", "--idempotency-key", "k1", "not keyed"]);
    expect([reused.code, reused.err]).toEqual([3, expect.stringContaining("different request")]);

    // A run's result is its own turn's, also when later turns are read in the same batch.
    const own = json((await k(["run", "--json", "--idempotency-key", "q1", "first"])).out).session_id;
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    await fetch(`${url}/api/sessions/${own}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "script:refuse", mode: "queue" }) });
    expect((await k(["run", "--wait", "--json", "-r", own, "last"])).code).toBe(0);
    const mine = await k(["run", "--wait", "--json", "--idempotency-key", "q1", "first"]);
    expect([mine.code, json(mine.out)]).toEqual([0, expect.objectContaining({ replayed: true, num_turns: 1, outcome: "success", result: "Scripted reply." })]);

    // A refused run changes nothing: no new session (also on a keyed retry),
    // no new model on the session it named.
    const before = json((await k(["sessions", "--json"])).out).length;
    for (let i = 0; i < 2; i++) expect((await k(["run", "--json", "--idempotency-key", "bad", "--effort", "max", "nope"])).code).not.toBe(0);
    const bad = await k(["run", "--json", "-r", id, "-m", "scripted:stand-in-backup", "--effort", "max", "nope"]);
    expect(bad.code).not.toBe(0);
    const after = json((await k(["sessions", "--json"])).out);
    expect(after.length).toBe(before);
    expect(after.find((x: any) => x.id === id).model).toBe("scripted:stand-in");

    // A card is left open for the owner: exit 2, then keel approve answers it.
    const ask = await k(["run", "--wait", "--json", "--permission-mode", "ask", "script:write-tool"]);
    expect(ask.code).toBe(2);
    const res = json(ask.out);
    expect(res).toMatchObject({ subtype: "needs_input", outcome: "action_required", pending_approvals: 1 });
    const list = await k(["approve", res.session_id.slice(0, 18), "--list", "--json"]);
    expect(json(list.out).approvals[0]).toMatchObject({ tool: "Bash", state: "pending" });
    const deny = await k(["approve", res.session_id, "--deny", "--answer", "not now"]);
    expect(deny.code).toBe(0);
    const follow = await k(["resume", res.session_id, "-p", "then what"]);
    expect(follow.code).toBe(0);
    expect(follow.out).toBe("Scripted reply.\n");

    const shown = await k(["show", id]);
    expect(shown.out).toContain("> hi");
    expect(shown.out).toContain("Scripted reply.");
    const logs = await k(["logs", res.session_id, "--json"]);
    expect(lines(logs.out).some((l) => l.type === "user" && l.message.content[0].text === "then what")).toBe(true);
  }, 60_000);

  test("sessions, search, send with files, stop, export, models, open, import", async () => {
    const list = await k(["sessions", "--json"]);
    const all = json(list.out);
    expect(all.length).toBeGreaterThan(2);
    const ids = await k(["ls", "--ids"]);
    expect(ids.out.trim().split("\n")).toEqual(all.map((s: any) => s.id));
    const found = await k(["sessions", "then what", "--json"]);
    expect(json(found.out).length).toBeGreaterThan(0);
    // --tail 0 is none of the history; --all is the archived ones too, not instead.
    expect(json((await k(["show", all[0].id, "--json", "--tail", "0"])).out).events).toEqual([]);
    expect((await k(["logs", all[0].id, "--tail", "0"])).out).toBe("");
    const base = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const old = json((await k(["run", "--json", "to be archived"])).out).session_id;
    await fetch(`${base}/api/sessions/${old}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
    const every = json((await k(["sessions", "--all", "--json"])).out).map((s: any) => s.id);
    expect(every).toEqual(expect.arrayContaining([...all.map((s: any) => s.id), old]));
    expect(json((await k(["sessions", "--json"])).out).map((s: any) => s.id)).not.toContain(old);

    // Without an id a prompt goes to the session the owner used in the last minute.
    const toLast = await k(["send", "--json", "where does this go"]);
    expect(json(toLast.out).session_id).toBe(json(found.out)[0].id);
    const fresh = await k(["send", "--new", "--json", "new prompt", "--wait"]);
    expect(fresh.code).toBe(0);
    const sid = json(fresh.out).session_id;

    // An image waits in the draft; the next prompt carries it and empties the draft.
    const png = join(SCRATCH, "dot.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const drafted = await k(["send", sid, "--attach", png, "--json"]);
    expect(json(drafted.out).draft.attachments).toBe(1);
    const notes = join(SCRATCH, "notes.txt");
    writeFileSync(notes, "a text file\n");
    const refused = await k(["send", sid, "--attach", notes]);
    expect(refused.code).toBe(3);
    const sent = await k(["send", sid, "look at these", "--attach", notes, "--wait"]);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("Scripted reply.");
    const shown = await k(["show", sid, "--json"]);
    const prompt = json(shown.out).events.findLast((e: any) => e.kind === "user");
    expect(prompt.data.images.map((b: any) => b.type).sort()).toEqual(["attachment", "image"]);

    const stopped = await k(["stop", sid, "--json"]);
    expect(json(stopped.out)).toMatchObject({ ok: true, was_running: false });

    const exp = await k(["export", sid, "--format", "claude_code"]);
    expect(exp.code).toBe(0);
    expect(exp.out).toMatch(/^wrote ".*\.jsonl"\ndirectory ".*"\nresume "claude --resume [\w-]+"\n$/);

    const models = await k(["models", "--json"]);
    expect(json(models.out).models.map((m: any) => m.id)).toContain("scripted:stand-in");
    const byName = await k(["run", "--json", "-m", "stand-in-backup", "--new-is-not-a-flag"]);
    expect(byName.code).toBe(3);
    const picked = await k(["run", "--wait", "--json", "-m", "stand-in-backup", "who answers"]);
    expect(json(picked.out).result).toBe("The backup model took the request.");

    const opened = await k(["open", "--print-url", "--json"]);
    expect(json(opened.out).url).toContain("/s/");

    const harnesses = await k(["import", "harnesses", "--json"]);
    expect(harnesses.code).toBe(0);
    expect(json(harnesses.out).map((h: any) => h.harness).sort()).toEqual(["agy", "claude", "codex", "hermes", "keel"]);
    const badSub = await k(["import", "nope"]);
    expect(badSub.code).toBe(3);

    // keel rules: the standing rules, and how the gate would judge a sample.
    const none = await k(["rules"]);
    expect(none.code).toBe(0);
    const safe = await k(["rules", "check", "git status", "--mode", "ask", "--json"]);
    expect(json(safe.out)).toMatchObject({ decision: "allow", tool: "shell", mode: "ask" });
    const risky = await k(["rules", "check", "rm -rf build", "--mode", "ask", "--json"]);
    expect(json(risky.out).decision).toBe("ask");
    const ro = await k(["rules", "check", "notes.txt", "--tool", "edit", "--mode", "read-only"]);
    expect(ro.out).toMatch(/^deny: edit notes\.txt/);
    const badMode = await k(["rules", "check", "ls", "--mode", "yolo"]);
    expect(badMode.code).toBe(3);
  }, 60_000);

  // keel attach, typed into: an approval card refused, a question answered by
  // its choice's number and one by a text of the owner's own (each shown once,
  // the same turn going on after each), then /detach, which stops nothing.
  test("attach: a card, a question answered by number and by text, detach", async () => {
    const ask = await k(["run", "--wait", "--json", "--permission-mode", "ask", "script:write-tool"]);
    expect(ask.code).toBe(2);
    const sid = json(ask.out).session_id;
    const p = Bun.spawn([BIN, "attach", sid], { cwd: WS, env: { ...ENV, KEEL_STATE_DIR: state }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let seen = "";
    void (async () => { const dec = new TextDecoder(); for await (const c of p.stdout) seen += dec.decode(c, { stream: true }); })();
    const count = (text: string) => seen.split(text).length - 1;
    const until = async (what: string, n = 1, ms = 20_000) => {
      for (const t0 = Date.now(); count(what) < n; await Bun.sleep(50)) if (Date.now() - t0 > ms) throw new Error(`"${what}" was not printed ${n} time(s):\n${seen}`);
    };
    const type = (l: string) => { p.stdin.write(l + "\n"); p.stdin.flush(); };
    try {
      await until("?? approval: Bash");
      type("/deny not now");
      await until("-- turn ended");

      const q = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber", description: "warm" }], multiSelect: false }] } };
      type(`script:calls ${JSON.stringify([q, q])}`);
      await until("?? question (Color): Which color should I use?");
      expect(seen).toContain("   1. Teal\n   2. Amber  warm\n   (/answer N, or /answer TEXT for an answer of your own)");
      await Bun.sleep(3500); // two more reads of what is open: the question is not shown again
      expect(count("?? question")).toBe(1);
      type("/answer 2");
      // The same turn goes on: its next step asks again, and that card is a new one.
      await until("?? question (Color)", 2);
      expect(count("-- turn ended")).toBe(1);
      type("/answer plain grey");
      await until("Done with 2 calls.");
      await until("-- turn ended", 2);
      expect(count("?? question")).toBe(2);
      const { events } = await (await fetch(`${json(readFileSync(join(state, "daemon.lock"), "utf8")).url}/api/sessions/${sid}/events`)).json() as any;
      const results = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).map((r: any) => JSON.stringify(r.content));
      expect(results.at(-2)).toContain("Amber");
      expect(results.at(-1)).toContain("plain grey");

      type("/detach");
      expect(await p.exited).toBe(0);
      expect(await new Response(p.stderr).text()).toContain("-- detached; the session goes on");
      expect((await k(["show", sid])).out).toContain("Done with 2 calls.");
    } finally {
      p.kill();
    }
  }, 90_000);
});

// A daemon of its own for a group of tests, and plain calls to its API.
async function daemonAt(state: string) {
  const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
  const reader = d.stdout.getReader();
  let seen = "";
  while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url as string;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    (await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
  const idle = async (id: string) => {
    for (let i = 0; i < 300; i++) { const st = await api(`/api/cli/state/${id}`); if (!st.running && (st.queue === 0 || st.held)) return; await Bun.sleep(50); }
    throw new Error(`${id} did not come to rest`);
  };
  return { d, url, api, idle };
}

// An address in front of the daemon: every HTTP call passes `on`, which may
// answer itself or act before the daemon does. It opens no WebSocket, so a
// command that follows a session through it reads the stored events only.
function front(target: string, on: (method: string, path: string) => Promise<Response | void> | Response | void = () => {}) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/ws") return new Response("no socket here", { status: 404 });
    const own = await on(req.method, u.pathname);
    if (own) return own;
    const r = await fetch(target + u.pathname + u.search, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  } });
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
}

const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("a prompt next to other work in its session", () => {
  const state = join(SCRATCH, "state-scoped");
  let dm: Awaited<ReturnType<typeof daemonAt>>;
  const k = (args: string[], o: { stdin?: string; cwd?: string } = {}) => keel(args, { state, ...o });
  beforeAll(async () => { dm = await daemonAt(state); }, 30_000);
  afterAll(() => dm?.d.kill("SIGTERM"));

  test("send takes out of the draft exactly what it sent", async () => {
    const { api, idle, url } = dm;
    // A session at rest whose draft holds words and an image.
    const drafted = async (text: string, name: string) => {
      const sid = json((await k(["send", "--new", "--json", "start", "--wait"])).out).session_id as string;
      const put = (text: string, name: string) => api(`/api/sessions/${sid}/draft`, { text, images: [{ name, mime: "image/png", data: DOT }] });
      await put(text, name);
      const now = async () => {
        const d = await api(`/api/sessions/${sid}/draft`);
        const sent = (await api(`/api/sessions/${sid}/events`)).events.filter((e: any) => e.kind === "user").slice(1).map((e: any) => [e.data.text, e.data.images?.length ?? 0]);
        return { sent, draft: [d.text, d.attachments.map((a: any) => a.name)] };
      };
      return { sid, put, now };
    };
    const kept = { sent: [], draft: ["first words", ["one.png"]] };

    // More is written after the command read the draft and before its prompt is accepted: it stays.
    const a = await drafted("first words", "one.png");
    const late = front(url, async (method, path) => { if (method === "POST" && path.endsWith("/messages")) await a.put("later words", "two.png"); });
    const sent = await k(["send", a.sid, "and this", "--url", late.url]);
    late.stop();
    await idle(a.sid);

    // An image of the draft that cannot be read: nothing is sent, nothing is dropped.
    const b = await drafted("first words", "one.png");
    const broken = front(url, (method, path) => (method === "GET" && path.includes("/draft/files/") ? Response.json({ error: "disk error" }, { status: 500 }) : undefined));
    const unread = await k(["send", b.sid, "with the image", "--url", broken.url]);
    broken.stop();
    await idle(b.sid);

    // A prompt the daemon refuses: the draft is as it was, and the command says so.
    const c = await drafted("first words", "one.png");
    const closed = front(url, (method, path) => (method === "POST" && path.endsWith("/messages") ? Response.json({ error: "the daemon is stopping and takes no new work", draining: true }, { status: 503 }) : undefined));
    const refused = await k(["send", c.sid, "not now", "--url", closed.url]);
    closed.stop();

    expect({
      late: [sent.code, sent.err, await a.now()],
      unread: [unread.code, unread.err, await b.now()],
      refused: [refused.code, refused.err, await c.now()],
    }).toEqual({
      late: [0, "", { sent: [["first words\n\nand this", 1]], draft: ["later words", ["two.png"]] }],
      unread: [3, expect.stringContaining("one.png could not be read (HTTP 500): nothing was sent and the draft is as it was"), kept],
      refused: [3, expect.stringContaining("takes no new work: nothing was sent and the draft is as it was"), kept],
    });
  }, 60_000);

  test("a command shows the output of the prompt it sent, and no other's", async () => {
    const { api, idle, url } = dm;
    const GROW = `Growing. ${"dolor sit amet ".repeat(280)}`.trim();
    const said = async (sid: string) => (await api(`/api/sessions/${sid}/events`)).events.filter((e: any) => e.kind === "assistant").map((e: any) => e.data.blocks.map((b: any) => b.text ?? "").join(""));
    // A session whose first prompt streams its reply for a couple of seconds.
    const streaming = async () => {
      const sid = (await api("/api/sessions", { model: "scripted:stand-in", workspace: WS })).session.id as string;
      await api(`/api/sessions/${sid}/messages`, { text: "script:render" });
      return sid;
    };
    const seen: Record<string, unknown> = {};
    const partial = (out: string) => {
      const ls = lines(out);
      return {
        prompts: ls.filter((l) => l.type === "user").map((l) => l.message.content[0].text),
        replies: ls.filter((l) => l.type === "assistant").map((l) => l.message.content[0].text),
        streamed: ls.filter((l) => l.type === "stream_event").map((l) => l.event.delta.text).join(""),
        result: ls.at(-1).result,
      };
    };
    const noSocket = front(url);
    for (const [name, via] of [["socket", []], ["polling", ["--url", noSocket.url]]] as const) {
      // The first command stays for the work of its own prompt; the second's prompt runs behind it.
      const a = (await api("/api/sessions", { model: "scripted:stand-in", workspace: WS })).session.id as string;
      const first = k(["run", "-r", a, "--output-format", "json", "script:render", ...via]);
      for (let i = 0; i < 100 && !(await api(`/api/cli/state/${a}`)).running; i++) await Bun.sleep(20);
      const sent = await k(["send", a, "script:grow", "--queue", "--wait", ...via]);
      const own = json((await first).out);
      seen[`${name} send`] = [sent.code, sent.out, own.num_turns, own.result === (await said(a))[0].trim()];

      const b = await streaming();
      const run = await k(["run", "-r", b, "--queue", "--stream-json", "--include-partial-messages", "script:grow", ...via]);
      seen[`${name} run`] = [run.code, partial(run.out)];
      await idle(b);
    }
    noSocket.stop();
    // A reply already streaming when the command connects is printed once, whole.
    const direct = await k(["send", "--new", "script:render", "--wait"]);
    const whole = (await said(json((await k(["sessions", "--json", "-n", "1"])).out)[0].id))[0];
    seen.direct = [direct.code, direct.out === `${whole}\n`];

    const stream = (streamed: string) => [0, { prompts: ["script:grow"], replies: [GROW], streamed, result: GROW }];
    expect(seen).toEqual({
      "socket send": [0, `${GROW}\n`, 1, true],
      "socket run": stream(GROW),
      "polling send": [0, `${GROW}\n`, 1, true],
      "polling run": stream(GROW), // read by seq, the reply comes in one piece before its message
      direct: [0, true],
    });
  }, 90_000);

  test("a prompt queued behind a held queue is not waited for", async () => {
    const { api } = dm;
    const dir = join(SCRATCH, "held");
    mkdirSync(dir, { recursive: true });
    const sid = (await api("/api/sessions", { model: "scripted:stand-in", workspace: dir })).session.id as string;
    await api(`/api/sessions/${sid}/messages`, { text: "script:slow" });
    await api(`/api/sessions/${sid}/messages`, { text: "queued before the stop", mode: "queue" });
    // The owner's Stop: the turn is cut and the queue held, one prompt in it.
    await k(["stop", sid]);
    const sent = await k(["send", sid, "after the stop", "--queue", "--wait", "--timeout", "8"]);
    const ran = await k(["run", "-c", "-C", dir, "--queue", "--wait", "--json", "--timeout", "8", "and another"]);
    const st = await api(`/api/cli/state/${sid}`);
    const note = `the queue of ${sid} is held`;
    expect({ sent: [sent.code, sent.out, sent.err.includes(`keel send: ${note}`)], ran: [ran.code, ran.err.includes(`keel run: ${note}`), json(ran.out)], state: [st.running, st.held, st.queue] }).toEqual({
      sent: [2, "", true],
      ran: [2, true, expect.objectContaining({ subtype: "needs_input", outcome: "action_required", is_error: false, queue_held: true, session_id: sid })],
      state: [false, true, 3],
    });
    // A script that resumes the stopped session is not held by that queue: its prompt is a plain send, and gets its turn.
    const piped = await k(["run", "--input-format", "stream-json", "-r", sid, "--timeout", "20"], { stdin: JSON.stringify(said("from a script", "h1")) + "\n" });
    expect([piped.code, lines(piped.out).filter(isResult).map((l) => [l.subtype, l.user_message_uuids ?? null])[0]]).toEqual([0, ["success", ["h1"]]]);
  }, 60_000);

  test("send --wait refuses a bad --on-ask or --timeout before it does anything", async () => {
    const { api } = dm;
    const sid = (await api("/api/sessions", { model: "scripted:stand-in", workspace: WS })).session.id as string;
    await api(`/api/sessions/${sid}/draft`, { text: "kept words" });
    const now = async () => [(await api("/api/sessions")).sessions.length, (await api(`/api/sessions/${sid}/events`)).events.length, (await api(`/api/sessions/${sid}/draft`)).text];
    const before = await now();
    const got: unknown[] = [];
    for (const bad of ["--on-ask=later", "--timeout=0", "--timeout=-5", "--timeout=soon", "--timeout=Infinity"]) {
      for (const to of [[sid], ["--new"]]) {
        const r = await k(["send", ...to, "hello", "--wait", bad]);
        got.push([bad, r.code, r.out, r.err.includes(`keel send: --${bad.slice(2).split("=")[0]} is`) && r.err.includes("keel send [ID] [TEXT]")]);
      }
    }
    expect({ got, after: await now() }).toEqual({ got: got.map((g: any) => [g[0], 3, "", true]), after: before });
  }, 60_000);

  test("run refuses a bad --timeout, Infinity included, before it does anything", async () => {
    const { api } = dm;
    const before = (await api("/api/sessions")).sessions.length;
    const got: unknown[] = [];
    for (const bad of ["--timeout=0", "--timeout=-5", "--timeout=soon", "--timeout=Infinity"]) {
      const r = await k(["run", "-p", "hello", bad]);
      got.push([bad, r.code, r.out, r.err.includes("keel run: --timeout is a number of seconds above 0") && r.err.includes("keel run [PROMPT]")]);
    }
    expect({ got, after: (await api("/api/sessions")).sessions.length }).toEqual({ got: got.map((g: any) => [g[0], 3, "", true]), after: before });
  }, 60_000);
});

// A secret's value reaches the command that uses it and nothing else: not the
// job's record, its log or the routes, before or after the daemon restarts
// under a running job (the next daemon adopts it, with an empty vault).
describe("a secret in a background job across a restart", () => {
  const state = join(SCRATCH, "state-secret");
  const serve = async () => {
    const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    return { d, url: json(readFileSync(join(state, "daemon.lock"), "utf8")).url as string };
  };
  test("no value in any file of the state folder or any job route", async () => {
    let { d, url } = await serve();
    const api = async (path: string, init?: RequestInit) => (await fetch(url + path, { ...init, headers: { "content-type": "application/json" } })).json() as Promise<any>;
    const turns = async (id: string, n: number) => {
      for (let i = 0; i < 200; i++) { const s = await api(`/api/sessions/${id}`); if (!s.running && s.events.filter((e: any) => e.kind === "turn_end").length >= n) return; await Bun.sleep(100); }
      throw new Error(`turn ${n} did not end`);
    };
    const token = `ghp_${crypto.randomUUID().replace(/-/g, "")}Ab12`.slice(0, 40);
    const { session } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ model: "scripted:stand-in", workspace: WS }) });
    await api(`/api/sessions/${session.id}/permissions`, { method: "PUT", body: JSON.stringify({ mode: "full-auto" }) });
    await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: `Keep this for later: ${token}` }) });
    await turns(session.id, 1);
    const sec = (await api("/api/secrets")).secrets.find((s: any) => s.sessions.includes(session.id));
    await api(`/api/secrets/${sec.id}`, { method: "PATCH", body: JSON.stringify({ name: "CLI_SECRET" }) });
    // The command and its description name the placeholder; the command prints the value, split by a pause.
    const call = { name: "Bash", input: { command: 'test "[value of $CLI_SECRET]" = "$CLI_SECRET" && echo "same"; printf %s "${CLI_SECRET:0:9}"; sleep 2; echo "${CLI_SECRET:9}"', description: "check [value of $CLI_SECRET]", run_in_background: true } };
    await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: `script:calls ${JSON.stringify([call])}` }) });
    await turns(session.id, 2);
    d.kill("SIGTERM");
    await d.exited;
    ({ d, url } = await serve());
    try {
      let jobs: any[] = [];
      for (let i = 0; i < 100; i++) { jobs = (await api(`/api/sessions/${session.id}/jobs`)).jobs; if (jobs.length && jobs.every((j) => !j.running)) break; await Bun.sleep(100); }
      expect(jobs.length).toBe(1);
      const answers = [JSON.stringify(jobs), JSON.stringify(await api(`/api/sessions/${session.id}/terminal`)), JSON.stringify(await api(`/api/sessions/${session.id}`)),
        JSON.stringify(await api(`/api/sessions/${session.id}/jobs/${jobs[0].id}/log`)), JSON.stringify(await api(`/api/sessions/${session.id}/terminal/${jobs[0].id}/log`))];
      expect(answers[3]).toContain("same\\n[value of $CLI_SECRET]");
      expect(jobs[0].description).toBe("check [value of $CLI_SECRET]");
      for (const a of answers) expect(a).not.toContain(token);
      const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(join(p, f.name)) : f.isFile() ? [join(p, f.name)] : []));
      expect(walk(state).filter((f) => readFileSync(f).includes(token))).toEqual([]);
    } finally { d.kill("SIGTERM"); await d.exited; }
  }, 60_000);
});

// The binary makes its backups in a worker it carries as text, started from a
// folder that is not the repository; what it wrote restores with the binary.
describe("a backup made and restored by the binary", () => {
  const state = join(SCRATCH, "state-backup");
  const serve = async () => {
    const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: "/", env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    return d;
  };
  const k = (args: string[]) => keel(args, { state, cwd: "/" });
  test("keel backup, then keel restore of each kind once the daemon has stopped", async () => {
    let d = await serve();
    const ids = async () => (await k(["ls", "--ids"])).out.trim().split("\n");
    try {
      const first = json((await k(["run", "--json", "kept by the first backup"])).out).session_id;
      const made = await k(["backup"]);
      expect([made.code, made.err]).toEqual([0, ""]);
      expect(made.out).toContain("events, checked");
      const second = json((await k(["run", "--json", "kept by the second backup"])).out).session_id;
      // The second holds only what changed since the first, and says so.
      const delta = await k(["backup"]);
      expect([delta.code, delta.err]).toEqual([0, ""]);
      const later = json((await k(["run", "--json", "written after both"])).out).session_id;
      const [b2, b1] = json((await k(["backups", "--json"])).out).backups;
      expect([b1.kind, b2.kind, b2.base]).toEqual(["full", "delta", b1.name]);
      // A delta says what it was checked for: its pages, not the whole.
      expect(delta.out).toContain(`its pages checked (the changes since ${b1.name})`);
      expect(delta.out).not.toContain("events, checked");
      expect((await k(["backups"])).out).toContain(`the changes since ${b1.name}`);
      // It was asked for, so the daemon reads it back whole right after, in a process of its own (the binary again).
      let read: any;
      for (let i = 0; i < 100 && read?.checked !== "whole"; i++) {
        await Bun.sleep(100);
        read = json((await k(["backups", "--json"])).out).backups[0];
      }
      expect(read).toMatchObject({ name: b2.name, checked: "whole", newest_whole: true });
      expect((await k(["backups"])).out).toContain("(newest known whole)");
      for (const [b, want] of [[b2, [true, true, false]], [b1, [true, false, false]]] as const) {
        d.kill("SIGTERM");
        await d.exited;
        const back = await k(["restore", b.name, "--state-dir", state]);
        expect([back.code, back.err]).toEqual([0, ""]);
        d = await serve();
        const now = await ids();
        expect([now.includes(first), now.includes(second), now.includes(later)]).toEqual([...want]);
      }
    } finally { d.kill("SIGTERM"); await d.exited; }
  }, 90_000);
});
