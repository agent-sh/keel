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
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { providers.shutdown(); setTimeout(() => process.exit(0), 300); });
process.on("exit", () => providers.plugins.killAll());
const engine = new Engine(store, bus, providers, errors, join(stateDir, "spill"));
const server = serve(
  { store, bus, engine, providers, errors, workspace: resolve(values.workspace ?? process.cwd()) },
  { hostname: hostname!, port: Number(portStr), development: values.dev },
  routeModules,
);
providers.models().catch((e) => errors.capture("provider", e, { at: "startup listing" }));
console.log(`keel listening on ${server.url} (state ${stateDir})`);
