#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { commands } from "./cli/index.ts";
import { topHelp, unknownCommand } from "./cli/help.ts";
import { parseBind } from "./core/bind.ts";
import { buildId, versionLine } from "./core/build.ts";
import { configDir } from "./providers/config.ts";
import { startLine } from "./admin/daemon-log.ts";
import { daemonApi } from "./server/ui-bundle.ts";
import { startDaemon } from "./server/start.ts";

const SERVE_USAGE = "keel serve [--bind HOST:PORT] [--state-dir DIR] [--workspace DIR] [--dev]\n  Runs the daemon: the agent loop, the HTTP API and the workbench (default bind 127.0.0.1:47960).";
const sub = Bun.argv[2];
// The daemon's own helper process (src/admin/backup-check.ts): no command of the owner's, no state folder claimed.
if (sub === "backup-check") process.exit(await (await import("./admin/backup-check.ts")).main());
if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
  const of = sub === "help" ? Bun.argv[3] : undefined;
  if (of && commands[of]) process.exit(await commands[of](["--help"]));
  // serve is not a client command: its usage is printed here, and no daemon starts.
  if (of === "serve") process.exit((console.log(SERVE_USAGE), 0));
  process.exit((console.log(topHelp()), 0));
}
// What this binary was built from: the revision a release names.
if (sub === "--version" || sub === "-V") process.exit((console.log(versionLine(daemonApi())), 0));
// Client commands (keel run, keel send, keel pair, ...) parse their own options.
// -h is --help for every one of them (up to a `--`, after which words are the caller's).
if (sub && commands[sub]) {
  const rest = Bun.argv.slice(3);
  const end = rest.indexOf("--");
  process.exit(await commands[sub](rest.map((a, i) => (a === "-h" && (end < 0 || i < end) ? "--help" : a))));
}

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
// Checked here, before a state folder is made or claimed.
const bind = parseBind(values.bind!);
if ("error" in bind) {
  console.error(`keel serve: ${bind.error}\n${SERVE_USAGE}`);
  process.exit(3);
}

const g = globalThis as { __keelSignals?: boolean; __keelStop?: (ms: number) => Promise<void>; __keelStartSaid?: boolean };
// A daemon that could not start ends here, with what went wrong. Left alone it
// serves nothing and stays: it holds the state folder, the modules it loaded
// keep it alive and take its signals, and under --hot the process waits for an
// edit. The usual cause is the port: free when it was checked, taken before
// the bind. A hot reload that fails is not a start: the process and the page
// it serves stay for the next edit.
const d = await startDaemon({ stateDir: values["state-dir"], bind: values.bind!, workspace: values.workspace, dev: values.dev }).catch((e) => {
  if (g.__keelSignals) throw e;
  const taken = (e as { code?: string })?.code === "EADDRINUSE" || /in use/i.test(String((e as Error)?.message));
  console.error(taken
    ? `keel serve: ${values.bind} could not be bound: port ${bind.port} is in use (it was taken after it was checked). Stop what holds it, or pick another --bind.`
    : `keel serve: the daemon could not start: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
// Running turns get this long to end by themselves when the daemon stops; the
// rest are parked and the next daemon continues them.
const DRAIN_MS = Number(process.env.KEEL_DRAIN_MS ?? 10_000);
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
if (!g.__keelStartSaid) {
  g.__keelStartSaid = true;
  console.log(startLine({ revision: buildId(), pid: process.pid, url: d.url, state: d.stateDir, config: configDir() }));
}
