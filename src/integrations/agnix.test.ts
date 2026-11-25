// The agnix runner against a stand-in agnix that prints known JSON: what it reads of the output,
// that the same files run nothing again, that a changed file runs again, a program that hangs, and
// a machine without agnix.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { Agnix, configsOf, errorsKey, findingLine, keyOf, parseLint } from "./agnix.ts";

const OUT = {
  version: "0.61.0", files_checked: 2,
  diagnostics: [
    { level: "info", rule: "VER-001", file: "", line: 1, message: "No tool or spec versions pinned." },
    { level: "warning", rule: "CDX-AG-005", file: "AGENTS.md", line: 5, message: "AGENTS.md references missing file `docs/x.md`" },
    { level: "error", rule: "CC-MEM-001", file: "CLAUDE.md", line: 3, message: "Import target not found: @nonexistent.md" },
  ],
  summary: { errors: 1, warnings: 1, info: 1 },
};

// A stand-in that notes each run (its arguments) and prints OUT, or hangs when the folder says so.
function standIn(dir: string): { bin: string; log: string } {
  const bin = join(dir, "agnix"), log = join(dir, "runs.log"), out = join(dir, "out.json");
  writeFileSync(out, JSON.stringify(OUT));
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\n[ -e HANG ] && exec sleep 30\ncat '${out}'\n[ -e CLAUDE.md ] && grep -q nonexistent CLAUDE.md && exit 1\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("agnix's JSON: counts from its summary, errors before warnings, info counted and not kept", () => {
  const r = parseLint(JSON.stringify(OUT))!;
  expect(r).toMatchObject({ version: "0.61.0", files: 2, errors: 1, warnings: 1, info: 1 });
  expect(r.findings.map((f) => f.rule)).toEqual(["CC-MEM-001", "CDX-AG-005"]);
  expect(findingLine(r.findings[0]!)).toBe("CLAUDE.md:3 CC-MEM-001: Import target not found: @nonexistent.md");
  expect(parseLint("Error: Validation root not found")).toBeNull();
});

test("a folder's configs are linted once per content: the same files run nothing, a changed one runs again", async () => {
  const dir = tempTree("agnix-");
  const { bin, log } = standIn(dir);
  const folder = join(dir, "repo");
  mkdirSync(join(folder, ".claude", "skills", "x"), { recursive: true });
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "CLAUDE.md"), "# Repo\n\nSee @nonexistent.md\n");
  writeFileSync(join(folder, "AGENTS.md"), "# Repo\n");
  writeFileSync(join(folder, ".claude", "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
  writeFileSync(join(folder, "src", "main.ts"), "code");
  // Only the agent configs are named: no walk of the folder.
  expect(configsOf(folder)).toEqual(["AGENTS.md", "CLAUDE.md", ".claude/skills"]);
  const changed: string[] = [];
  const state = join(dir, "agnix.json");
  const a = new Agnix({ bin: () => bin, nice: false, file: state, changed: (l) => changed.push(l.key) });
  const first = (await a.check(folder))!;
  expect(first).toMatchObject({ folder, errors: 1, warnings: 1 });
  expect(first.failed).toBeUndefined();
  expect(readFileSync(log, "utf8").trim()).toBe("--format json AGENTS.md CLAUDE.md .claude/skills");
  // The same files: answered from the last run, nothing spawned. A file that is no config changes nothing.
  writeFileSync(join(folder, "src", "main.ts"), "other code");
  expect(await a.check(folder)).toEqual(first);
  expect(a.runs).toBe(1);
  // Two asks at once are one run.
  writeFileSync(join(folder, ".claude", "skills", "x", "SKILL.md"), "---\nname: y\n---\n");
  const [x, y] = await Promise.all([a.check(folder), a.check(folder)]);
  expect(x).toBe(y);
  expect(a.runs).toBe(2);
  expect(changed.length).toBe(2);
  // Kept across a restart: a new runner reads the state file and runs nothing for the same files.
  await Bun.sleep(50);
  const b = new Agnix({ bin: () => bin, nice: false, file: state });
  expect((await b.check(folder))?.key).toBe(x!.key);
  expect(b.runs).toBe(0);
  expect(b.all().map((l) => l.folder)).toEqual([folder]);
});

test("a run that hangs is cut at its bound and says so; a folder with no configs runs nothing", async () => {
  const dir = tempTree("agnix-hang-");
  const { bin } = standIn(dir);
  const folder = join(dir, "repo");
  mkdirSync(folder);
  const a = new Agnix({ bin: () => bin, nice: false, ms: 300 });
  expect(await a.check(folder)).toBeNull();
  writeFileSync(join(folder, "AGENTS.md"), "# Repo\n");
  writeFileSync(join(folder, "HANG"), "");
  const r = (await a.check(folder))!;
  expect(r.failed).toContain("longer than");
  expect(r.errors).toBe(0);
});

test("without agnix: not installed, and a check runs nothing", async () => {
  const dir = tempTree("agnix-none-");
  writeFileSync(join(dir, "AGENTS.md"), "# Repo\n");
  const a = new Agnix({ bin: () => null });
  expect(a.installed()).toBe(false);
  expect(await a.check(dir)).toBeNull();
  expect(a.runs).toBe(0);
});

test("a key's walk ends on a link to a folder above it, and counts folders against its bound", async () => {
  const dir = tempTree("agnix-loop-");
  const folder = join(dir, "repo");
  mkdirSync(join(folder, ".claude", "skills", "x"), { recursive: true });
  writeFileSync(join(folder, ".claude", "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
  symlinkSync("../..", join(folder, ".claude", "skills", "x", "up"));
  const k = await keyOf(folder, [".claude/skills"], "/bin/true");
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(await keyOf(folder, [".claude/skills"], "/bin/true")).toBe(k);
});

test("a session is told the same errors once: a moved line or a warning changes nothing", () => {
  const e = { level: "error" as const, rule: "CC-MEM-001", file: "CLAUDE.md", line: 3, message: "Import target not found" };
  const w = { level: "warning" as const, rule: "W", file: "AGENTS.md", line: 1, message: "w" };
  expect(errorsKey({ findings: [e, w] })).toBe(errorsKey({ findings: [{ ...e, line: 9 }] }));
  expect(errorsKey({ findings: [e] })).not.toBe(errorsKey({ findings: [{ ...e, message: "other" }] }));
});
