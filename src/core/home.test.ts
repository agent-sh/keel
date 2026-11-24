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
