import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Installer } from "./installer.ts";

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

// A marketplace entry whose folder was a link out of what was fetched is
// refused for that reason, in the marketplace's folder and in a repository
// the entry clones; a folder that is not there is named as missing.
test("a marketplace entry whose folder is a link out of what was fetched says so", async () => {
  const fx = mkdtempSync(join(process.env.TMPDIR ?? ".", "plugin-link-"));
  mkdirSync(join(fx, "outside", "skills", "x"), { recursive: true });
  writeFileSync(join(fx, "outside", "skills", "x", "SKILL.md"), "---\nname: x\n---\nbody\n");

  const repo = join(fx, "repo");
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(join(repo, ".claude-plugin", "plugin.json"), '{ "name": "inner", "version": "1.0.0" }');
  symlinkSync(join(fx, "outside", "skills"), join(repo, "linkskills"));
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "one");

  const market = join(fx, "market");
  mkdirSync(join(market, ".claude-plugin"), { recursive: true });
  symlinkSync(join(fx, "outside"), join(market, "linked"));
  writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mk", plugins: [
    { name: "viaLink", source: "./linked" },
    { name: "subLink", source: { source: "git-subdir", url: repo, path: "linkskills" } },
    { name: "subGone", source: { source: "git-subdir", url: repo, path: "nothere" } },
    { name: "gone", source: "./nothere" },
  ] }));

  const inst = new Installer({ mcpTaken: () => new Set(), setServers: () => {} });
  const refused = (entry: string) => inst.prepare({ input: market, entry, cwd: fx }).then(() => "", (e: Error) => e.message);
  expect(await refused("viaLink")).toBe("viaLink: its folder linked is a link that leads out of what was fetched, so it was not taken");
  expect(await refused("subLink")).toBe("subLink: its folder linkskills is a link that leads out of what was fetched, so it was not taken");
  expect(await refused("subGone")).toBe("subGone: nothere is not in the repository its entry names");
  expect(await refused("gone")).toBe("gone: nothere is not in the marketplace");
});
