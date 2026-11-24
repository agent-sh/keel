import { expect, test } from "./isolate.ts";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { exited, listening, sessionsFolder, specEnv } from "./own-daemon.ts";

// Feature: a daemon a spec starts reaches nothing of the owner's, whatever
// shell ran the specs. Its environment is made from nothing (specEnv in
// own-daemon.ts): no provider key, sign-in, keyring or credential helper of
// his, no tool or setup from his home (tacit, parlar, plugins, the other
// harnesses' setups and sessions), no session or job of his. What a spec runs
// from the run's own environment ({ ...process.env }) gets the defaults
// playwright.config.ts names: no tacit, no parlar, no phone, no harness setups
// from the home, no desktop notifications.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
// The owner's home as the account names it, whatever HOME the run was given.
const HOME = userInfo().homedir;
const under = (p: string, dir: string) => p === dir || !relative(dir, p).startsWith("..");
// Besides the stand-in, the two that list with no key and cannot answer.
const LISTED_WITHOUT_KEY = new Set(["scripted", "acp", "alibaba"]);

test("the run's environment names none of the owner's tools or setups", () => {
  // What a daemon would find, from the environment it would take. A program is looked for as
  // findBin (src/integrations/tacit.ts) and discoverParlar (src/integrations/voice.ts) look:
  // the variable when it is set, else PATH and ~/.local/bin.
  const env = { ...process.env };
  const found = (variable: string, name: string) => {
    const given = env[variable]?.trim();
    if (given) return existsSync(given) ? given : null;
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
    return existsSync(join(HOME, ".local/bin", name)) ? join(HOME, ".local/bin", name) : null;
  };
  expect(found("TACIT_BIN", "tacit"), "tacit found").toBeNull();
  expect(found("KEEL_PARLAR", "parlar"), "parlar found").toBeNull();
  const phone = env.KEEL_PHONE_SOCKET ?? "";
  expect(!!phone && !under(phone, join(HOME, ".hermes")), `phone socket ${phone}`).toBe(true);
  expect(env.KEEL_DESKTOP_NOTIFY).toBe("off");
  // The other harnesses' setups and sessions: read from folders under the e2e state, not the home.
  for (const k of ["KEEL_IMPORT_HOME", "KEEL_IMPORT_CLAUDE_DIR", "KEEL_IMPORT_CODEX_DIR", "KEEL_IMPORT_AGY_DIR", "KEEL_IMPORT_HERMES_DIR", "KEEL_IMPORT_OPENCODE_DIR", "KEEL_IMPORT_KEEL_DB"]) {
    expect(!!env[k] && (!under(env[k]!, HOME) || under(env[k]!, join(HOME, ".cache"))), `${k}=${env[k]}`).toBe(true);
  }
});

type Api = (path: string, body?: unknown, method?: string) => Promise<any>;

// A daemon on specEnv, its sessions in their own folder; `wrap` runs it under another program (strace).
async function start(state: string, wrap: string[] = [], more: Record<string, string | undefined> = {}) {
  mkdirSync(state, { recursive: true });
  const env = specEnv(state, more);
  const [cmd, ...args] = [...wrap, "bun", "src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", sessionsFolder(state)];
  const proc: ChildProcess = spawn(cmd!, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const { url } = await listening(proc);
  const api: Api = async (path, body, method = body === undefined ? "GET" : "POST") =>
    (await fetch(url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
  return { proc, env, api, pid: (await api("/api/daemon")).pid as number };
}
// The daemon is stopped, not what it runs under (strace stops tracing on a SIGTERM of its own and leaves the daemon running).
const stop = async (d: { proc: ChildProcess; pid: number }) => { process.kill(d.pid, "SIGTERM"); await exited(d.proc); };

// What the daemon offers once every source was read: a source never read counts as
// there until its first read, so the listings are read first.
async function settled(api: Api) {
  await api("/api/models?refresh=1");
  await expect.poll(async () => ((await api("/api/providers")).providers as { id: string; available: boolean }[])
    .filter((p) => p.available && !LISTED_WITHOUT_KEY.has(p.id)).map((p) => p.id), { timeout: 30_000 }).toEqual([]);
  const servers = async () => (await api("/api/mcp/servers")).servers as { name: string; state: string }[];
  await expect.poll(async () => (await servers()).filter((s) => s.state === "starting").map((s) => s.name), { timeout: 30_000 }).toEqual([]);
  return servers();
}

// A turn on the stand-in that runs a command; its title is the session's own model's.
async function turn(api: Api) {
  const { session } = await api("/api/sessions", { model: "scripted:stand-in" });
  await api(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
  await api(`/api/sessions/${session.id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo from-the-turn" } }])}` });
  await expect.poll(async () => ((await api(`/api/sessions/${session.id}`)).events as any[]).some((e) => e.kind === "turn_end"), { timeout: 60_000 }).toBe(true);
}

test("a spec's own daemon has only the stand-in provider and none of the owner's tools", async () => {
  test.setTimeout(120_000);
  const state = join(ROOT, `spec-env-${Date.now().toString(36)}`);
  let d: Awaited<ReturnType<typeof start>> | undefined;
  try {
    d = await start(state);
    const servers = await settled(d.api);
    const of = (n: string) => servers.find((s) => s.name === n)?.state;
    expect(of("tacit")).toBe("missing");
    expect(of("parlar")).toBe("missing");
    // Its environment is the one it was given, name for name: nothing of the shell that ran the specs.
    // (BUN_GC_TIMER_DISABLE: the daemon starts itself again with it, src/core/relaunch.ts.)
    const names = readFileSync(`/proc/${d.pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => l.slice(0, l.indexOf("=")));
    expect(names.filter((n) => !(n in d!.env) && n !== "BUN_GC_TIMER_DISABLE")).toEqual([]);
    expect(under(d.env.HOME!, `${state}-ws`)).toBe(true);
  } finally {
    if (d) await stop(d);
    for (const dir of [state, `${state}-ws`]) rmSync(dir, { recursive: true, force: true });
  }
});

// What a trace of the daemon and of every process it started shows it opened, ran and connected to.
type Seen = { call: string; target: string };
function traced(dir: string): Seen[] {
  const seen: Seen[] = [];
  for (const f of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      const m = /^(\w+)\((.*)\)\s+=\s+(-?\d+|\?)/.exec(line);
      if (!m) continue;
      const call = m[1]!, args = m[2]!;
      if (call === "connect") {
        const unix = /sun_path="([^"]+)"/.exec(args);
        const ip = /inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"/.exec(args);
        if (unix) seen.push({ call, target: unix[1]! });
        else if (ip) seen.push({ call, target: ip[1] ?? ip[2]! });
        continue;
      }
      const path = /"(\/[^"]*)"/.exec(args);
      if (path) seen.push({ call, target: path[1]! });
    }
  }
  return seen;
}

test("a spec's own daemon opens, runs and reaches nothing of the owner's", async () => {
  test.skip(spawnSync("strace", ["-V"]).status !== 0, "needs strace: the trace of what the daemon opens, runs and connects to");
  test.setTimeout(180_000);
  const state = join(ROOT, `spec-env-trace-${Date.now().toString(36)}`);
  const trace = `${state}-trace`;
  mkdirSync(trace, { recursive: true });
  let d: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // Every attempt counts, a failed one too: a look for a file this machine lacks reads it on the next.
    d = await start(state, ["strace", "-ff", "-qq", "-s", "4096", "-o", join(trace, "t"), "-e", "trace=execve,execveat,open,openat,creat,mkdir,connect"]);
    await settled(d.api);
    await turn(d.api);
    const { env } = d;
    await stop(d);
    d = undefined;
    // Under the home: only the repository (its git folder and modules too), Bun, the run's scratch
    // folder and the daemon's own folders (its state, and its home with its sessions' folder in it).
    const bun = env.PATH!.split(delimiter)[0]!;
    const git = realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
    const own = [process.cwd(), git, realpathSync("node_modules"), bun, dirname(realpathSync(join(bun, "bun"))), state, `${state}-ws`, trace, env.TMPDIR!];
    const runtime = `/run/user/${process.getuid!()}`;
    const seen = traced(trace);
    expect(seen.length, "the trace holds what the daemon did").toBeGreaterThan(100);
    const owners = seen.filter(({ call, target }) => {
      if (call === "connect" && !target.startsWith("/")) return !/^(127\.|::1$|::ffff:127\.|0\.0\.0\.0$)/.test(target);
      // (A folder above one of its own is walked through, not read.)
      return (under(target, HOME) && !own.some((dir) => under(target, dir) || under(dir, target))) || under(target, runtime);
    });
    expect([...new Set(owners.map((s) => `${s.call} ${s.target}`))].sort()).toEqual([]);
  } finally {
    if (d) await stop(d);
    for (const dir of [state, `${state}-ws`, trace]) rmSync(dir, { recursive: true, force: true });
  }
});

// A scratch daemon started from the owner's shell has the account's HOME with its own config and
// state folders. KEEL_ACCOUNT_HOME makes the spec's fixture home stand for the account's, so the
// owner's ssh hosts, supervisor report and tool on the PATH are in a home we can fill.
test("a scratch daemon on the owner's home lists none of his machines and reads no supervisor report", async () => {
  test.setTimeout(120_000);
  const state = join(ROOT, `spec-env-home-${Date.now().toString(36)}`);
  const home = `${state}-ws`;
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host owners-real-host\n  HostName 192.0.2.7\n");
  const bin = join(home, ".local/bin/momentum");
  writeFileSync(bin, '#!/bin/sh\necho \'{"sessions":[],"disk":{"used":"owners-real-report"}}\'\n');
  chmodSync(bin, 0o755);
  // His memory tool and voice tool, the bundled MCP servers a daemon finds in the home.
  for (const n of ["tacit", "parlar"]) { writeFileSync(join(home, ".local/bin", n), "#!/bin/sh\nexit 0\n"); chmodSync(join(home, ".local/bin", n), 0o755); }
  const names = async (d: Awaited<ReturnType<typeof start>>) => ((await d.api("/api/fleet/machines")).machines as { name: string }[]).map((m) => m.name);
  const fresh = { MOMENTUM_BIN: undefined, KEEL_SSH_CONFIG: undefined, TACIT_BIN: undefined, KEEL_PARLAR: undefined };
  let d: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // Control: a daemon whose home is not the account's reads its own home, so the fixtures are found.
    d = await start(state, [], fresh);
    expect(await names(d)).toContain("owners-real-host");
    expect((await d.api("/api/momentum")).available).toBe(true);
    const found = await settled(d.api);
    expect(["tacit", "parlar"].map((n) => found.find((x) => x.name === n)?.state)).not.toContain("missing");
    await stop(d);
    d = undefined;
    // The same home as the account's: none of it is read.
    d = await start(state, [], { ...fresh, KEEL_ACCOUNT_HOME: home });
    expect(await names(d)).not.toContain("owners-real-host");
    const memory = await d.api("/api/momentum");
    expect(memory).toEqual({ available: false });
    expect((await d.api("/api/integrations")).momentum.available).toBe(false);
    // And none of his MCP servers connect: the memory and voice tools are not found.
    const servers = await settled(d.api);
    expect(["tacit", "parlar"].map((n) => servers.find((x) => x.name === n)?.state)).toEqual(["missing", "missing"]);
  } finally {
    if (d) await stop(d);
    for (const dir of [state, home]) rmSync(dir, { recursive: true, force: true });
  }
});

// Bring your setup reads the other harnesses' settings from the import home. A scratch daemon on
// the owner's own home (KEEL_ACCOUNT_HOME stands for it here) may not read it, and a missing
// KEEL_IMPORT_HOME is a home with nothing in it: the plan lists nothing of his.
test("a scratch daemon on the owner's home plans nothing of his harness setups", async () => {
  test.setTimeout(120_000);
  const state = join(ROOT, `spec-env-port-${Date.now().toString(36)}`);
  const home = `${state}-ws`;
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "owners-real-claude-instructions\n");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(owners-real-rule:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "owners-real-hook" }] }] },
  }));
  writeFileSync(join(home, ".codex/AGENTS.md"), "owners-real-codex-instructions\n");
  writeFileSync(join(home, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "owners-real-codex-hook" }] }] } }));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "owners-real-server": { command: "owners-real-mcp" } } }));
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.owners-real-codex-server]\ncommand = "owners-real-codex-mcp"\n');
  // A plugin turned on in Claude Code, with a server of its own, and Codex's and Hermes's settings.
  const plugin = join(home, ".claude/plugins/owners-real-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { "owners-real-plugin-server": { command: "owners-real-plugin-mcp" } } }));
  writeFileSync(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "owners-real-plugin@m": [{ scope: "user", installPath: plugin }] } }));
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ ...settings, enabledPlugins: { "owners-real-plugin@m": true } }));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  writeFileSync(join(home, ".hermes/config.yaml"), "mcp_servers:\n  owners-real-hermes-server:\n    command: owners-real-hermes-mcp\n");
  const plan = async (d: Awaited<ReturnType<typeof start>>) => JSON.stringify(await d.api("/api/port"));
  // The variables a shell of his sets: they point into his home like the home itself does.
  const shell = { CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config"), HERMES_HOME: join(home, ".hermes") };
  let d: Awaited<ReturnType<typeof start>> | undefined;
  try {
    // Control: a daemon whose home is not the account's reads it, so the fixtures are found.
    d = await start(state, [], { ...shell, KEEL_IMPORT_HOME: undefined });
    const control = await plan(d);
    for (const word of ["owners-real-hook", "owners-real-codex-hook", "owners-real-server", "owners-real-codex-server", "owners-real-plugin-server", "owners-real-hermes-server"]) expect(control).toContain(word);
    await stop(d);
    d = undefined;
    // The same home as the account's, and an import home that is not there: nothing of it is listed.
    for (const importHome of [undefined, join(state, "no-import-home")]) {
      d = await start(state, [], { ...shell, KEEL_ACCOUNT_HOME: home, KEEL_IMPORT_HOME: importHome });
      const text = await plan(d);
      expect(text).not.toContain("owners-real");
      expect((await d.api("/api/port")).items.filter((i: { state: string }) => i.state !== "skip" && i.state !== "done")).toEqual([]);
      await stop(d);
      d = undefined;
    }
  } finally {
    if (d) await stop(d);
    for (const dir of [state, home]) rmSync(dir, { recursive: true, force: true });
  }
});
