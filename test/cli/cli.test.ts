// The command line, end to end: the compiled binary, a real daemon it starts
// (`keel serve`) or runs inside itself (`keel run` with none answering), and
// the scripted stand-in model, so every path is deterministic and free.
// Run: bun test ./test/cli   (builds the binary first)
// Each run works in a folder of its own, so two runs at once do not collide:
// KEEL_CLI_SCRATCH names it (default: one per process, removed at the end).
// KEEL_CLI_BIN runs a binary built before instead of building one.
import { Database } from "bun:sqlite";
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

  test("an installed unit is brought up to this build with the owner's own lines kept", async () => {
    // A unit an older build wrote (a restart wait of two seconds, no bound on starts), with lines its owner added.
    const home = join(SCRATCH, "service update");
    const path = join(home, "systemd/user/keel-bun.service");
    const run = (argv: string[]) => keel(argv, { state, env: { XDG_CONFIG_HOME: home } });
    // No unit: nothing to update, and nothing is written.
    const none = await run(["service", "update"]);
    expect([none.code, none.out, none.err.trim()]).toEqual([1, "", `keel: no unit at ${path}: keel service install writes one`]);
    expect(existsSync(home)).toBe(false);
    mkdirSync(join(home, "systemd/user"), { recursive: true });
    const old = (await run(["service", "install", "--print", "--exec", exec, "--bind", "127.0.0.1:47950"])).out
      .replace(/^RestartSec=.*$/m, "RestartSec=2")
      .replace(/^# Starts are not bounded[^]*?StartLimitIntervalSec=.*\n/m, "")
      .replace("[Service]\n", "[Service]\nEnvironmentFile=-%h/.config/keel/extra.env\nWorkingDirectory=%h\n")
      .replace("Description=Keel coding agent daemon (Bun)", "Description=Keel, the owner's sessions");
    expect(old).not.toMatch(/StartLimit/);
    writeFileSync(path, old);
    // A drop-in of the owner's beside it.
    mkdirSync(`${path}.d`, { recursive: true });
    writeFileSync(join(`${path}.d`, "50-memory.conf"), "[Service]\nMemorySwapMax=0\n");

    // --print shows the result and writes nothing.
    const shown = await run(["service", "update", "--print"]);
    expect(shown.code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(old);
    const updated = await run(["service", "update"]);
    expect(updated.code).toBe(0);
    expect(updated.out).toContain("RestartSec=2 is now RestartSec=100ms");
    expect(updated.out).toContain("added StartLimitIntervalSec=0");
    expect(updated.out).toContain("systemctl --user daemon-reload");
    const now = readFileSync(path, "utf8");
    expect(now).toBe(shown.out);
    // This build's lines are in, the owner's lines are as they were, and so is the command it starts.
    expect(now).toMatch(/^RestartSec=100ms$/m);
    expect(now).toMatch(/^StartLimitIntervalSec=0$/m);
    for (const kept of ["Description=Keel, the owner's sessions", "EnvironmentFile=-%h/.config/keel/extra.env", "WorkingDirectory=%h", old.split("\n").find((l) => l.startsWith("ExecStart="))!]) expect(now.split("\n")).toContain(kept);
    // The unit as it was is beside it, and the drop-in was not touched.
    expect(readFileSync(`${path}.prev`, "utf8")).toBe(old);
    expect(readFileSync(join(`${path}.d`, "50-memory.conf"), "utf8")).toBe("[Service]\nMemorySwapMax=0\n");
    // systemd reads the updated unit without a complaint about it.
    if (Bun.which("systemd-analyze")) {
      const v = Bun.spawnSync(["systemd-analyze", "--user", "verify", path], { stdout: "pipe", stderr: "pipe" });
      expect(v.stderr.toString().split("\n").filter((l) => l.includes("keel-bun.service") && !l.includes("50-memory.conf"))).toEqual([]);
    }
    // Again: nothing to do, nothing written.
    const again = await run(["service", "update"]);
    expect([again.code, again.out.trim()]).toEqual([0, `${path} is up to date with this build`]);
    expect(readFileSync(`${path}.prev`, "utf8")).toBe(old);
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

  test("the collector setting the unit gives the daemon does not reach what a session runs", async () => {
    // The unit sets it for the daemon's own runtime (the runtime reads it once, when it starts). A command of a
    // session, an MCP server or a hook that is a program of the same runtime must keep its own collector timer.
    expect(readFileSync(unitPath, "utf8")).toMatch(/^Environment=BUN_GC_TIMER_DISABLE=1$/m);
    const line = readFileSync(unitPath, "utf8").split("\n").find((l) => l.startsWith("ExecStart="))!;
    const p = Bun.spawn(execWords(line.slice("ExecStart=".length)), { cwd: SCRATCH, env: { ...ENV, KEEL_SUPERVISED: "", KEEL_DRAIN_MS: "300", BUN_GC_TIMER_DISABLE: "1" }, stdout: "pipe", stderr: "pipe" });
    try {
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of p.stdout) { out += dec.decode(chunk); if (/keel listening on \S+/.test(out)) break; }
      const url = out.match(/keel listening on (http:\/\/\S+?)\/? /)![1]!;
      const api = async (method: string, path: string, body?: unknown) => (await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
      const { session } = await api("POST", "/api/sessions", { model: "scripted:stand-in", title: "What a command gets" });
      await api("PUT", `/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" });
      await api("POST", `/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: 'echo "collector=${BUN_GC_TIMER_DISABLE:-none}"' } }])}` });
      let ended: string | undefined;
      for (let i = 0; i < 150 && !ended; i++) { await Bun.sleep(200); ended = (await api("GET", `/api/sessions/${session.id}?events=0`)).session.settings.last_end; }
      expect(ended).toBe("end_turn");
      const results = ((await api("GET", `/api/sessions/${session.id}`)).events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data));
      expect(results.length).toBe(1);
      expect(results[0]).toContain("collector=none");
    } finally {
      p.kill();
      await p.exited;
    }
  }, 60_000);

  test("two sessions with the sandbox off get port ranges of their own in what their commands run", async () => {
    const line = readFileSync(unitPath, "utf8").split("\n").find((l) => l.startsWith("ExecStart="))!;
    const p = Bun.spawn(execWords(line.slice("ExecStart=".length)), { cwd: SCRATCH, env: { ...ENV, KEEL_SUPERVISED: "", KEEL_DRAIN_MS: "300" }, stdout: "pipe", stderr: "pipe" });
    try {
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of p.stdout) { out += dec.decode(chunk); if (/keel listening on \S+/.test(out)) break; }
      const url = out.match(/keel listening on (http:\/\/\S+?)\/? /)![1]!;
      const api = async (method: string, path: string, body?: unknown) => (await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
      const echo = async (title: string) => {
        const { session } = await api("POST", "/api/sessions", { model: "scripted:stand-in", title });
        await api("PUT", `/api/sessions/${session.id}/permissions`, { mode: "full-auto", sandbox: "off" });
        const say = async () => {
          const before = ((await api("GET", `/api/sessions/${session.id}`)).events as any[]).filter((e) => e.kind === "turn_end").length;
          await api("POST", `/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: 'echo "port=$KEEL_PORT end=$KEEL_PORT_END"' } }])}` });
          let events: any[] = [];
          for (let i = 0; i < 150; i++) { await Bun.sleep(200); events = (await api("GET", `/api/sessions/${session.id}`)).events; if (events.filter((e) => e.kind === "turn_end").length > before) break; }
          return events.filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data)).at(-1)!.match(/port=(\d+) end=(\d+)/)!.slice(1).map(Number) as [number, number];
        };
        return say;
      };
      const [one, two] = [await echo("first"), await echo("second")];
      const [a, b] = [await one(), await two()];
      expect(a[1] - a[0]).toBe(9);
      expect(b[1] - b[0]).toBe(9);
      expect(a[0]).not.toBe(b[0]);
      expect(Math.abs(a[0] - b[0])).toBeGreaterThanOrEqual(10);
      expect(await one()).toEqual(a);
    } finally {
      p.kill();
      await p.exited;
    }
  }, 90_000);
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
      // Under a service manager, which starts it again a tenth of a second after it exits, the same failed start
      // waits two seconds before it exits: a daemon that cannot start is not started several times a second.
      const t0 = performance.now();
      const run = Bun.spawn([BIN, "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", WS], { cwd: WS, env: { ...ENV, KEEL_SUPERVISED: "systemd" }, stdout: "ignore", stderr: "pipe" });
      expect(await Promise.race([run.exited, Bun.sleep(20_000).then(() => "still running")])).toBe(1);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(2000);
      expect((await new Response(run.stderr).text()).trim()).toContain("could not be bound");
      // A bad argument too (it is the unit's own line that is wrong, and the unit would start it for ever).
      const t1 = performance.now();
      const bad = Bun.spawn([BIN, "serve", "--bind", "nowhere"], { cwd: WS, env: { ...ENV, KEEL_SUPERVISED: "systemd" }, stdout: "ignore", stderr: "ignore" });
      expect(await bad.exited).toBe(3);
      expect(performance.now() - t1).toBeGreaterThanOrEqual(2000);
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
      re: [0, "keel restart [--timeout SECONDS] [--no-wait] [--url URL]\n  Stops new work, lets running turns finish (default 120 s), waits up to 60 s more for the commands a turn is still waiting on, parks the rest so they continue after the start, then starts the daemon again from its binary.\n"],
      ran: [0, "draining: 0 turns running, up to 5 s\n", 'POST /api/drain {"timeout_seconds":5,"restart":true,"reason":"keel upgrade from a terminal"}'],
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
      got[`bad ${bad}`] = [r.code, asked.length, r.err.includes("--days is a number of days above 0") && r.err.includes("keel usage [--days N | --hours N]")];
    }
    // The measurements are asked for as read now: the daemon keeps a report of a long ledger and answers a page from it
    // while it reads again, and a command, which prints once, must not print the kept one as current.
    asked.length = 0;
    await k(["usage"]);
    expect(asked.filter((a) => a.startsWith("GET /api/telemetry?")).map((a) => /[?&]refresh=1(&|$)/.test(a))).toEqual([true]);
    const refused = [3, 0, true];
    // Three reads a report: the measurements, the spend by session and by agent tree, all over the same range.
    expect(got).toEqual({ none: [0, 3, 168], two: [0, 3, 48], half: [0, 3, 12], "bad soon": refused, "bad 0": refused, "bad -3": refused, "bad Infinity": refused, "bad ": refused });
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
async function restartable(state: string, more: Record<string, string> = {}) {
  const port = freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...ENV, KEEL_DRAIN_MS: "300", KEEL_RESUME_AT_ONCE: "1", ...more };
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
    // Gone when its process is: the port closes before the store's files do, and a test that opens the
    // store right after must not find the last checkpoint still writing (SQLITE_BUSY). (A process this
    // test started is gone when it exited: its pid stands until it is reaped.)
    stop: async () => { try { process.kill(now, "SIGTERM"); await down(now); const t0 = Date.now(); const alive = () => (child?.pid === now ? child.code === null : exists(now)); while (alive() && Date.now() - t0 < 60_000) await Bun.sleep(25); } catch {} },
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

  // A restart that parks a turn stops the command the turn waits on. The drain waits for such a command
  // (src/admin/drain-commands.ts), so a command of 30 s runs to its end and its turn finishes by itself.
  test("a restart waits for the command a turn runs in front: it finishes, and the turn is not cut", async () => {
    const state = join(SCRATCH, "state-drain-commands");
    const d = await restartable(state);
    try {
      const sid = (await d.api("/api/sessions", { title: "A long command" })).session.id as string;
      await d.api(`/api/sessions/${sid}/messages`, { text: "script:long-tool" });
      const events = async () => (await d.api(`/api/sessions/${sid}?page=40`)).events as { kind: string; data: any }[];
      for (let i = 0; i < 600 && !(await events()).some((e) => e.kind === "assistant"); i++) await Bun.sleep(50);
      await d.graceful();
      for (let i = 0; i < 1800 && !(await events()).some((e) => e.kind === "turn_end"); i++) await Bun.sleep(50);
      const ev = await events();
      const end = ev.filter((e) => e.kind === "turn_end").map((e) => e.data.reason);
      const results = ev.filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data));
      expect(results.some((r) => r.includes("slept"))).toBe(true);
      expect(results.some((r) => r.includes("The daemon restarted while this command ran"))).toBe(false);
      expect(end).not.toContain("restart");
      // The old daemon said what it waited for, and that nothing was cut.
      const said = readFileSync(join(`${state}-logs`, "start-1.log"), "utf8");
      expect(said).toMatch(/1 command runs in front of a turn: the restart waits up to 60 s more for it before it parks the turns\./);
      expect(said).not.toMatch(/in front of them cut/);
    } finally {
      await d.stop();
    }
  }, 180_000);

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
    await dm.api(`/api/sessions/${last.session_id}/interrupt`, { by: "owner" });

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

  test("mcp add reads the server's JSON from standard input, so a token is never an argument", async () => {
    const file = join(ENV.KEEL_CONFIG_DIR, "mcp.json");
    const token = "tok-never-on-the-command-line";
    const added = await k(["mcp", "add", "remote-one", "--json", "-"], { stdin: JSON.stringify({ type: "http", url: "https://example.invalid/mcp", headers: { Authorization: `Bearer ${token}` }, enabled: false }) });
    expect([added.code, json(added.out).servers.map((s: any) => s.name)]).toEqual([0, ["remote-one"]]);
    // Whole in the owner's file, which the daemon wrote through its own writer.
    expect(json(readFileSync(file, "utf8")).servers["remote-one"]).toEqual({ url: "https://example.invalid/mcp", headers: { Authorization: `Bearer ${token}` }, enabled: false });
    // A misspelled key is refused by name, nothing is saved, and the token is not printed.
    const typo = await k(["mcp", "add", "remote-two", "--json", "-"], { stdin: JSON.stringify({ url: "https://example.invalid/mcp", header: { Authorization: `Bearer ${token}` } }) });
    expect([typo.code, typo.err]).toEqual([3, expect.stringContaining("unknown field: header")]);
    expect(typo.err + typo.out).not.toContain(token);
    expect(Object.keys(json(readFileSync(file, "utf8")).servers)).toEqual(["remote-one"]);
    // No input, or not JSON: said, not hung.
    expect((await k(["mcp", "add", "remote-three", "--json", "-"], { stdin: "" })).err).toContain("no JSON on standard input");
    expect((await k(["mcp", "add", "remote-three", "--json", "-"], { stdin: "{nope" })).err).toContain("not JSON");
    expect((await k(["mcp", "add", "remote-three", "--json"])).code).toBe(3);
  });

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
    expect(json(harnesses.out).map((h: any) => h.harness).sort()).toEqual(["agy", "aider", "claude", "codex", "copilot", "crush", "cursor", "gemini", "goose", "grok", "hermes", "keel", "kimi", "opencode", "pi", "qwen"]);
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
      // The card is printed whole when it opens: its id, what it is, every line of its text.
      await until("?? approval ");
      await until("   (/approve or /deny)");
      expect(seen).toMatch(/\?\? approval [0-9a-f]{8}: Bash\n   \| touch scripted-write\.txt\n   \(\/approve or \/deny\)/);
      type("/deny not now");
      await until("-- turn ended");

      // A request that is read first: /approve alone answers nothing, /approve with its id allows it.
      const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
      const cards = async () => (await (await fetch(`${url}/api/sessions/${sid}/approvals?all`)).json()).approvals as any[];
      const LONG = Array.from({ length: 12 }, (_, i) => `echo row ${i + 1} >> attach-long.txt`).join("\n");
      type(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: LONG } }])}`);
      await until("   | echo row 12 >> attach-long.txt");
      const long = (await cards()).find((a) => a.state === "pending");
      await until(`   (read it, then /approve ${long.id.slice(0, 8)}; or /deny)`);
      // This attach reads a pipe: nobody was shown what it printed, so it allows no request that
      // is read first, by its id or without. keel approve --yes --seen does, on the script's word.
      type("/approve");
      type(`/approve ${long.id.slice(0, 8)}`);
      await Bun.sleep(2500);
      expect((await cards()).find((a) => a.id === long.id).state).toBe("pending");
      expect(existsSync(join(WS, "attach-long.txt"))).toBe(false);
      expect((await k(["approve", sid, "--approval", long.id.slice(0, 8), "--yes", "--seen"])).code).toBe(0);
      await until("-- turn ended", 2);
      expect((await cards()).find((a) => a.id === long.id)).toMatchObject({ state: "allowed", by: { client: "cli", seen: "whole" } });
      expect(readFileSync(join(WS, "attach-long.txt"), "utf8").trim().split("\n").length).toBe(12);

      const q = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber", description: "warm" }], multiSelect: false }] } };
      type(`script:calls ${JSON.stringify([q, q])}`);
      await until("?? question (Color): Which color should I use?");
      expect(seen).toContain("   1. Teal\n   2. Amber  warm\n   (/answer N, or /answer TEXT for an answer of your own)");
      await Bun.sleep(3500); // two more reads of what is open: the question is not shown again
      expect(count("?? question")).toBe(1);
      type("/answer 2");
      // The same turn goes on: its next step asks again, and that card is a new one.
      await until("?? question (Color)", 2);
      expect(count("-- turn ended")).toBe(2);
      type("/answer plain grey");
      await until("Done with 2 calls.");
      await until("-- turn ended", 3);
      expect(count("?? question")).toBe(2);
      const { events } = await (await fetch(`${json(readFileSync(join(state, "daemon.lock"), "utf8")).url}/api/sessions/${sid}/events`)).json() as any;
      const results = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).map((r: any) => JSON.stringify(r.content));
      expect(results.at(-2)).toContain("Amber");
      expect(results.at(-1)).toContain("plain grey");

      type("/detach");
      expect(await p.exited).toBe(0);
      const err = await new Response(p.stderr).text();
      expect(err).toContain("-- detached; the session goes on");
      expect(err.split("-- Open the request to read it first: it is 12 lines long. No terminal is attached, so nothing was answered: keel approve").length - 1).toBe(2);
      expect((await k(["show", sid])).out).toContain("Done with 2 calls.");
    } finally {
      p.kill();
    }
  }, 90_000);

  // Pairing a phone from keel attach: /pair draws a QR in the terminal and prints the link and a
  // code a person types. The code alone, in a request the phone signed, pairs a device keel devices
  // lists; unsigned it pairs nothing, and once used neither it nor the link's code pairs again.
  test("attach: /pair prints a QR, the link and a typed code that pairs a phone", async () => {
    const { createHash, generateKeyPairSync, sign } = await import("node:crypto");
    const ran = await k(["run", "--json", "hi"]);
    const sid = json(ran.out).session_id;
    const p = Bun.spawn([BIN, "attach", sid], { cwd: WS, env: { ...ENV, KEEL_STATE_DIR: state }, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    let said = "";
    void (async () => { const dec = new TextDecoder(); for await (const c of p.stderr) said += dec.decode(c, { stream: true }); })();
    const until = async (what: RegExp, ms = 20_000) => {
      for (const t0 = Date.now(); !what.test(said); await Bun.sleep(50)) if (Date.now() - t0 > ms) throw new Error(`${what} was not printed:\n${said}`);
      return said.match(what)!;
    };
    const type = (l: string) => { p.stdin.write(l + "\n"); p.stdin.flush(); };
    const key = () => {
      const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
      return { k, pub: k.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
    };
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const SERVER = "https://keel.example.test";
    const pairBy = async (body: Record<string, unknown>, signer?: ReturnType<typeof key>) => {
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (signer) Object.assign(headers, { "x-hm-ts": ts, "x-hm-sig": sign("sha256", Buffer.from(`POST\n/v1/pair\n${ts}\n${createHash("sha256").update(raw).digest("hex")}`), { key: signer.k.privateKey, dsaEncoding: "der" }).toString("base64") });
      const r = await fetch(`${url}/v1/pair`, { method: "POST", headers, body: raw });
      return { status: r.status, body: await r.json() as any };
    };
    try {
      await until(/-- attached to /);
      type(`/pair ${SERVER}`);
      const [, typed] = await until(/type the address https:\/\/keel\.example\.test and the code ([0-9A-Z]{4}-[0-9A-Z]{4})\n/);
      const link = (await until(/Pair link \(Keel app\): (keel:\/\/pair\?\S+)/))[1]!;
      expect(new URL(link).searchParams.get("u")).toBe(SERVER);
      // The QR, drawn in the terminal with half blocks.
      expect(said.split("\n").filter((l) => /^[ █▀▄]{20,}$/.test(l)).length).toBeGreaterThan(10);
      await until(/The code is good once, for 600 s\./);

      const req = key(), apr = key();
      const body = { code: typed!.toLowerCase().replace("-", " "), pub: req.pub, apub: apr.pub, device_name: "Typed phone", lock: true, server: SERVER };
      // Unsigned, the typed code pairs nothing.
      const unsigned = await pairBy(body);
      expect([unsigned.status, unsigned.body.error]).toEqual([403, expect.stringContaining("signed request")]);
      // Signed with the request key over a body naming this server, the code alone pairs.
      const paired = await pairBy(body, req);
      expect(paired.status).toBe(200);
      expect(paired.body.device_id).toMatch(/^dev_/);
      const listed = await k(["devices"]);
      expect(listed.out).toContain(`${paired.body.device_id}  "Typed phone"`);
      // Used once: another phone pairs with neither the typed code nor the link's code.
      const other = key(), other2 = key();
      expect((await pairBy({ ...body, pub: other.pub, apub: other2.pub }, other)).status).toBe(403);
      expect((await pairBy({ ...body, code: new URL(link).searchParams.get("c"), pub: other.pub, apub: other2.pub })).status).toBe(403);
      type("/detach");
      expect(await p.exited).toBe(0);
    } finally {
      p.kill();
    }
  }, 60_000);

  // The read-first rule on the command line: the request is shown before anything asks or
  // answers, --yes alone covers only what one line shows whole, and several are never answered by guess.
  test("approve: shows before it asks, --yes for one line only, --yes --seen for a request that was read", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const LONG = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1} >> approve-long.txt`).join("\n");
    const waits = async (calls: unknown[], word = "script:calls") => {
      const r = await k(["run", "--wait", "--json", "--permission-mode", "ask", `${word} ${JSON.stringify(calls)}`]);
      expect(r.code).toBe(2);
      return json(r.out).session_id as string;
    };
    const cardsOf = async (sid: string) => (await (await fetch(`${url}/api/sessions/${sid}/approvals?all`)).json()).approvals as any[];

    // A 41-line command waits. With no terminal and no word, what is open is listed and nothing is answered.
    const long = await waits([{ name: "Bash", input: { command: LONG } }]);
    const bare = await k(["approve", long]);
    expect([bare.code, bare.err]).toEqual([2, expect.stringContaining("nothing was answered")]);
    expect(bare.out).toContain("Bash, 41 lines: echo step 1 >> approve-long.txt ...  [read it first]");
    // --yes alone does not cover it: the whole request is shown, the reason said, the card left open.
    const yes = await k(["approve", long, "--yes"]);
    expect([yes.code, yes.err]).toEqual([2, expect.stringContaining("--yes does not cover this request (it is 41 lines long). Read it, then pass --yes --seen")]);
    expect(yes.out).toContain("   | echo step 1 >> approve-long.txt\n");
    expect(yes.out).toContain("   | echo step 41 >> approve-long.txt\n");
    expect((await cardsOf(long))[0]).toMatchObject({ state: "pending" });
    expect(existsSync(join(WS, "approve-long.txt"))).toBe(false);
    expect((await k(["approve", long, "--seen"])).err).toContain("--seen goes with --yes");
    // --yes --seen: the caller says it read all of it.
    const seen = await k(["approve", long, "--yes", "--seen"]);
    expect([seen.code, seen.out]).toEqual([0, expect.stringContaining("allowed (once): Bash echo step 1")]);
    expect(seen.out.indexOf("| echo step 41")).toBeLessThan(seen.out.indexOf("allowed (once)"));
    expect((await cardsOf(long))[0]).toMatchObject({ state: "allowed", choice: "once", by: { client: "cli", seen: "whole" } });

    // One line: --yes is enough, and it does not claim more than it did.
    const short = await waits([{ name: "Bash", input: { command: "echo yes > approve-short.txt" } }]);
    const quick = await k(["approve", short, "--yes"]);
    expect([quick.code, quick.out]).toEqual([0, expect.stringContaining("allowed (once): Bash echo yes > approve-short.txt")]);
    expect((await cardsOf(short))[0].by).toEqual({ client: "cli" });

    // A hidden character is written out, and the card says so; a deny is taken at once.
    const marked = await waits([{ name: "Bash", input: { command: "echo txt.r \u202e> approve-marked.txt" } }]);
    const held = await k(["approve", marked, "--yes"]);
    expect(held.code).toBe(2);
    expect(held.out).toContain("   | echo txt.r <U+202E>> approve-marked.txt");
    expect(held.out).toContain("characters that do not show as written");
    expect(held.out).not.toContain("\u202e");
    // The list says it without the character itself: spelled in text, escaped in JSON (which reads back as it was).
    const listed = await k(["approve", marked, "--list"]);
    expect([listed.out.includes("\u202e"), listed.out]).toEqual([false, expect.stringContaining("echo txt.r <U+202E>> approve-marked.txt")]);
    const listedJson = await k(["approve", marked, "--list", "--json"]);
    expect([listedJson.out.includes("\u202e"), listedJson.out]).toEqual([false, expect.stringContaining("echo txt.r \\u202e> approve-marked.txt")]);
    expect(json(listedJson.out).approvals[0].summary).toBe("echo txt.r \u202e> approve-marked.txt");
    expect((await k(["approve", marked, "--deny"])).code).toBe(0);
    expect((await cardsOf(marked))[0]).toMatchObject({ state: "denied", by: { client: "cli" } });
    // The call's result is the words a denial on the page gives: the transcript reads it as denied by the owner.
    const resultOf = async (sid: string, callId: string) => {
      for (let i = 0; i < 100; i++) {
        const { events } = await (await fetch(`${url}/api/sessions/${sid}/events`)).json() as any;
        const r = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).find((x: any) => x.tool_use_id === callId);
        if (r) return r.content;
        await Bun.sleep(100);
      }
    };
    expect(await resultOf(marked, (await cardsOf(marked))[0].call_id)).toBe("The owner denied this call. Do not retry it; take another way or ask.");

    // Several wait: none is picked by guess. They are listed, and one is named.
    const two = await waits([{ name: "Bash", input: { command: "echo a > approve-a.txt" } }, { name: "Bash", input: { command: "echo b > approve-b.txt" } }], "script:batch");
    const [first, second] = await cardsOf(two);
    for (const flags of [["--yes"], ["--deny"], []]) {
      const r = await k(["approve", two, ...flags]);
      expect([flags, r.code]).toEqual([flags, 2]);
      expect(r.out).toContain(` 1. ${first.id}  Bash: echo a > approve-a.txt`);
      expect(r.out).toContain(` 2. ${second.id}  Bash: echo b > approve-b.txt`);
      expect(r.err).toContain("name one with --approval ID");
    }
    expect((await cardsOf(two)).map((a) => a.state)).toEqual(["pending", "pending"]);
    expect((await k(["approve", two, "--approval", second.id.slice(0, 8), "--yes"])).code).toBe(0);
    expect((await cardsOf(two)).map((a) => a.state)).toEqual(["pending", "allowed"]);
    expect((await k(["approve", two, "--deny", "--answer", "not this one"])).code).toBe(0);
    expect((await cardsOf(two))[0]).toMatchObject({ state: "denied", reason: "not this one" });
    expect(await resultOf(two, first.call_id)).toBe("The owner denied this call: not this one");

    // A standing answer names the rule it stores, and settles no request that is read first:
    // the 41-line command beside the short one stays open for its own answer.
    const LONG2 = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1} >> approve-long2.txt`).join("\n");
    const pair = await waits([{ name: "Bash", input: { command: "echo s > approve-s.txt" } }, { name: "Bash", input: { command: LONG2 } }], "script:batch");
    const [small, big] = await cardsOf(pair);
    const stand = await k(["approve", pair, "--approval", small.id, "--choice", "session", "--yes"]);
    expect([stand.code, stand.out]).toEqual([0, expect.stringContaining("allowed (session: echo *): Bash echo s > approve-s.txt")]);
    expect(stand.out).toContain("   Allow echo * for this session: every later call the rule covers runs unasked.");
    await Bun.sleep(1000);
    expect((await cardsOf(pair)).map((a) => [a.state, a.choice])).toEqual([["allowed", "session"], ["pending", undefined]]);
    expect(existsSync(join(WS, "approve-long2.txt"))).toBe(false);
    // A standing answer on the held one needs the word, as an allow once does.
    const held2 = await k(["approve", pair, "--approval", big.id, "--choice", "session", "--yes"]);
    expect([held2.code, held2.err]).toEqual([2, expect.stringContaining("--yes does not cover this request (it is 41 lines long)")]);
    expect((await k(["approve", pair, "--approval", big.id, "--deny"])).code).toBe(0);
    // A request with no rule to grant says so.
    const risky = await waits([{ name: "Bash", input: { command: "sudo -n true" } }]);
    const none = await k(["approve", risky, "--choice", "always", "--yes", "--seen"]);
    expect([none.code, none.err]).toEqual([2, expect.stringContaining("this request has no rule to grant (it is high risk): answer it once, or deny it")]);
    expect((await k(["approve", risky, "--deny"])).code).toBe(0);
  }, 120_000);

  // keel attach on a terminal: a request that is read first is allowed by its id, and a standing answer names its rule.
  test("attach on a terminal: a held request by its id, and a standing answer says the rule", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const LONG = Array.from({ length: 12 }, (_, i) => `echo row ${i + 1} >> attach-tty.txt`).join("\n");
    const r = await k(["run", "--wait", "--json", "--permission-mode", "ask", `script:calls ${JSON.stringify([{ name: "Bash", input: { command: LONG } }, { name: "Bash", input: { command: "echo t > attach-t.txt" } }])}`]);
    const sid = json(r.out).session_id as string;
    const cards = async () => (await (await fetch(`${url}/api/sessions/${sid}/approvals?all`)).json()).approvals as any[];
    const long = (await cards())[0];
    let out = "";
    const steps: [string, string][] = [
      [`(read it, then /approve ${long.id.slice(0, 8)}; or /deny)`, "/approve\r"],
      ["It is printed above: /approve", `/approve ${long.id.slice(0, 8)}\r`],
      ["   | echo t > attach-t.txt", "/approve session\r"],
      ["-- allowed for this session: echo *", "/detach\r"],
    ];
    const p = Bun.spawn([BIN, "attach", sid], {
      cwd: WS, env: { ...ENV, KEEL_STATE_DIR: state, TERM: "xterm" },
      terminal: { cols: 200, rows: 50, data: (t, d) => { out += new TextDecoder().decode(d); while (steps.length && out.includes(steps[0]![0])) t.write(steps.shift()![1]); } },
    });
    const done = await Promise.race([p.exited, Bun.sleep(40_000).then(() => "late")]);
    if (done === "late") p.kill();
    expect([done, steps.map((x) => x[0]), out.includes("-- detached")]).toEqual([0, [], true]);
    const [a, b] = await cards();
    expect(a).toMatchObject({ state: "allowed", choice: "once", by: { client: "cli", seen: "whole" } });
    expect(b).toMatchObject({ state: "allowed", choice: "session", by: { client: "cli", seen: "whole" } });
  }, 90_000);

  // On a terminal: the whole request first (through the pager when it is taller than the window), then the question.
  test("approve on a terminal: the request, then y/N; anything but y leaves it open", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const LONG = Array.from({ length: 41 }, (_, i) => `echo line ${i + 1} >> approve-tty.txt`).join("\n");
    const r = await k(["run", "--wait", "--json", "--permission-mode", "ask", `script:calls ${JSON.stringify([{ name: "Bash", input: { command: LONG } }])}`]);
    const sid = json(r.out).session_id as string;
    const paged = join(SCRATCH, "pager.out");
    // The command on a terminal of 24 rows; `type` is typed once the question stands.
    const onTerminal = async (type: string) => {
      let out = "", typed = false;
      const p = Bun.spawn([BIN, "approve", sid], {
        cwd: WS, env: { ...ENV, KEEL_STATE_DIR: state, PAGER: `tee ${paged}`, TERM: "xterm" },
        terminal: { cols: 100, rows: 24, data: (t, d) => { out += new TextDecoder().decode(d); if (!typed && out.includes("[y/N]")) { typed = true; t.write(type); } } },
      });
      const code = await p.exited;
      return { code, out };
    };
    const state0 = async () => (await (await fetch(`${url}/api/sessions/${sid}/approvals?all`)).json()).approvals[0];

    // Enter alone is no: nothing is answered.
    const no = await onTerminal("\r");
    expect([no.code, (await state0()).state]).toEqual([2, "pending"]);
    expect(no.out).toContain("left open: nothing was answered");
    // The whole text went through the pager, and stood on the terminal before the question.
    expect(readFileSync(paged, "utf8")).toContain("   | echo line 41 >> approve-tty.txt");
    expect(no.out.indexOf("echo line 41 >> approve-tty.txt")).toBeGreaterThan(-1);
    expect(no.out.indexOf("echo line 41 >> approve-tty.txt")).toBeLessThan(no.out.indexOf("Allow once? [y/N]"));
    expect(no.out).toContain("(41 lines, shown in the pager)");
    // y allows it, and says the text was shown.
    const yes = await onTerminal("y\r");
    expect(yes.code).toBe(0);
    expect(await state0()).toMatchObject({ state: "allowed", by: { client: "cli", seen: "whole" } });
  }, 120_000);

  // What sessions left behind, from a terminal: a command still running, listed with its session.
  test("leftovers: a command a session left running is listed with its session, and stops from the list's route", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const { session } = await (await fetch(`${url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Left running", workspace: WS }) })).json() as any;
    const calls = [{ name: "Bash", input: { command: "sleep 120", run_in_background: true, description: "a sleep left running" } }];
    expect((await k(["run", "--wait", "--json", "--permission-mode", "full-auto", "-r", session.id, `script:calls ${JSON.stringify(calls)}`])).code).toBe(0);
    const l = await k(["leftovers"]);
    expect(l.code).toBe(0);
    expect(l.out).toMatch(/^left running \(\d+\)$/m);
    expect(l.out).toMatch(/a sleep left running {2}pid [\d,]+ {2}session "Left running"/);
    const p = (json((await k(["leftovers", "--json"])).out).processes as any[]).find((x) => x.session_id === session.id);
    expect(p).toMatchObject({ command: "a sleep left running", running: true, ports: [] });
    const r = await (await fetch(`${url}/api/leftovers/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: session.id, job_id: p.job_id }) })).json() as any;
    expect(r).toEqual({ stopped: true, left: [] });
    expect((json((await k(["leftovers", "--json"])).out).processes as any[]).some((x) => x.session_id === session.id)).toBe(false);
  });

  // The questions the page answers about one session, from a terminal: its messages with their
  // states, its failures per tool, what it cost and what a turn changed.
  test("messages, failures per tool by session, one session's cost, what a turn changed", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const run = async (text: string, title: string) => {
      const { session } = await (await fetch(`${url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, workspace: WS }) })).json() as any;
      expect((await k(["run", "--wait", "--json", "--permission-mode", "full-auto", "-r", session.id, text])).code).toBe(0);
      return session.id as string;
    };
    const receiver = await run("hello", "Inspect receiver");
    const calls = [
      { name: "Bash", input: { command: "echo one > inspect-a.txt; echo two > inspect-b.txt" } },
      { name: "Bash", input: { command: "echo 'error: build failed' >&2; exit 2" } },
      { name: "keel__session_send", input: { to: receiver, text: "the build failed" } },
    ];
    const sender = await run(`script:calls ${JSON.stringify(calls)}`, "Inspect sender");

    const m = await k(["messages", sender]);
    expect(m.code).toBe(0);
    expect(m.out).toContain('Session "Inspect sender"');
    expect(m.out).toMatch(/sent to "Inspect receiver": (delivered|handled|queued)/);
    expect(json((await k(["messages", sender, "--json"])).out).messages).toMatchObject([{ direction: "sent", other: { session_id: receiver } }]);

    const tools = await k(["usage", "--tools", "--hours", "1"]);
    expect(tools.code).toBe(0);
    expect(tools.out).toMatch(/^\s+Bash\s+\d+ calls\s+\d+ failed/m);
    expect(tools.out).toContain(`in "Inspect sender"  [session=${sender.slice(-12)}]`);

    const cost = await k(["cost", sender]);
    expect(cost.code).toBe(0);
    expect(cost.out).toMatch(/^This session cost (\$\d+\.\d{4}|not priced)\+?: session "Inspect sender"/);
    expect(cost.out).toMatch(/1 turn, \d+ requests?/);
    expect(cost.out).toContain("Where the tokens went");
    expect(cost.out).toMatch(/turn {3}1 /);

    const changed = await k(["changes", sender]);
    expect(changed.code).toBe(0);
    expect(changed.out).toMatch(/turn {3}1 .*2 files, \+2 -0/);
    const one = await k(["changes", sender, "1", "--diff"]);
    expect(one.code).toBe(0);
    expect(one.out).toMatch(/added {4} \+1 -0 {2}inspect-a\.txt/);
    expect(one.out).toContain("+one");
    expect((await k(["changes", sender, "7"])).err).toContain("turn 7 of this session changed no files");
  }, 120_000);

  // A plan that waits is a plan in the words, and the two reports of the sessions say their times in one zone: the machine's own.
  test("status --sessions and --away: a plan waits, and both read in the local zone", async () => {
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const call = async (method: string, path: string, body?: unknown) => (await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
    const { session } = await call("POST", "/api/sessions", { title: "Plan the index swap", workspace: WS });
    await call("PUT", `/api/sessions/${session.id}/permissions`, { mode: "plan" });
    await call("POST", `/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "present_plan", input: { plan: "1. Build the new index.\n2. Swap it in." } }])}` });
    let text = "";
    for (let i = 0; i < 200 && !text.includes('"Plan the index swap": a plan waits'); i++) { text = (await k(["status", "--sessions"])).out; await Bun.sleep(100); }
    expect(text).toContain('"Plan the index swap": a plan waits');
    expect(text).not.toContain('"Plan the index swap": a question waits');
    const away = (await k(["status", "--away", "--since", "1h"])).out;
    // One zone in both, the daemon's own (this process may run in another), and the time read is that zone's, to the hour.
    const zone = (t: string, re: RegExp) => t.match(re)?.[1];
    const z = zone(text, /^Sessions, read \d{4}-\d\d-\d\d \d\d:\d\d (UTC(?:[+-]\d\d:\d\d)?):/);
    expect(z).toBeTruthy();
    expect(zone(away, /^From (?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d to (?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d (UTC(?:[+-]\d\d:\d\d)?) /)).toBe(z);
    const off = z === "UTC" ? 0 : (z!.slice(3, 4) === "-" ? -1 : 1) * (Number(z!.slice(4, 6)) * 60 + Number(z!.slice(7, 9)));
    const hour = (ts: number) => new Date(ts + off * 60_000).toISOString().slice(0, 13).replace("T", " ");
    expect([hour(Date.now() - 3_600_000), hour(Date.now())]).toContain(text.slice("Sessions, read ".length, "Sessions, read ".length + 13));
  }, 60_000);

  test("audit: a session's history is whole, a bundle is streamed out and verifies alone, an edited one is refused", async () => {
    const id = json((await k(["run", "--json", "seal me"])).out).session_id;
    const whole = await k(["audit", "verify", id]);
    expect([whole.code, whole.out]).toEqual([0, expect.stringContaining("whole: session")]);
    expect(whole.out).toContain("sealed from event 1");
    const file = join(SCRATCH, "bundle.json");
    const ex = await k(["audit", "export", id, "--out", file]);
    expect(ex.code).toBe(0);
    // The bundle is checked with no daemon: a state folder nothing serves, and a file edited by hand is refused.
    const alone = await keel(["audit", "verify", "--bundle", file], { state: join(SCRATCH, "state-none") });
    expect([alone.code, alone.out]).toEqual([0, expect.stringContaining("whole: session")]);
    const edited = join(SCRATCH, "bundle-edited.json");
    writeFileSync(edited, readFileSync(file, "utf8").replace("seal me", "seal you"));
    const refused = await keel(["audit", "verify", "--bundle", edited], { state: join(SCRATCH, "state-none") });
    expect([refused.code, refused.out]).toEqual([1, expect.stringContaining("BREAK at event")]);
    expect((await k(["audit", "verify", id])).code).toBe(0);
    expect((await k(["audit", "roots"])).code).toBe(0);
  }, 60_000);
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

// A program of run_code that is still running when its call's wait ends goes on as a background job: the
// turn ends, its calls still meet the gate, its end wakes the session once with what it printed and
// returned, and a daemon that goes down in between is told as an interruption, never run again.
describe("a run_code program that outlives its wait", () => {
  const state = join(SCRATCH, "state-code-bg");
  const serve = async () => {
    const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    return { d, url: json(readFileSync(join(state, "daemon.lock"), "utf8")).url as string };
  };
  // A daemon on the scripted model, and the calls the three tests make of it. `at.url` follows a restart.
  const rig = async () => {
    const at = await serve();
    const api = async (path: string, init?: RequestInit) => (await fetch(at.url + path, { ...init, headers: { "content-type": "application/json" } })).json() as Promise<any>;
    const until = async <T>(what: string, f: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) { const v = await f(); if (v) return v; }
      throw new Error(`timed out: ${what}`);
    };
    const events = async (id: string) => (await api(`/api/sessions/${id}`)).events as any[];
    const harness = async (id: string) => (await events(id)).filter((e) => e.kind === "user" && typeof e.data?.text === "string" && e.data.text.startsWith("[harness]") && e.data.text.includes("background program"));
    const pending = async (id: string) => ((await api(`/api/sessions/${id}/approvals`)).approvals as any[])[0];
    const allow = async (id: string, what: string) => {
      const a = await until(what, () => pending(id));
      await api(`/api/sessions/${id}/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ choice: "once", seen: "whole" }) });
      return a;
    };
    const start = async (code: string) => {
      const { session } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ model: "scripted:stand-in", workspace: WS }) });
      await api(`/api/sessions/${session.id}/permissions`, { method: "PUT", body: JSON.stringify({ mode: "ask", sandbox: "off" }) });
      const call = { name: "run_code", input: { code, timeout: 1000 } };
      await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: `script:calls ${JSON.stringify([call])}` }) });
      return session.id as string;
    };
    const turns = async (id: string) => (await events(id)).filter((e) => e.kind === "turn_end").length;
    return { at, api, until, events, harness, pending, allow, start, turns };
  };

  test("the turn ends, the gate still asks, its output is in the job's log as it prints, the end wakes the session once", async () => {
    const { at, api, until, events, harness, pending, allow, start, turns } = await rig();
    try {
      const sid = await start(`console.log("started"); await Bun.sleep(2500); console.log("live-line"); await Bun.sleep(1500); await tools.Bash({ command: "echo bg > code-bg.txt", description: "write a file" }); console.log("bash done"); return "RETURNED-42";`);
      await allow(sid, "the program's own card");
      // The call returns at its wait, and the turn ends with the program still running.
      await until("the turn ends", async () => (await turns(sid)) >= 1);
      const result = JSON.stringify((await events(sid)).filter((e) => e.kind === "tool_result"));
      expect(result).toContain("went on in the background with ID");
      expect(result).toContain("started");
      const job = (await api(`/api/sessions/${sid}/jobs`)).jobs.find((j: any) => j.command.startsWith("run_code:"));
      expect(job).toMatchObject({ running: true, background: true });
      // What it prints reaches the job's log while it runs, and what its call returned is not written again.
      const log = async () => String((await api(`/api/sessions/${sid}/jobs/${job.id}/log`)).tail);
      await until("the live line in the log", async () => (await log()).includes("live-line"));
      expect((await api(`/api/sessions/${sid}/jobs`)).jobs.find((j: any) => j.id === job.id).running).toBe(true);
      expect(await log()).not.toContain("started");
      // What it does after that meets the same gate: its Bash call waits for the owner, with no turn running.
      const inner = await until("the program's Bash call asks", () => pending(sid));
      expect(JSON.stringify(inner)).toContain("code-bg.txt");
      expect(existsSync(join(WS, "code-bg.txt"))).toBe(false);
      await api(`/api/sessions/${sid}/approvals/${inner.id}`, { method: "POST", body: JSON.stringify({ choice: "once", seen: "whole" }) });
      // Its end wakes the session once, with its value and what it printed since.
      const wake = await until("the wake", async () => { const h = await harness(sid); return h.length ? h : undefined; });
      await until("the woken turn ends", async () => (await turns(sid)) >= 2);
      expect(wake.length).toBe(1);
      expect(wake[0].data.text).toContain("RETURNED-42");
      expect(wake[0].data.text).toContain("bash done");
      expect(wake[0].data.text).toContain("live-line");
      expect(wake[0].data.text).toContain("exited with code 0");
      expect(wake[0].data.text.split("What it printed since")[1]).not.toContain("started");
      expect(existsSync(join(WS, "code-bg.txt"))).toBe(true);
      expect((await harness(sid)).length).toBe(1);
      // Each line is in the log once.
      const whole = await log();
      expect(whole.match(/live-line/g)).toHaveLength(1);
      expect(whole.match(/bash done/g)).toHaveLength(1);
    } finally { at.d.kill("SIGTERM"); await at.d.exited; }
  }, 120_000);

  test("it is stopped from the job list like any background job: it ends, with its stop said", async () => {
    const { at, api, until, allow, start, turns } = await rig();
    try {
      const sid = await start(`await Bun.sleep(120000); return "never";`);
      await allow(sid, "the program's own card");
      await until("the turn ends", async () => (await turns(sid)) >= 1);
      const running = (await api(`/api/sessions/${sid}/jobs`)).jobs.find((j: any) => j.running);
      const stopped = await api(`/api/sessions/${sid}/jobs/${running.id}/stop`, { method: "POST" });
      expect(stopped.job).toMatchObject({ running: false, stop_reason: "was stopped by the owner" });
    } finally { at.d.kill("SIGTERM"); await at.d.exited; }
  }, 60_000);

  test("a restart while it runs tells it once as interrupted, and does not run it again", async () => {
    const r = await rig();
    try {
      const ran = join(WS, "code-ran.txt");
      const sid = await r.start(`require("node:fs").appendFileSync(${JSON.stringify(ran)}, "x"); await Bun.sleep(120000); return "never";`);
      await r.allow(sid, "the program's own card");
      await r.until("the turn ends", async () => (await r.turns(sid)) >= 1);
      r.at.d.kill("SIGTERM");
      await r.at.d.exited;
      Object.assign(r.at, await serve());
      const told = await r.until("the interruption", async () => { const h = await r.harness(sid); return h.length ? h : undefined; }, 30_000);
      expect(told[0].data.text).toContain("interrupted");
      await Bun.sleep(1500);
      expect((await r.harness(sid)).length).toBe(1);
      expect(readFileSync(ran, "utf8")).toBe("x");
      expect((await r.api(`/api/sessions/${sid}/jobs`)).jobs.some((j: any) => j.running)).toBe(false);
    } finally { r.at.d.kill("SIGTERM"); await r.at.d.exited; }
  }, 120_000);
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

// A session that is not in memory is brought in off the loop before anyone
// reads it. Read whole where the loop waits, a session of tens of thousands
// of events held every other session for seconds on a busy disk (a
// coordinator its agents report to, with nobody at its page: given back
// after its idle time, or cold after a restart). The daemon counts each
// whole-session read made on the loop, with who asked: under what a daemon
// does all day, the count stays at zero.
describe("a session out of memory is never read whole on the loop", () => {
  test("agents report into a coordinator nobody reads, views and pages read it, the daemon restarts: no such read", async () => {
    // (A session's rows are given back after a second and a half unread here, not an hour.)
    const d = await restartable(join(SCRATCH, "state-cold-reads"), { KEEL_EVENTS_IDLE_MS: "50" });
    const cold = async () => (await d.api("/api/resources")).daemon.kept_events.cold_reads as { n: number; rows: number; by: { who: string; n: number; rows: number }[] };
    const put = (path: string, body: unknown) => fetch(d.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const idle = async (id: string) => {
      for (let i = 0; i < 600; i++) { const st = await d.api(`/api/cli/state/${id}`); if (!st.running && (st.queue === 0 || st.held)) return; await Bun.sleep(50); }
      throw new Error(`${id} did not come to rest`);
    };
    const calls = (...c: [string, unknown][]) => `script:calls ${JSON.stringify(c.map(([name, input]) => ({ name, input })))}`;
    // Each agent's command says that it runs and then waits for a file: nothing here depends on how fast the machine is.
    const gate = (name: string) => join(SCRATCH, `cold-reads-${name}`);
    const agents = (name: string, n: number) => calls(...Array.from({ length: n }, (_, k) => ["spawn_agent", { message: `Part ${k + 1}\n${calls(["Bash", { command: `touch ${gate(name)}.runs-${k}; while [ ! -e ${gate(name)} ]; do sleep 0.1; done` }])}`, isolation: "none" }] as [string, unknown]));
    const running = async (name: string, n: number) => { for (let i = 0; i < 600; i++) { if (Array.from({ length: n }, (_, k) => existsSync(`${gate(name)}.runs-${k}`)).every(Boolean)) return; await Bun.sleep(50); } throw new Error(`the agents' commands (${name}) did not start`); };
    // The sessions kept in memory (asking reads no session): at most `n` are, once the others were given back.
    const kept = async () => (await d.api("/api/resources")).daemon.kept_events.sessions as number;
    const givenBack = async (n: number) => { for (let i = 0; i < 600; i++) { if ((await kept()) <= n) return; await Bun.sleep(50); } throw new Error(`${await kept()} sessions are still kept, more than ${n}`); };
    try {
      await put("/api/permissions/settings", { default_mode: "full-auto" });
      const coordinator = (await d.api("/api/sessions", { title: "Coordinator" })).session.id as string;
      const other = (await d.api("/api/sessions", { title: "Another session" })).session.id as string;
      for (const id of [coordinator, other]) { await d.api(`/api/sessions/${id}/messages`, { text: "script:render please" }); await idle(id); }
      // What a page and the owner's other views ask, each of a session that may be out of memory.
      const views = async () => {
        const paths = [`/api/sessions/${coordinator}?page=30`, `/api/sessions/${coordinator}/agents`, `/api/sessions/${coordinator}/turns`, `/api/sessions/${coordinator}/checkpoints`,
          `/api/sessions/${coordinator}/last-call`, `/api/sessions/${coordinator}/permissions`, `/api/sessions/${coordinator}/branches`, `/api/sessions/${other}`, `/api/sessions/${other}/turns`,
          "/api/state", "/api/activity", "/api/activity/sessions", "/api/overview", "/api/alerts", "/api/waits", "/api/agents", "/api/stuck", "/api/search?q=render", "/api/sessions"];
        for (const p of paths) await fetch(d.url + p).then((r) => r.arrayBuffer());
      };
      // Agents work past the time their coordinator's rows are kept; nothing reads it meanwhile. Each report finds it out of memory.
      await d.api(`/api/sessions/${coordinator}/messages`, { text: agents("first", 3) });
      await running("first", 3);
      // (Only the three agents at work are kept: the coordinator's rows were given back.)
      await givenBack(3);
      writeFileSync(gate("first"), "");
      await idle(coordinator);
      expect((await d.api(`/api/sessions/${coordinator}`)).events.filter((e: any) => e.kind === "user" && /Part \d/.test(JSON.stringify(e.data))).length).toBeGreaterThanOrEqual(1);
      // Given back again, then read by every view.
      await givenBack(0);
      await views();
      const first = await cold();
      // A restart with agents at work: everything is out of memory, their cut turns go on, and their reports come in.
      await d.api(`/api/sessions/${coordinator}/messages`, { text: agents("second", 2) });
      await running("second", 2);
      await d.graceful();
      // (The start brings the sessions used lately into memory; they are given back again before the commands end.)
      for (let i = 0; i < 60 && !(await kept()); i++) await Bun.sleep(50);
      await givenBack(2);
      writeFileSync(gate("second"), "");
      await idle(coordinator);
      await views();
      // And a prompt of the owner's to a session nothing has read since the start.
      await givenBack(0);
      await d.api(`/api/sessions/${other}/messages`, { text: "script:render please" });
      await idle(other);
      // (Both daemons' counts, each with who asked: one line says where a read came from.)
      const brief = (c: Awaited<ReturnType<typeof cold>>) => ({ n: c.n, rows: c.rows, by: c.by.map((b) => `${b.n} of ${b.rows} rows: ${b.who}`) });
      expect({ before_the_restart: brief(first), after_it: brief(await cold()) }).toEqual({ before_the_restart: { n: 0, rows: 0, by: [] }, after_it: { n: 0, rows: 0, by: [] } });
    } finally {
      await d.stop();
    }
  }, 120_000);

  // A store from before the index of its events' rows (src/core/bare-index.ts): the daemon listens first
  // and builds the index with the daemon answering. Built in the open, a large store's first start was
  // down for as long as its disk took to read every event.
  test("a store without the index of its events' rows: the daemon listens, then builds it", async () => {
    const state = join(SCRATCH, "state-index-later");
    let d = await restartable(state);
    const { Database } = await import("bun:sqlite");
    try {
      const sid = (await d.api("/api/sessions", { title: "From before the index" })).session.id as string;
      await d.api(`/api/sessions/${sid}/messages`, { text: "script:render please" });
      for (let i = 0; i < 600 && (await d.api(`/api/cli/state/${sid}`)).running; i++) await Bun.sleep(50);
      await d.stop();
      // As a build before the index left it: 25,000 events more on the session's branch, and no index.
      // (A process of the stopped daemon's can still hold the write lock for a moment on a loaded machine:
      // the edit waits for it, as the daemon's own connection does, instead of failing with SQLITE_BUSY.)
      const db = new Database(join(state, "keel.db"));
      db.exec("PRAGMA busy_timeout = 30000");
      const last = db.query<{ id: string; seq: number }, [string]>("SELECT id, seq FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sid)!;
      const ins = db.query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, 'note', ?, ?)");
      db.transaction(() => {
        let prev = last.id;
        for (let i = 1; i <= 25_000; i++) { const id = Bun.randomUUIDv7(); ins.run(id, sid, last.seq + i, prev, JSON.stringify({ text: `a note ${i} ${"x".repeat(300)}` }), Date.now()); prev = id; }
        db.query("UPDATE sessions SET head = ? WHERE id = ?").run(prev, sid);
      })();
      db.exec("DROP INDEX events_bare");
      db.close();
      d = await restartable(state);
      // It answers, and the index comes: said in its log, after the line that it listens.
      const indexed = () => { const r = new Database(join(state, "keel.db"), { readonly: true }); try { return !!r.query("SELECT 1 FROM sqlite_master WHERE name = 'events_bare'").get(); } finally { r.close(); } };
      expect((await d.api("/api/sessions")).sessions.some((x: any) => x.id === sid)).toBe(true);
      for (let i = 0; i < 600 && !indexed(); i++) await Bun.sleep(50);
      expect(indexed()).toBe(true);
      const log = () => readFileSync(join(`${state}-logs`, "start-1.log"), "utf8");
      // The index exists before its line is written: the line is what is waited for (on a loaded machine it
      // came after 5 s), up to 60 s.
      for (let i = 0; i < 1200 && !log().includes("the index is built"); i++) await Bun.sleep(50);
      const said = log();
      expect(said).toMatch(/\[store\] building the index of the events' rows, once \(about \d+ events\): the daemon answers meanwhile/);
      expect(said).toMatch(/\[store\] the index is built \(\d+\.\d s reading the events, \d+\.\d s building\)/);
      expect(said.indexOf("keel listening on")).toBeGreaterThan(-1);
      expect(said.indexOf("keel listening on")).toBeLessThan(said.indexOf("building the index of the events' rows"));
      // The session is read as before, and a turn runs in it.
      const page = (await d.api(`/api/sessions/${sid}?page=5`)).events as { kind: string; seq: number }[];
      expect([page.length >= 5, page.at(-1)!.kind, page.at(-1)!.seq]).toEqual([true, "note", last.seq + 25_000]);
      await d.api(`/api/sessions/${sid}/messages`, { text: "script:render again" });
      for (let i = 0; i < 600 && (await d.api(`/api/cli/state/${sid}`)).running; i++) await Bun.sleep(50);
      expect((await d.api(`/api/sessions/${sid}?page=3`)).events.at(-1).kind).toBe("turn_end");
    } finally {
      await d.stop();
    }
  }, 120_000);

  // Every other reader of a session that may be out of memory, one at a time:
  // the phone's routes, a message from another session and where it stands, a
  // loop's run, the helper's report on a session, the judge reading what the
  // owner asked for, the whole session asked for at once, and what a start
  // reads to go on (reports owed, agents at work, loops with a run open).
  // Each used to read the session whole on the loop.
  test("the phone, a message between sessions, a loop, the helper, the judge and a start each read a session out of memory: no such read", async () => {
    const { key, sig } = await import("../e2e/fixtures/phone-app.ts");
    const { createHash } = await import("node:crypto");
    // (A session's rows are given back after a second and a half unread here, not an hour.)
    const d = await restartable(join(SCRATCH, "state-cold-sweep"), { KEEL_EVENTS_IDLE_MS: "50", KEEL_MAIL_STANDIN: join(SCRATCH, "sweep-mail") });
    const cold = async () => (await d.api("/api/resources")).daemon.kept_events.cold_reads as { n: number; rows: number; by: { who: string; n: number; rows: number }[]; start: { n: number; rows: number; by: { who: string; n: number; rows: number }[] } };
    const send = (method: string, path: string, body?: unknown) => fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const idle = async (id: string) => {
      for (let i = 0; i < 600; i++) { const st = await d.api(`/api/cli/state/${id}`); if (!st.running && (st.queue === 0 || st.held)) return; await Bun.sleep(50); }
      throw new Error(`${id} did not come to rest`);
    };
    // Long enough for every idle session's rows to be given back.
    const out = () => Bun.sleep(2_500);
    const calls = (...c: [string, unknown][]) => `script:calls ${JSON.stringify(c.map(([name, input]) => ({ name, input })))}`;
    const made = async (title: string) => {
      const id = (await d.api("/api/sessions", { title })).session.id as string;
      await d.api(`/api/sessions/${id}/messages`, { text: calls(["Bash", { command: "echo one" }], ["Bash", { command: "echo two" }]) });
      await idle(id);
      return id;
    };
    try {
      await send("PUT", "/api/permissions/settings", { default_mode: "full-auto" });
      const coordinator = await made("Coordinator");
      const peer = await made("A peer");
      const other = await made("Another session");
      // A phone, paired as the app pairs, signing as the app signs.
      const req = key(), apr = key();
      const code = (await (await send("POST", "/api/mobile/pair", { public_url: "https://keel.example.test" })).json()).code;
      const token = (await (await send("POST", "/v1/pair", { code, pub: req.pub, apub: apr.pub, device_name: "Stand-in phone", lock: true })).json()).token as string;
      const phone = async (path: string) => {
        const ts = String(Math.floor(Date.now() / 1000));
        const r = await fetch(d.url + path, { headers: { authorization: `Bearer ${token}`, "x-hm-ts": ts, "x-hm-sig": sig(req, `GET\n${path}\n${ts}\n${createHash("sha256").update("").digest("hex")}`) } });
        expect([path, r.status]).toEqual([path, 200]);
        return r.json() as Promise<any>;
      };
      const since = (await phone("/v1/sync?since=0")).seq as number;
      // A loop in the peer, and the helper, set up while everything is still in memory.
      const loop = await (await send("POST", "/api/loops", { session_id: peer, schedule: "every day at 09:30", prompt: "script:say the loop ran" })).json();
      const helper = await (await send("PUT", "/api/helper", { on: true })).json();
      await send("PATCH", `/api/sessions/${helper.session_id}`, { model: "scripted:stand-in" });
      await send("PUT", `/api/sessions/${helper.session_id}/permissions`, { mode: "full-auto" });

      // 1. The phone: a page of a chat, its last turn's steps and its usage, each of a session out of memory.
      await out();
      expect((await phone(`/v1/chats/${coordinator}/messages?paged=1&limit=20`)).messages.length).toBeGreaterThan(0);
      expect((await phone(`/v1/chats/${peer}/run`)).steps.length).toBe(2);
      expect((await phone(`/v1/chats/${other}/usage`)).turn).toBeDefined();
      // 2. The whole session at once, and the phone catching up from a cursor.
      await out();
      expect((await d.api(`/api/sessions/${coordinator}`)).events.length).toBeGreaterThan(5);
      await phone(`/v1/sync?since=${since}`);
      // 3. A message from the coordinator to a session out of memory: the count of turns others started
      // there is read as it arrives, and where the message stands is asked once it was handled.
      await out();
      await d.api(`/api/sessions/${coordinator}/messages`, { text: calls(["keel__session_send", { to: other, text: "Status from the coordinator. script:say Noted." }]) });
      await idle(coordinator);
      await idle(other);
      const message = (await d.api(`/api/fleet/messages?session_id=${other}`)).messages[0];
      // (Its turn has ended by now: the store says so itself, and an older store's row still says delivered.)
      expect(["delivered", "handled"]).toContain(message?.state);
      await out();
      expect((await d.api(`/api/fleet/messages/${message.id}/disposition`)).handled).toBe(true);
      // 4. A loop's run asked for in a session out of memory: how its last turn stands is read first.
      expect((await send("POST", `/api/loops/${loop.id}/run`)).status).toBe(200);
      await idle(peer);
      // 5. The helper reads a session out of memory.
      await out();
      await d.api(`/api/sessions/${helper.session_id}/messages`, { text: calls(["helper__session_read", { session: coordinator }]) });
      await idle(helper.session_id);
      expect(JSON.stringify((await d.api(`/api/sessions/${helper.session_id}`)).events.findLast((e: any) => e.kind === "tool_result")?.data.results[0].content)).toContain("Coordinator");
      // 6. The judge: an agent's call is judged against what the owner asked its root session, which is out of memory by then.
      const judged = await made("Judged");
      await send("PUT", `/api/sessions/${judged}/permissions`, { mode: "auto", sandbox: "off" });
      await d.api(`/api/sessions/${judged}/messages`, { text: calls(["spawn_agent", { message: `Part 1\n${calls(["Bash", { command: "sleep 3" }], ["Bash", { command: "printf marker > judge-allow.txt" }])}`, isolation: "none" }]) });
      await Bun.sleep(6_000);
      await idle(judged);
      const first = await cold();
      // 7. A start with agents at work, a report owed and a loop's run open: what it reads to go on.
      await d.api(`/api/sessions/${coordinator}/messages`, { text: calls(...Array.from({ length: 2 }, (_, k) => ["spawn_agent", { message: `Part ${k + 1}\n${calls(["Bash", { command: "sleep 4" }])}`, isolation: "none" }] as [string, unknown])) });
      await send("POST", `/api/loops/${loop.id}/run`);
      await Bun.sleep(1_000);
      await d.graceful();
      await Bun.sleep(7_000);
      await idle(coordinator);
      await idle(peer);
      const brief = (c: { n: number; rows: number; by: { who: string; n: number; rows: number }[] }) => ({ n: c.n, rows: c.rows, by: c.by.map((b) => `${b.n} of ${b.rows} rows: ${b.who}`) });
      const second = await cold();
      const none = { n: 0, rows: 0, by: [] };
      expect({ while_serving: brief(first), before_the_restart_started: brief(first.start), after_the_restart: brief(second), as_it_started: brief(second.start) })
        .toEqual({ while_serving: none, before_the_restart_started: none, after_the_restart: none, as_it_started: none });
    } finally {
      await d.stop();
    }
  }, 180_000);
});

describe("keel plugin", () => {
  const state = join(SCRATCH, "state-plugin");
  const config = join(SCRATCH, "plugin-config");
  const plugin = join(SCRATCH, "plugin-src");
  let d: Bun.Subprocess<"ignore", "pipe", "ignore">;
  const k = (args: string[], o: { stdin?: string } = {}) => keel(args, { state, ...o, env: { KEEL_CONFIG_DIR: config } });
  beforeAll(async () => {
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(join(plugin, "skills", "note"), { recursive: true });
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cli-kit", version: "0.1.0" }));
    writeFileSync(join(plugin, "skills", "note", "SKILL.md"), "---\nname: note\ndescription: Take a note.\n---\nNote it.\n");
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true cli-kit-stop" }] }] } }));
    d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: { ...ENV, KEEL_CONFIG_DIR: config }, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
  }, 30_000);
  afterAll(() => d?.kill("SIGTERM"));

  test("install says what it runs and asks; list, disable, enable, update and remove", async () => {
    // No terminal and no --yes: what it runs is printed, and nothing is installed.
    const asked = await k(["plugin", "install", plugin]);
    expect(asked.code).toBe(3);
    expect(asked.out).toContain("hook on Stop: true cli-kit-stop");
    expect(asked.err).toContain("read them above, then pass --yes");
    expect((await k(["plugin", "list"])).out).toContain("no plugins installed");
    const done = await k(["plugin", "install", plugin, "--yes"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("installed cli-kit 0.1.0");
    const listed = json((await k(["plugin", "list", "--json"])).out);
    expect(listed.plugins[0]).toMatchObject({ id: "cli-kit", enabled: true, skills: ["cli-kit:note"], runs: ["hook on Stop: true cli-kit-stop"] });
    expect((await k(["plugin", "disable", "cli-kit"])).out).toContain("cli-kit is off");
    expect(json((await k(["plugin", "list", "--json"])).out).plugins[0].enabled).toBe(false);
    expect((await k(["plugin", "enable", "cli-kit"])).code).toBe(0);
    // The same source again: nothing changed, nothing to apply.
    expect((await k(["plugin", "update", "cli-kit"])).out).toContain("which is what its source holds now");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cli-kit", version: "0.2.0" }));
    const up = await k(["plugin", "update", "cli-kit"]);
    expect(up.out).toContain("version 0.1.0 to 0.2.0");
    expect(up.code).toBe(0); // what it runs did not change: the yes given at install holds
    expect(json((await k(["plugin", "list", "--json"])).out).plugins[0].version).toBe("0.2.0");
    expect((await k(["plugin", "remove", "cli-kit"])).code).toBe(0);
    expect(json((await k(["plugin", "list", "--json"])).out).plugins).toEqual([]);
    expect(existsSync(join(config, "plugins", "cli-kit"))).toBe(false);
  }, 60_000);
});

// keel new --pr: a session in a worktree at a pull request's head. The origin is a bare repository on
// this machine that holds refs/pull/7/head; the head is fetched by name with every prompt off.
describe("keel new --pr", () => {
  const state = join(SCRATCH, "state-new-pr");
  const config = join(SCRATCH, "new-pr-config");
  const root = join(SCRATCH, "new-pr");
  const repo = join(root, "repo");
  let d: Bun.Subprocess<"ignore", "pipe", "ignore">;
  const k = (args: string[], cwd = repo) => keel(args, { state, cwd, env: { KEEL_CONFIG_DIR: config } });
  const git = (cwd: string, ...a: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };
  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "clone", "-q", "origin.git", "repo");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "a");
    git(repo, "push", "-q", "origin", "HEAD:main");
    writeFileSync(join(repo, "pr.txt"), "pr\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "pr");
    git(repo, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: { ...ENV, KEEL_CONFIG_DIR: config }, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
  }, 30_000);
  afterAll(() => d?.kill("SIGTERM"));

  test("starts at the request's head by number or address, and names a fetch that fails", async () => {
    const head = git(root, "--git-dir=origin.git", "rev-parse", "refs/pull/7/head");
    const made = await k(["new", "--pr", "7", "--json"]);
    expect(made.code).toBe(0);
    const s = json(made.out);
    expect(s.branch).toMatch(/^keel\/pr-7-/);
    expect(git(s.folder, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(s.folder, "pr.txt"))).toBe(true);
    // The address names the number too (origin here is a folder: no host to compare).
    const byUrl = json((await k(["new", "--pr", "https://github.com/o/r/pull/7", "--json"])).out);
    expect(git(byUrl.folder, "rev-parse", "HEAD")).toBe(head);
    const none = await k(["new", "--pr", "8"]);
    expect(none.code).toBe(3);
    expect(none.err).toContain("could not fetch refs/pull/8/head from origin");
    const odd = await k(["new", "--pr", "main"]);
    expect(odd.code).toBe(3);
    expect(odd.err).toContain("not a pull request");
    // No --pr: a plain session, with no worktree.
    const plain = json((await k(["new", "--json"])).out);
    expect(plain.folder).toBe(repo);
    expect(plain.branch).toBeUndefined();
  }, 60_000);
});

describe("an agent started on a bug of Keel's, from the compiled binary", () => {
  const state = join(SCRATCH, "state-keel-repo");
  let dm: Awaited<ReturnType<typeof daemonAt>>;
  beforeAll(async () => { dm = await daemonAt(state); }, 30_000);
  afterAll(() => dm?.d.kill("SIGTERM"));

  test("works in the checkout the binary was built from, else in the folder the owner set", async () => {
    const { api, idle } = dm;
    const sid = json((await keel(["send", "--new", "--json", "start", "--wait"], { state })).out).session_id as string;
    await idle(sid);
    const start = (body: object) => fetch(`${dm.url}/api/debug/fix`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, repo: "keel", task: "Find it.", ...body }) });
    const where = async (r: Response) => {
      expect(r.status).toBe(201);
      const s = (await r.json()).session;
      await idle(s.id);
      return s.workspace as string;
    };
    // The binary has no sources beside it: the folder it was stamped with, this checkout.
    expect((await api("/api/helper/keel-repo")).repo).toMatchObject({ dir: ROOT, from: "build" });
    expect(await where(await start({}))).toBe(ROOT);
    // A checkout of the owner's, set once, is worked in instead.
    const mine = join(SCRATCH, "keel-checkout");
    mkdirSync(join(mine, "src/engine"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", mine]);
    writeFileSync(join(mine, "package.json"), "{}");
    writeFileSync(join(mine, "src/engine/turn.ts"), "");
    expect((await api("/api/settings", { helper: { keel_repo: mine } }, "PATCH")).settings.helper.keel_repo).toBe(mine);
    expect((await api("/api/helper/keel-repo")).repo).toMatchObject({ dir: mine, from: "setting" });
    expect(await where(await start({}))).toBe(mine);
    // A setting that is not a Keel checkout is refused to be used and the build's folder serves.
    await api("/api/settings", { helper: { keel_repo: join(SCRATCH, "nowhere") } }, "PATCH");
    expect(await where(await start({}))).toBe(ROOT);
  }, 60_000);
});
