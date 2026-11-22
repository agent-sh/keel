import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoff, BACKOFF_MS, memoryShort } from "./manager.ts";
import { BUILTIN, checkOverrides, definitions, findCommand, rootFor, startRule } from "./servers.ts";

const def = (id: string) => BUILTIN.find((d) => d.id === id)!;

test("the owner's entry turns a server on or off, changes one, or adds one", () => {
  const base = definitions();
  expect(base.find((d) => d.id === "typescript")!.enabled).toBe(true);
  expect(base.find((d) => d.id === "rust-analyzer")!.enabled).toBe(false); // found is not on: it runs build scripts
  const mine = definitions({
    typescript: { enabled: false },
    "rust-analyzer": { enabled: true, initialization: { checkOnSave: false } },
    zls: { command: ["zls", "--stdio"], extensions: { ".zig": "zig" } },
  });
  expect(mine.find((d) => d.id === "typescript")!.enabled).toBe(false);
  expect(mine.find((d) => d.id === "rust-analyzer")).toMatchObject({ enabled: true, initialization: { checkOnSave: false } });
  expect(mine.find((d) => d.id === "zls")).toMatchObject({ enabled: true, own: true, command: [{ bin: "zls", args: ["--stdio"] }], extensions: { ".zig": "zig" } });
  expect(checkOverrides({ zls: { extensions: { ".zig": "zig" } } })).toContain("needs command and extensions");
  expect(checkOverrides({ typescript: { command: "tsgo --lsp" } })).toContain("list of words");
  expect(checkOverrides({ typescript: { enabled: false }, zls: { command: ["zls"], extensions: { ".zig": "zig" } } })).toBeUndefined();
});

test("a project's root is found from the file up, never above the session's folder", () => {
  const top = mkdtempSync(join(tmpdir(), "keel-lsp-"));
  const ws = join(top, "repo");
  mkdirSync(join(ws, "packages/app/src"), { recursive: true });
  writeFileSync(join(top, "package.json"), "{}"); // above the session's folder: not its project
  writeFileSync(join(ws, "package.json"), "{}");
  writeFileSync(join(ws, "packages/app/tsconfig.json"), "{}");
  writeFileSync(join(ws, "packages/app/compile_flags.txt"), "");
  const file = join(ws, "packages/app/src/a.ts");
  expect(rootFor(def("typescript"), file, ws)).toBe(ws);                                 // the outermost: one server for the folder
  expect(rootFor(def("clangd"), join(ws, "packages/app/src/a.c"), ws)).toBe(join(ws, "packages/app")); // the nearest
  expect(rootFor(def("gopls"), join(ws, "x.go"), ws)).toBeNull();                         // no go.mod: no server
  expect(rootFor(def("ruff"), join(ws, "x.py"), ws)).toBe(ws);                            // needs no project file
  // The workspace's TypeScript is its own server from version 7 only.
  mkdirSync(join(ws, "node_modules/typescript"), { recursive: true });
  mkdirSync(join(ws, "node_modules/@typescript/typescript-linux-x64/lib"), { recursive: true });
  writeFileSync(join(ws, "node_modules/@typescript/typescript-linux-x64/lib/tsc"), "");
  writeFileSync(join(ws, "node_modules/typescript/package.json"), JSON.stringify({ version: "6.9.9" }));
  expect(findCommand(def("typescript"), ws, ws, "")).toEqual({ missing: expect.stringContaining("typescript 7.0.0 or newer in the workspace's modules (it has 6.9.9)") });
  writeFileSync(join(ws, "node_modules/typescript/package.json"), JSON.stringify({ version: "7.0.2" }));
  expect(findCommand(def("typescript"), ws, ws, "")).toEqual({ argv: [join(ws, "node_modules/@typescript/typescript-linux-x64/lib/tsc"), "--lsp", "--stdio"], from: "workspace", loads: false });
});

test("a program is looked for in the project and the session's folder, never above; the owner's command on PATH only", () => {
  const top = mkdtempSync(join(tmpdir(), "keel-lsp-"));
  const ws = join(top, "repo");
  const bin = join(top, "bin");
  mkdirSync(join(ws, "pkg/node_modules/.bin"), { recursive: true });
  mkdirSync(join(top, "node_modules/.bin"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(ws, ".venv/bin"), { recursive: true });
  writeFileSync(join(ws, "pkg/package.json"), "{}");
  const exe = (p: string) => writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  // Above the session's folder: twelve folders up is not the workspace.
  exe(join(top, "node_modules/.bin/tsgo"));
  expect(findCommand(def("typescript"), ws, ws, "")).toEqual({ missing: expect.stringContaining("not found") });
  // The TypeScript 6 server is a candidate only once the owner turned the server on by name, and it loads the project's code.
  exe(join(bin, "typescript-language-server"));
  expect(findCommand(definitions().find((d) => d.id === "typescript")!, ws, ws, bin)).toEqual({ missing: expect.stringContaining("only once you turn this server on") });
  expect(findCommand(definitions({ typescript: { enabled: true } }).find((d) => d.id === "typescript")!, ws, ws, bin)).toEqual({ argv: [join(bin, "typescript-language-server"), "--stdio"], from: "path", loads: true });
  // A program of the virtual environment is the workspace's; the same name on PATH is the machine's.
  exe(join(bin, "ruff"));
  expect(findCommand(def("ruff"), ws, ws, bin)).toMatchObject({ from: "path", loads: false });
  exe(join(ws, ".venv/bin/ruff"));
  expect(findCommand(def("ruff"), ws, ws, bin)).toMatchObject({ argv: [join(ws, ".venv/bin/ruff"), "server"], from: "workspace" });
  // A PATH that leads into the workspace does not make its file the machine's.
  expect(findCommand({ ...def("ruff"), command: [{ bin: "ruff", args: ["server"] }] }, ws, ws, join(ws, ".venv/bin"))).toMatchObject({ from: "workspace" });
  // The owner's own command: a name on PATH, never a file of the repository with that name.
  exe(join(ws, "pkg/node_modules/.bin/zls"));
  const own = (command: string[]) => definitions({ zls: { command, extensions: { ".zig": "zig" } } }).find((d) => d.id === "zls")!;
  expect(findCommand(own(["zls"]), join(ws, "pkg"), ws, bin)).toEqual({ missing: "not found: zls" });
  expect(findCommand(own(["node_modules/.bin/zls"]), join(ws, "pkg"), ws, bin)).toEqual({ missing: expect.stringContaining("a name on PATH or a whole path") });
  exe(join(bin, "zls"));
  expect(findCommand(own(["zls"]), join(ws, "pkg"), ws, bin)).toEqual({ argv: [join(bin, "zls")], from: "path", loads: true });
  // Only the TypeScript 7 candidates and ruff start by themselves.
  expect(definitions().filter((d) => d.enabled).map((d) => d.id)).toEqual(["typescript", "ruff"]);
});

test("a workspace's program starts only where the session already runs commands unasked, or after the owner's trust", () => {
  const rule = (mode: string, sandbox: "off" | "workspace-write", o: Partial<{ trusted: boolean; from: "workspace" | "path"; loads: boolean }> = {}) =>
    startRule({ mode, sandbox, trusted: false, from: "workspace", loads: false, ...o });
  // Ask, sandbox off, a fresh clone: one approved edit starts nothing of the clone.
  expect(rule("ask", "off")).toEqual({ wait: expect.stringContaining("once you trust this folder's language servers") });
  expect(rule("auto-edits", "off")).toHaveProperty("wait");
  expect(rule("auto", "off")).toHaveProperty("wait");
  expect(rule("full-auto", "off")).toEqual({ start: "unconfined" }); // commands already run unconfined and unasked there
  // Sandboxed: where sandboxed commands run by themselves, so does the server, inside the sandbox.
  expect(rule("ask", "workspace-write")).toHaveProperty("wait");
  expect(rule("reviewer", "workspace-write")).toHaveProperty("wait");
  for (const mode of ["auto-edits", "auto", "full-auto"]) expect(rule(mode, "workspace-write")).toEqual({ start: "confined" });
  // The owner's trust, in so many words.
  expect(rule("ask", "off", { trusted: true })).toEqual({ start: "unconfined" });
  expect(rule("ask", "workspace-write", { trusted: true })).toEqual({ start: "confined" });
  // A program of the machine that loads nothing of the workspace starts in any mode; one that loads its code does not.
  expect(rule("ask", "off", { from: "path" })).toEqual({ start: "unconfined" });
  expect(rule("ask", "workspace-write", { from: "path" })).toEqual({ start: "confined" });
  expect(rule("ask", "off", { from: "path", loads: true })).toHaveProperty("wait");
});

test("memory is short when little is available or the kernel reports tasks waiting on it", () => {
  const info = (mb: number) => `MemTotal: 64000000 kB\nMemAvailable:   ${mb * 1024} kB\n`;
  const psi = (some: number) => `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
  expect(memoryShort(2048, info(40_000), psi(0))).toBeNull();
  expect(memoryShort(2048, info(1500), psi(0))).toContain("1500 MB of memory available");
  expect(memoryShort(2048, info(40_000), psi(12.5))).toContain("short of memory"); // swapping, with memory still counted as available
  expect(memoryShort(0, info(10), psi(50))).toBeNull(); // no limit set
});

test("a server that keeps failing is started again after a growing pause", () => {
  const now = 1_000_000_000;
  expect(backoff([], now)).toBe(0);
  expect(backoff([now - 10], now)).toBe(BACKOFF_MS[0]!);
  expect(backoff([now - 30, now - 20, now - 10], now)).toBe(BACKOFF_MS[2]!);
  expect(backoff(Array.from({ length: 9 }, (_, i) => now - i), now)).toBe(BACKOFF_MS.at(-1)!);
  expect(backoff([now - 700_000], now)).toBe(0); // an old failure is forgotten
});
