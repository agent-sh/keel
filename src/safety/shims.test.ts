import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realProgram } from "./shims.ts";

// A folder with one file by that name: a binary, a script, or a link to another file.
const root = mkdtempSync(join(tmpdir(), "keel-shims-"));
let n = 0;
const dir = (name: string, body: string | { link: string }, at = `d${n++}`) => {
  const d = join(root, at);
  mkdirSync(d, { recursive: true });
  if (typeof body === "string") { writeFileSync(join(d, name), body); chmodSync(join(d, name), 0o755); }
  else symlinkSync(body.link, join(d, name));
  return d;
};
const home = join(root, "home");
mkdirSync(home);
const ELF = "\x7fELF\x02\x01\x01";

test("a program is itself when every file by its name on the PATH is the program", () => {
  const node = dir("node", ELF);
  expect(realProgram("node", node, home)).toBe(true);
  // A versioned name behind a link, as distributions install them.
  const py = dir("python3.14", ELF);
  expect(realProgram("python3", dir("python3", { link: join(py, "python3.14") }), home)).toBe(true);
  const gcc = dir("x86_64-linux-gnu-gcc-15", ELF);
  expect(realProgram("gcc", dir("gcc", { link: join(gcc, "x86_64-linux-gnu-gcc-15") }), home)).toBe(true);
  // A script its own interpreter runs (pip) is the program too.
  expect(realProgram("pip", dir("pip", "#!/usr/bin/python3\nimport sys\n"), home)).toBe(true);
  expect(realProgram("node", `${dir("other", ELF)}:${node}`, home)).toBe(true);
});

test("a shim, a wrapper, a missing program and an unknown PATH are not", () => {
  const node = dir("node", ELF);
  // A link to a manager's own binary (volta, mise, rustup).
  const volta = dir("volta-shim", ELF);
  expect(realProgram("node", dir("node", { link: join(volta, "volta-shim") }), home)).toBe(false);
  const rustup = dir("rustup", ELF);
  expect(realProgram("cargo", dir("cargo", { link: join(rustup, "rustup") }), home)).toBe(false);
  // A script a shell runs (asdf, pyenv), and anything in a shims folder.
  expect(realProgram("node", dir("node", "#!/usr/bin/env bash\nexec asdf exec node \"$@\"\n"), home)).toBe(false);
  expect(realProgram("python3", dir("python3", "#!/bin/sh\nexec pyenv exec python3 \"$@\"\n"), home)).toBe(false);
  expect(realProgram("node", dir("node", ELF, "x/shims"), home)).toBe(false);
  // One shim anywhere on the PATH is enough, whatever comes first.
  expect(realProgram("node", `${node}:${dir("node", { link: join(volta, "volta-shim") })}`, home)).toBe(false);
  // Not found, a name with a folder in it, a relative PATH entry.
  expect(realProgram("node", dir("other", ELF), home)).toBe(false);
  expect(realProgram("./node", node, home)).toBe(false);
  expect(realProgram("node", `${node}:.`, home)).toBe(false);
  expect(realProgram("node", `${node}:`, home)).toBe(false);
  // A manager's folder under the home holds one, though the PATH does not name it (a login profile may).
  const managed = join(root, "managed");
  mkdirSync(join(managed, ".volta/bin"), { recursive: true });
  writeFileSync(join(managed, ".volta/bin/node"), ELF);
  expect(realProgram("node", node, managed)).toBe(false);
  expect(realProgram("bun", dir("bun", ELF), managed)).toBe(true);
  const cargoHome = join(root, "rust");
  mkdirSync(join(cargoHome, ".cargo/bin"), { recursive: true });
  symlinkSync(join(rustup, "rustup"), join(cargoHome, ".cargo/bin/cargo"));
  expect(realProgram("cargo", dir("cargo", ELF), cargoHome)).toBe(false);
});
