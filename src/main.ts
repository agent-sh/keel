#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { commands } from "./cli/index.ts";
import { topHelp, unknownCommand } from "./cli/help.ts";
import { startDaemon } from "./server/start.ts";

const sub = Bun.argv[2];
if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
  const of = sub === "help" ? Bun.argv[3] : undefined;
  if (of && commands[of]) process.exit(await commands[of](["--help"]));
  process.exit((console.log(topHelp()), 0));
}
// Client commands (keel run, keel send, keel pair, ...) parse their own options.
if (sub && commands[sub]) process.exit(await commands[sub](Bun.argv.slice(3)));

const SERVE_USAGE = "keel serve [--bind HOST:PORT] [--state-dir DIR] [--workspace DIR] [--dev]\n  Runs the daemon: the agent loop, the HTTP API and the workbench (default bind 127.0.0.1:47960).";
const args = Bun.argv.slice(2);
if (args[0] && args[0] !== "serve" && !args[0].startsWith("-")) process.exit(unknownCommand(args[0]));
let parsed;
try {
  parsed = parseArgs({
    args: args[0] === "serve" ? args.slice(1) : args,
    options: {
      bind: { type: "string", default: "127.0.0.1:47960" },
      "state-dir": { type: "string" },
      workspace: { type: "string" },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  console.error(`keel serve: ${(e as Error).message}\n${SERVE_USAGE}`);
  process.exit(3);
}
const { values } = parsed;
if (values.help) process.exit((console.log(SERVE_USAGE), 0));

const d = await startDaemon({ stateDir: values["state-dir"], bind: values.bind!, workspace: values.workspace, dev: values.dev });
// Running turns get this long to end by themselves when the daemon stops; the
// rest are parked and the next daemon continues them.
const DRAIN_MS = Number(process.env.KEEL_DRAIN_MS ?? 10_000);
const g = globalThis as { __keelSignals?: boolean; __keelStop?: (ms: number) => Promise<void> };
g.__keelStop = d.stop;
if (!g.__keelSignals) {
  g.__keelSignals = true;
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (stopping) return process.exit(0); // a second signal stops at once
      stopping = true;
      await g.__keelStop!(DRAIN_MS);
      setTimeout(() => process.exit(0), 300);
    });
  }
}
console.log(`keel listening on ${d.url} (state ${d.stateDir})`);
