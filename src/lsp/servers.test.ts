import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoff, BACKOFF_MS } from "./manager.ts";
import { BUILTIN, checkOverrides, definitions, findCommand, rootFor } from "./servers.ts";

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
  expect(findCommand(def("typescript"), ws, "")).toEqual({ missing: expect.stringContaining("typescript 7.0.0 or newer in the workspace's modules (it has 6.9.9)") });
  writeFileSync(join(ws, "node_modules/typescript/package.json"), JSON.stringify({ version: "7.0.2" }));
  expect(findCommand(def("typescript"), ws, "")).toEqual({ argv: [join(ws, "node_modules/@typescript/typescript-linux-x64/lib/tsc"), "--lsp", "--stdio"], from: "workspace" });
});

test("a server that keeps failing is started again after a growing pause", () => {
  const now = 1_000_000_000;
  expect(backoff([], now)).toBe(0);
  expect(backoff([now - 10], now)).toBe(BACKOFF_MS[0]!);
  expect(backoff([now - 30, now - 20, now - 10], now)).toBe(BACKOFF_MS[2]!);
  expect(backoff(Array.from({ length: 9 }, (_, i) => now - i), now)).toBe(BACKOFF_MS.at(-1)!);
  expect(backoff([now - 700_000], now)).toBe(0); // an old failure is forgotten
});
