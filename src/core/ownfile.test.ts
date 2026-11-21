// The one way an owner's config file is replaced: whole, with what it held
// kept beside it.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prevOf, removeOwnFile, writeOwnFile } from "./ownfile.ts";

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
