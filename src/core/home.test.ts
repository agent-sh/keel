// A process started with a scratch HOME reads the owner's folders from that home
// and nothing from the account's real one: a child is started as a scratch daemon
// is (a clean environment, HOME at a fixture) and asked what it would load.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

test("a process started with a scratch HOME loads agents and skill folders from it only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-home-"));
  try {
    const home = join(dir, "home"), cwd = join(dir, "work"), config = join(dir, "config");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(home, ".claude", "agents", "fixture-owner-agent.md"), "---\nname: fixture-owner-agent\ndescription: from the scratch home\n---\nDo nothing.\n");
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `
      const { definitions } = await import(${JSON.stringify(join(ROOT, "src/automation/agents.ts"))});
      const { skillRoots } = await import(${JSON.stringify(join(ROOT, "src/tools/skills.ts"))});
      const { homeDir } = await import(${JSON.stringify(join(ROOT, "src/core/paths.ts"))});
      console.log(JSON.stringify({
        home: homeDir(),
        agents: definitions(${JSON.stringify(cwd)}).filter((d: any) => d.source === "owner").map((d: any) => d.name),
        roots: skillRoots(${JSON.stringify(cwd)}).map((r: any) => r.dir),
      }));
    `);
    // No XDG_*, CODEX_HOME or CLAUDE_CONFIG_DIR: the same as a scratch daemon's clean environment.
    const run = Bun.spawnSync([process.execPath, probe], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KEEL_CONFIG_DIR: config, KEEL_STATE_DIR: join(dir, "state"), KEEL_KEYRING_SERVICE: "keel-test-empty" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    const out = JSON.parse(run.stdout.toString());
    expect(out.home).toBe(home);
    expect(out.agents).toEqual(["fixture-owner-agent"]);
    // Every skill folder outside the working directory is in the scratch home or the scratch config.
    expect(out.roots.filter((d: string) => !d.startsWith(cwd) && !d.startsWith(home) && !d.startsWith(config))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a daemon with a config folder of its own may not read the account's home, and reads its own scratch home", async () => {
  const { mayReadHome, ownerHome, ownerEnv, ownerLookup, defaultConfigDir } = await import("./paths.ts");
  const { sshHosts } = await import("../fleet/sshconfig.ts");
  const { findBin } = await import("../integrations/tacit.ts");
  const { claudeRoot } = await import("../integrations/import/claude.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-owner-home-"));
  const { webEnv, findBin: webBin } = await import("../tools/web.ts");
  const keys = ["HOME", "KEEL_CONFIG_DIR", "KEEL_ACCOUNT_HOME", "KEEL_SSH_CONFIG", "KEEL_IMPORT_CLAUDE_DIR", "MOMENTUM_BIN", "CODEX_HOME", "PATH", "KEEL_WEB_ENV", "BRAVE_API_KEY", "TACIT_BIN"];
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".ssh/config"), "Host owners-host\n");
    mkdirSync(join(home, ".claude/mcp-servers/harness-web"), { recursive: true });
    writeFileSync(join(home, ".claude/mcp-servers/harness-web/.env"), "TAVILY_API_KEY=owners-key\n");
    writeFileSync(join(home, ".local/bin/harness-websearch-cli"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.BRAVE_API_KEY = "owners-brave";
    delete process.env.KEEL_WEB_ENV;
    delete process.env.TACIT_BIN;
    writeFileSync(join(home, ".local/bin/momentum"), "#!/bin/sh\n", { mode: 0o755 });
    for (const k of ["KEEL_SSH_CONFIG", "KEEL_IMPORT_CLAUDE_DIR", "MOMENTUM_BIN"]) delete process.env[k];
    process.env.HOME = home;
    process.env.PATH = "/usr/bin:/bin";
    process.env.CODEX_HOME = join(home, "codex");
    // Not the account's home: what it reads there is its own.
    process.env.KEEL_CONFIG_DIR = join(dir, "config");
    expect(mayReadHome()).toBe(true);
    expect(sshHosts()).toEqual(["owners-host"]);
    expect(findBin("MOMENTUM_BIN", "momentum")).toBe(join(home, ".local/bin/momentum"));
    expect(webEnv().TAVILY_API_KEY).toBe("owners-key");
    expect(webBin("harness-websearch-cli")).toBe(join(home, ".local/bin/harness-websearch-cli"));
    // The account's home with a config folder of its own: none of it.
    process.env.KEEL_ACCOUNT_HOME = home;
    expect(mayReadHome()).toBe(false);
    expect(ownerHome().startsWith(join(dir, "config"))).toBe(true);
    expect(ownerEnv("CODEX_HOME")).toBeUndefined();
    // The owner's PATH is not searched for his tools; a KEEL_* setting the daemon was given is.
    expect(ownerLookup("PATH")).toBeUndefined();
    expect(ownerLookup("KEEL_CONFIG_DIR")).toBe(join(dir, "config"));
    expect(sshHosts()).toEqual([]);
    expect(findBin("MOMENTUM_BIN", "momentum")).toBeNull();
    expect(claudeRoot().startsWith(home)).toBe(false);
    // Another environment handed in (a copy of the owner's) finds none of his tools either.
    expect(findBin("MOMENTUM_BIN", "momentum", { PATH: join(home, ".local/bin"), HOME: home })).toBeNull();
    // No search key of his, no web program of his, whether the .env or the environment holds it.
    expect(webEnv()).toEqual({});
    expect(webBin("harness-websearch-cli")).toBeUndefined();
    // The one the daemon is given is used.
    process.env.KEEL_WEB_ENV = join(dir, "own.env");
    writeFileSync(join(dir, "own.env"), "TAVILY_API_KEY=its-own\n");
    expect(webEnv()).toEqual({ TAVILY_API_KEY: "its-own" });
    delete process.env.KEEL_WEB_ENV;
    // What a scratch daemon names itself is honoured.
    process.env.MOMENTUM_BIN = join(home, ".local/bin/momentum");
    expect(findBin("MOMENTUM_BIN", "momentum")).toBe(join(home, ".local/bin/momentum"));
    // The owner's own daemon (the default config folder) reads it.
    process.env.KEEL_CONFIG_DIR = defaultConfigDir();
    expect(mayReadHome()).toBe(true);
    expect(sshHosts()).toEqual(["owners-host"]);
    delete process.env.KEEL_CONFIG_DIR;
    expect(mayReadHome()).toBe(true);
  } finally {
    for (const k of keys) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
