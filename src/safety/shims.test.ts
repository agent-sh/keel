import { expect, test } from "bun:test";
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPrograms } from "./shims.ts";

// A folder with one file by that name: a binary, a script, or a link to another file.
const root = mkdtempSync(join(tmpdir(), "keel-shims-"));
let n = 0;
const dir = (name: string, body: string | { link: string }, at = `d${n++}`) => {
  const d = join(root, at);
  mkdirSync(d, { recursive: true });
  if (typeof body === "string") { writeFileSync(join(d, name), body, "latin1"); chmodSync(join(d, name), 0o755); }
  else symlinkSync(body.link, join(d, name));
  return d;
};
const home = join(root, "home");
mkdirSync(home);
const ELF = "\x7fELF\x02\x01\x01";
const real = async (prog: string, path: string, at = home) => (await realPrograms([prog], { path, home: at })).get(prog);

test("a program is itself when every file by its name on the PATH is its own binary", async () => {
  const node = dir("node", ELF);
  expect(await real("node", node)).toBe(true);
  // A versioned name behind a link, as distributions install them.
  const py = dir("python3.14", ELF);
  expect(await real("python3", dir("python3", { link: join(py, "python3.14") }))).toBe(true);
  const gcc = dir("x86_64-linux-gnu-gcc-15", ELF);
  expect(await real("gcc", dir("gcc", { link: join(gcc, "x86_64-linux-gnu-gcc-15") }))).toBe(true);
  expect(await real("node", `${dir("other", ELF)}:${node}`)).toBe(true);
  // A Mach-O binary, and several names in one look.
  expect(await real("bun", dir("bun", "\xcf\xfa\xed\xfe\x07"))).toBe(true);
  expect([...(await realPrograms(["node", "bun", "uv"], { path: node, home }))]).toEqual([["node", true], ["bun", false], ["uv", false]]);
});

test("a shim, a script, a missing program and an unknown PATH are not", async () => {
  const node = dir("node", ELF);
  // A link to a manager's own binary (volta, mise, rustup).
  const volta = dir("volta-shim", ELF);
  expect(await real("node", dir("node", { link: join(volta, "volta-shim") }))).toBe(false);
  const rustup = dir("rustup", ELF);
  expect(await real("cargo", dir("cargo", { link: join(rustup, "rustup") }))).toBe(false);
  // A script, whatever runs it and whatever its first line says, and anything in a shims folder.
  for (const script of ["#!/usr/bin/env bash\nexec asdf exec node \"$@\"\n", "#!/bin/sh\nexec pyenv exec node \"$@\"\n", "#!/usr/bin/python3\nimport os\n", "#!/usr/bin/perl\n", "echo no first line\n", ""])
    expect([script, await real("node", dir("node", script))]).toEqual([script, false]);
  expect(await real("node", dir("node", ELF, "x/shims"))).toBe(false);
  // One shim anywhere on the PATH is enough, whatever comes first.
  expect(await real("node", `${node}:${dir("node", { link: join(volta, "volta-shim") })}`)).toBe(false);
  // Not found, a name with a folder in it, a relative PATH entry.
  expect(await real("node", dir("other", ELF))).toBe(false);
  expect(await real("./node", node)).toBe(false);
  expect(await real("node", `${node}:.`)).toBe(false);
  expect(await real("node", `${node}:`)).toBe(false);
  // A manager's folder under the home holds one, though the PATH does not name it (a login profile may).
  const managed = join(root, "managed");
  mkdirSync(join(managed, ".volta/bin"), { recursive: true });
  writeFileSync(join(managed, ".volta/bin/node"), ELF);
  expect(await real("node", node, managed)).toBe(false);
  expect(await real("bun", dir("bun", ELF), managed)).toBe(true);
  const cargoHome = join(root, "rust");
  mkdirSync(join(cargoHome, ".cargo/bin"), { recursive: true });
  symlinkSync(join(rustup, "rustup"), join(cargoHome, ".cargo/bin/cargo"));
  expect(await real("cargo", dir("cargo", ELF), cargoHome)).toBe(false);
});

test("what the disk does not answer in time counts as not, off the loop, and its folder is left alone until it does", async () => {
  // A file whose open never returns, as on a mount that hangs: a pipe nobody writes to.
  const hung = join(root, "hung");
  mkdirSync(hung);
  expect(Bun.spawnSync(["mkfifo", join(hung, "node")]).exitCode).toBe(0);
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 5);
  const t0 = performance.now();
  expect((await realPrograms(["node"], { path: hung, home, deadlineMs: 60 })).get("node")).toBe(false);
  expect(performance.now() - t0).toBeLessThan(1000);
  clearInterval(ticking);
  expect(ticks).toBeGreaterThan(2); // the loop went on turning while the disk did not answer
  // Its folder is not looked at again while that look is out: the answer is at once, with no second thread held.
  const t1 = performance.now();
  expect((await realPrograms(["node"], { path: hung, home, deadlineMs: 5000 })).get("node")).toBe(false);
  expect(performance.now() - t1).toBeLessThan(1000);
  // The look comes back (a writer opens the pipe), and the folder is looked at again.
  const writer = openSync(join(hung, "node"), constants.O_RDWR | constants.O_NONBLOCK);
  await Bun.sleep(50);
  closeSync(writer);
  const node = dir("node", ELF);
  expect(await real("node", node)).toBe(true);
});
