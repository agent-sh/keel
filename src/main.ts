#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Bus } from "./core/bus.ts";
import { ErrorTracker } from "./core/errors.ts";
import { Store } from "./core/store.ts";
import { Engine } from "./engine/turn.ts";
import { Providers } from "./providers/registry.ts";
import { serve } from "./server/app.ts";
import { routeModules } from "./server/routes/index.ts";
import { commands } from "./cli/index.ts";

// Client commands (keel pair, keel notify, ...) parse their own options.
const sub = Bun.argv[2];
if (sub && commands[sub]) process.exit(await commands[sub](Bun.argv.slice(3)));

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    bind: { type: "string", default: "127.0.0.1:47960" },
    "state-dir": { type: "string" },
    workspace: { type: "string" },
    dev: { type: "boolean", default: false },
  },
});

const cmd = positionals[0] ?? "serve";
if (cmd !== "serve") {
  console.error(`unknown command: ${cmd}\nusage: keel serve [--bind host:port] [--state-dir DIR] [--workspace DIR] [--dev]\n       keel ${Object.keys(commands).join("|")} --help`);
  process.exit(2);
}

const stateDir = resolve(values["state-dir"] ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "keel-bun"));
const [hostname, portStr] = values.bind!.split(/:(?=\d+$)/);
const store = new Store(stateDir);
const bus = new Bus();
const errors = new ErrorTracker(store, bus);
errors.installGlobal();
const providers = new Providers(stateDir, { capture: (source, e, ctx) => errors.capture(source, e, ctx) });
providers.start();
const engine = new Engine(store, bus, providers, errors, join(stateDir, "spill"));
// Running turns get this long to end by themselves when the daemon stops; the
// rest are parked and the next daemon continues them.
const DRAIN_MS = Number(process.env.KEEL_DRAIN_MS ?? 10_000);
const g = globalThis as { __keelEngine?: Engine; __keelSignals?: boolean };
// A hot reload builds a new engine in the same process: the old one parks its turns first.
if (g.__keelEngine) await g.__keelEngine.drain(0);
g.__keelEngine = engine;
if (!g.__keelSignals) {
  g.__keelSignals = true;
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (stopping) return process.exit(0); // a second signal stops at once
      stopping = true;
      await g.__keelEngine!.drain(DRAIN_MS).catch((e) => errors.capture("server", e, { at: "drain" }));
      providers.shutdown();
      setTimeout(() => process.exit(0), 300);
    });
  }
}
process.on("exit", () => providers.plugins.killAll());
const server = serve(
  { store, bus, engine, providers, errors, workspace: resolve(values.workspace ?? process.cwd()) },
  { hostname: hostname!, port: Number(portStr), development: values.dev },
  routeModules,
);
providers.models().catch((e) => errors.capture("provider", e, { at: "startup listing" }));
// Turns the last daemon left open or parked continue; a model whose provider is
// still starting (a plugin) is waited for, up to a minute.
void engine.recover(store.bootWorking, async (model) => {
  for (let i = 0; ; i++) {
    try { await providers.resolve(model); return; } catch (e) { if (i >= 12) throw e; }
    await Bun.sleep(5_000);
  }
}).catch((e) => errors.capture("server", e, { at: "recover" }));
console.log(`keel listening on ${server.url} (state ${stateDir})`);
