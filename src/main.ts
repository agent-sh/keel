#!/usr/bin/env bun
// The entry of the binary. It imports nothing of the daemon and of no
// command: `keel --version` and a client command load what they run, the
// daemon's code is loaded by `keel serve` alone (src/cli/index.ts).
import { parseArgs } from "node:util";
import { isCommand, commandOf } from "./cli/index.ts";

const SERVE_USAGE = "keel serve [--bind HOST:PORT] [--state-dir DIR] [--workspace DIR] [--dev]\n  Runs the daemon: the agent loop, the HTTP API and the workbench (default bind 127.0.0.1:47960).";
const sub = Bun.argv[2];
// The daemon's own helper process (src/admin/backup-check.ts): no command of the owner's, no state folder claimed.
if (sub === "backup-check") process.exit(await (await import("./admin/backup-check.ts")).main());
if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
  const of = sub === "help" ? Bun.argv[3] : undefined;
  if (of && isCommand(of)) process.exit(await (await commandOf(of))!(["--help"]));
  // serve is not a client command: its usage is printed here, and no daemon starts.
  if (of === "serve") process.exit((console.log(SERVE_USAGE), 0));
  process.exit((console.log((await import("./cli/help.ts")).topHelp()), 0));
}
// What this binary was built from: the revision a release names.
if (sub === "--version" || sub === "-V") {
  const [{ versionLine }, { daemonApi }] = await Promise.all([import("./core/build.ts"), import("./core/api-stamp.ts")]);
  process.exit((console.log(versionLine(daemonApi())), 0));
}
// Client commands (keel run, keel send, keel pair, ...) parse their own options.
// -h is --help for every one of them (up to a `--`, after which words are the caller's).
if (sub && isCommand(sub)) {
  const rest = Bun.argv.slice(3);
  const end = rest.indexOf("--");
  process.exit(await (await commandOf(sub))!(rest.map((a, i) => (a === "-h" && (end < 0 || i < end) ? "--help" : a))));
}

const args = Bun.argv.slice(2);
// A daemon a service manager runs is started again as soon as it exits (the unit's RestartSec is a tenth of
// a second, and its starts are not bounded: src/admin/unit.ts). One that could not start (a taken port, a
// state folder another daemon holds, a bad argument) would be started several times a second for as long as
// the unit is enabled: it waits before it exits, so the unit starts it again every two seconds or so, at no
// cost meanwhile. Only a start that failed: an exit after the daemon listened, or one with nothing wrong, does not wait.
const FAILED_START_WAIT_MS = 2000;
const starting = globalThis as { __keelListening?: boolean; __keelFailedStartWait?: boolean };
if (process.env.KEEL_SUPERVISED && !starting.__keelFailedStartWait) {
  starting.__keelFailedStartWait = true;
  process.on("exit", (code) => { if (code && !starting.__keelListening) Bun.sleepSync(FAILED_START_WAIT_MS); });
}
if (args[0] && args[0] !== "serve" && !args[0].startsWith("-")) process.exit((await import("./cli/help.ts")).unknownCommand(args[0]));
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
const { parseBind } = await import("./core/bind.ts");
const bind = parseBind(values.bind!);
if ("error" in bind) {
  console.error(`keel serve: ${bind.error}\n${SERVE_USAGE}`);
  process.exit(3);
}

const g = globalThis as { __keelSignals?: boolean; __keelStop?: (ms: number) => Promise<void>; __keelStartSaid?: boolean };
// Before anything is claimed or opened: the daemon runs without the runtime's collector timer, and with
// no secret in the environment it was started with (src/safety/closed-env.ts).
if (!g.__keelSignals) (await import("./core/relaunch.ts")).startClean();
// The scripted daemon of a pictures run: the same ids and clock in every run (src/core/fixed-world.ts).
// Only in a scratch folder no real daemon used, with no real provider to answer (src/core/fixed-world-gate.ts);
// otherwise it starts real and says why. A hot reload keeps the world it had.
const fixedAsked = process.env.KEEL_PICTURES_FIXED && process.env.KEEL_SCRIPTED_PROVIDER === "1" && values["state-dir"];
if (fixedAsked && (globalThis as { __keelFixedWorld?: number }).__keelFixedWorld === undefined) {
  const { fixedRefusal, realProviders } = await import("./core/fixed-world-gate.ts");
  const dir = values["state-dir"]!;
  const no = await fixedRefusal(dir, () => realProviders(dir));
  if (no) console.error(`keel serve: KEEL_PICTURES_FIXED is set, but the ids and clock stay real: ${no}.`);
  else (await import("./core/fixed-world.ts")).fixWorld(Number(process.env.KEEL_PICTURES_FIXED), dir);
}
const { startDaemon } = await import("./server/start.ts");
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
// When the daemon stops, running turns stop at their next step: a reply on its way
// gets this long to arrive. Then they are parked and the next daemon continues them.
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
starting.__keelListening = true;
console.log(`keel listening on ${d.url} (state ${d.stateDir})`);
if (!g.__keelStartSaid) {
  g.__keelStartSaid = true;
  const [{ startLine }, { buildId }, { configDir }] = await Promise.all([import("./admin/daemon-log.ts"), import("./core/build.ts"), import("./providers/config.ts")]);
  console.log(startLine({ revision: buildId(), pid: process.pid, url: d.url, state: d.stateDir, config: configDir() }));
}
// Where the start's time went (src/core/start-trace.ts).
const took = (await import("./core/start-trace.ts")).startTookLine();
if (took) console.log(took);
