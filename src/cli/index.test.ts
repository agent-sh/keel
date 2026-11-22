// The command table and what a client command loads: the entry and the short
// commands reach none of the daemon's code through an import that is made
// when the file loads.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { allCommands, commandOf, isCommand, WHERE } from "./index.ts";
import { COMMAND_NAMES } from "./help.ts";

const root = resolve(import.meta.dir, "../..");

// The files `entry` loads with it: its imports that carry code, and theirs. An `import type` and an `import()` load nothing.
function loadedWith(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || !/\.tsx?$/.test(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8").replace(/^#!.*\n/, "\n");
    for (const i of new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).scanImports(src)) {
      if (i.kind === "import-statement" && i.path.startsWith(".")) walk(resolve(dirname(file), i.path));
    }
  };
  walk(resolve(root, entry));
  return [...seen].map((f) => relative(root, f)).sort();
}

test("every command is in the table under the file that holds it, and the help names no command the table lacks", async () => {
  const all = await allCommands();
  expect(Object.keys(all).sort()).toEqual(Object.keys(WHERE).sort());
  for (const name of Object.keys(WHERE)) expect(typeof (await commandOf(name))).toBe("function");
  expect(isCommand("serve")).toBe(false);
  expect(await commandOf("no-such-command")).toBeUndefined();
  // A name an object has by birth is no command.
  expect(isCommand("constructor")).toBe(false);
  for (const name of COMMAND_NAMES) if (name !== "serve" && name !== "help") expect([name, isCommand(name)]).toEqual([name, true]);
});

test("the entry loads the table alone, and the short client commands load no daemon code", () => {
  // `keel --version`, `keel --help` and the choice of a command: the entry and the table, nothing else.
  expect(loadedWith("src/main.ts")).toEqual(["src/cli/index.ts", "src/main.ts"]);
  expect(loadedWith("src/core/build.ts")).toEqual(["src/core/build.ts"]);
  expect(loadedWith("src/core/api-stamp.ts")).toEqual(["src/core/api-stamp.ts"]);
  // The daemon's side: the server, the engine, the tools, the safety layer, the integrations, the store.
  // (The words of an approval card are shared with the page: a few files of text, nothing of the gate.)
  const daemon = /^src\/(server|engine|tools|integrations|mcp|fleet|lsp|helper|drive)\/|^src\/safety\/(?!(card|chars|summary|risk-words)\.ts$)|^src\/core\/(store|bus|errors|checkpoint)\.ts$|^src\/admin\/(daemon|storage|stall|life)\.ts$/;
  // status, usage, storage, restart, drain; sessions, send, approve, show, logs, stop; run without a daemon of its own.
  for (const file of ["src/cli/client.ts", "src/cli/admin.ts", "src/cli/sessions.ts", "src/cli/run.ts", "src/cli/help.ts"]) {
    expect([file, loadedWith(file).filter((f) => daemon.test(f))]).toEqual([file, []]);
  }
  // The daemon itself is what does load them.
  expect(loadedWith("src/server/start.ts").some((f) => daemon.test(f))).toBe(true);
});
