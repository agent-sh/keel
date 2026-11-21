// Starting the daemon: `keel serve`, and the daemon a client command starts in
// its own process when none answers (runMode.client).
import { endStreams } from "./streams.ts";
import { join, resolve } from "node:path";
import { defaultStateDir } from "../core/paths.ts";
import { acquireLock, recordUrl } from "../admin/daemon.ts";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { runMode } from "../core/runmode.ts";
import { Store } from "../core/store.ts";
import { Engine } from "../engine/turn.ts";
import { Providers } from "../providers/registry.ts";
import { serve } from "./app.ts";
import { routeModules } from "./routes/index.ts";
import { portHolder, waitForPredecessor } from "../admin/daemon.ts";
import { relayDiagnostics } from "./diagnostics.ts";

export { defaultStateDir };

export type Started = { url: string; stateDir: string; engine: Engine; stop: (drainMs?: number) => Promise<void> };

export async function startDaemon(opts: { stateDir?: string; bind: string; workspace?: string; dev?: boolean; client?: boolean }): Promise<Started> {
  runMode.client = !!opts.client;
  const stateDir = resolve(opts.stateDir ?? defaultStateDir());
  const [hostname, portStr] = opts.bind.split(/:(?=\d+$)/);
  // Once per process (a hot reload serves the same port again): a port that
  // something already answers on is refused, after a restart's old daemon is gone.
  if (!(globalThis as { __keelEngine?: unknown }).__keelEngine && Number(portStr) !== 0) {
    waitForPredecessor();
    const holder = await portHolder(hostname!, Number(portStr));
    if (holder) {
      console.error(`keel: ${opts.bind} is already in use by ${holder}; pick another --bind or stop it first`);
      process.exit(1);
    }
  }
  // The state folder is claimed before anything of it is opened: a second
  // daemon on it stops here, with the database untouched.
  acquireLock(stateDir);
  const store = new Store(stateDir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  errors.installGlobal();
  const providers = new Providers(stateDir, { capture: (source, e, ctx) => errors.capture(source, e, ctx) });
  const engine = new Engine(store, bus, providers, errors, join(stateDir, "spill"));
  const g = globalThis as { __keelEngine?: Engine; __keelStopDiagnostics?: () => void };
  // A hot reload builds a new engine in the same process: the old one parks its turns first.
  // It is replaced first, so a turn the old one would start meanwhile starts here.
  const old = g.__keelEngine;
  g.__keelStopDiagnostics?.();
  g.__keelEngine = engine;
  if (old) {
    await old.drain(0);
    endStreams();
  }
  const diagnosticSession = !opts.client && process.env.KEEL_DIAGNOSTIC_SESSION?.trim();
  const stopDiagnostics = diagnosticSession ? relayDiagnostics({ store, bus, errors, engine }, diagnosticSession) : undefined;
  g.__keelStopDiagnostics = stopDiagnostics;
  providers.start();
  process.on("exit", () => providers.plugins.killAll());
  const server = serve(
    { store, bus, engine, providers, errors, workspace: resolve(opts.workspace ?? process.cwd()) },
    { hostname: hostname!, port: Number(portStr), development: opts.dev },
    routeModules,
  );
  const url = server.url.href.replace(/\/+$/, "");
  recordUrl(stateDir, url, !!opts.client);
  // A client's daemon recovers nothing; the sessions the last daemon left
  // working are idle again, as no turn runs in them.
  if (opts.client) for (const id of store.bootWorking) store.bootSettled(id);
  if (!opts.client) {
    providers.models().catch((e) => errors.capture("provider", e, { at: "startup listing" }));
    // Turns the last daemon left open or parked continue; a model whose provider is
    // still starting (a plugin) is waited for, up to a minute.
    void engine.recover(store.bootWorking, async (model) => {
      for (let i = 0; ; i++) {
        try { await providers.resolve(model); return; } catch (e) { if (i >= 12) throw e; }
        await Bun.sleep(5_000);
      }
    }).catch((e) => errors.capture("server", e, { at: "recover" }));
    void providers.models().then(() => engine.resumeIdle()).catch((e) => errors.capture("server", e, { at: "idle compaction" }));
  }
  const stop = async (drainMs = 0) => {
    stopDiagnostics?.();
    await engine.drain(drainMs).catch((e) => errors.capture("server", e, { at: "drain" }));
    providers.shutdown();
    server.stop(true);
  };
  return { url, stateDir, engine, stop };
}
