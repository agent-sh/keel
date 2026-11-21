// The one way an owner's config file is replaced: whole, with what it held
// kept beside it.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prevOf, removeOwnFile, writeAll, writeOwnFile } from "./ownfile.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

test("a replaced file keeps what it held as .prev, at its mode, and nothing else is left", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-own-"));
  const f = join(dir, "sub", "servers.json");
  expect(writeOwnFile(f, "one")).toBe(true); // a new file, its folder made
  expect(existsSync(prevOf(f))).toBe(false);
  chmodSync(f, 0o640);
  expect(writeOwnFile(f, "two")).toBe(true);
  expect(readFileSync(f, "utf8")).toBe("two");
  expect(readFileSync(prevOf(f), "utf8")).toBe("one");
  expect([mode(f), mode(prevOf(f))]).toEqual([0o640, 0o640]);
  // The same content again is no change: the .prev stays the last real one.
  expect(writeOwnFile(f, "two")).toBe(false);
  expect(readFileSync(prevOf(f), "utf8")).toBe("one");
  expect(readdirSync(join(dir, "sub")).sort()).toEqual(["servers.json", "servers.json.prev"]);
  // A removal can be taken back too.
  expect(removeOwnFile(f)).toBe(true);
  expect(existsSync(f)).toBe(false);
  expect(readFileSync(prevOf(f), "utf8")).toBe("two");
});

test("a sign-in gets its mode and no previous copy; a link stays a link", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-own-"));
  const grant = join(dir, "grant.json");
  writeOwnFile(grant, "token-1", { mode: 0o600, prev: false });
  writeOwnFile(grant, "token-2", { mode: 0o600, prev: false });
  expect(mode(grant)).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["grant.json"]);

  mkdirSync(join(dir, "dotfiles"));
  writeFileSync(join(dir, "dotfiles", "hooks.json"), "{}");
  const link = join(dir, "hooks.json");
  symlinkSync(join(dir, "dotfiles", "hooks.json"), link);
  writeOwnFile(link, '{"hooks":{}}');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dir, "dotfiles", "hooks.json"), "utf8")).toBe('{"hooks":{}}');
  expect(readFileSync(prevOf(link), "utf8")).toBe("{}"); // beside the name the owner knows
});

test("a write that fails leaves the file as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-own-"));
  const f = join(dir, "mcp.json");
  writeOwnFile(f, "whole");
  chmodSync(dir, 0o500); // nothing new can be made beside it
  try {
    expect(() => writeOwnFile(f, "half", { prev: false })).toThrow();
    expect(readFileSync(f, "utf8")).toBe("whole");
    expect(readdirSync(dir)).toEqual(["mcp.json"]);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a write the disk cuts short is never given the file's name", () => {
  // The write call may take fewer bytes than asked: the rest is written, or it fails.
  const got: number[] = [];
  writeAll(7, Buffer.alloc(10, "x"), (_fd, _d, at, n) => { got.push(at); return Math.min(4, n); });
  expect(got).toEqual([0, 4, 8]);
  expect(() => writeAll(7, Buffer.alloc(10, "x"), (_fd, _d, at) => (at === 0 ? 6 : 0))).toThrow("the write stopped at 6 of 10 bytes");

  // For real, in a process whose files may not grow past 64 KB (as on a full disk or a quota).
  const dir = mkdtempSync(join(tmpdir(), "keel-own-"));
  const f = join(dir, "mcp.json"), child = join(dir, "child.ts");
  writeFileSync(f, "whole");
  writeFileSync(child, `process.env.KEEL_CONFIG_DIR = ${JSON.stringify(join(dir, "config"))};
process.on("SIGXFSZ", () => {});
const { writeOwnFile } = await import(${JSON.stringify(join(import.meta.dir, "ownfile.ts"))});
try { writeOwnFile(process.argv[2], Buffer.alloc(200_000, "n")); console.log("written"); } catch (e) { console.log("refused: " + e.message); }
`);
  const run = Bun.spawnSync(["bash", "-c", 'ulimit -f 64; exec bun "$0" "$1"', child, f], { stdout: "pipe", stderr: "pipe" });
  expect(run.stdout.toString()).toStartWith("refused: ");
  expect(readFileSync(f, "utf8")).toBe("whole");
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("what an edit does with a file that is not a plain one of the owner's", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-own-"));
  // A link to nothing gets its file where it points, and stays a link.
  mkdirSync(join(dir, "store"));
  symlinkSync(join(dir, "store", "hooks.json"), join(dir, "hooks.json"));
  writeOwnFile(join(dir, "hooks.json"), "{}");
  expect(lstatSync(join(dir, "hooks.json")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dir, "store", "hooks.json"), "utf8")).toBe("{}");
  // A link into a folder that is not there fails, and nothing is made.
  symlinkSync(join(dir, "nowhere", "x.json"), join(dir, "x.json"));
  expect(() => writeOwnFile(join(dir, "x.json"), "{}")).toThrow();
  expect(existsSync(join(dir, "nowhere"))).toBe(false);

  // Another name for the same file keeps what it held: a copy stays a copy.
  writeFileSync(join(dir, "skills.json"), "one");
  linkSync(join(dir, "skills.json"), join(dir, "copy-of-skills.json"));
  writeOwnFile(join(dir, "skills.json"), "two");
  expect([readFileSync(join(dir, "skills.json"), "utf8"), readFileSync(join(dir, "copy-of-skills.json"), "utf8")]).toEqual(["two", "one"]);

  // A file the owner made read-only is theirs to keep; the same content is still no change.
  writeFileSync(join(dir, "plugins.toml"), "kept");
  chmodSync(join(dir, "plugins.toml"), 0o444);
  expect(() => writeOwnFile(join(dir, "plugins.toml"), "new")).toThrow("is read-only");
  expect(writeOwnFile(join(dir, "plugins.toml"), "kept")).toBe(false);
  expect(readFileSync(join(dir, "plugins.toml"), "utf8")).toBe("kept");
  // One that cannot be read is not replaced: there would be nothing to keep of it.
  writeFileSync(join(dir, "drive.json"), "secret");
  chmodSync(join(dir, "drive.json"), 0o200);
  expect(() => writeOwnFile(join(dir, "drive.json"), "new")).toThrow("cannot be read");
  chmodSync(join(dir, "drive.json"), 0o600);
  expect(readFileSync(join(dir, "drive.json"), "utf8")).toBe("secret");
  expect(existsSync(prevOf(join(dir, "drive.json")))).toBe(false);

  // The temp file of a write that was killed goes with the next write; a live process's stays.
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(dir, `mcp.json.${dead}.tmp`), "half");
  writeFileSync(join(dir, `mcp.json.prev.${dead}.tmp`), "half");
  writeFileSync(join(dir, `mcp.json.${process.ppid}.tmp`), "theirs");
  writeOwnFile(join(dir, "mcp.json"), "{}");
  expect(readdirSync(dir).filter((n) => n.startsWith("mcp.json")).sort()).toEqual(["mcp.json", `mcp.json.${process.ppid}.tmp`]);
});
