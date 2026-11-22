// Starting the daemon: `keel serve`, and the daemon a client command starts in
// its own process when none answers (runMode.client).
import { endStreams } from "./streams.ts";
import { setGitViews } from "../core/git.ts";
import { join, resolve } from "node:path";
import { defaultStateDir } from "../core/paths.ts";
import { acquireLock, recordUrl } from "../admin/daemon.ts";
import { undoCutRestore } from "../admin/storage.ts";
import { parseBind } from "../core/bind.ts";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { runMode } from "../core/runmode.ts";
import { Checkpointer } from "../core/checkpoint.ts";
import { Store } from "../core/store.ts";
import { storeLocked } from "../core/store-files.ts";
import { Engine } from "../engine/turn.ts";
import { Providers } from "../providers/registry.ts";
import { serve } from "./app.ts";
import { readsOf } from "./reads.ts";
import { routeModules } from "./routes/index.ts";
import { portHolder, waitForLeaving } from "../admin/daemon.ts";
import { relayDiagnostics } from "./diagnostics.ts";
import { beginLife, lifeListening, Restarts } from "../admin/life.ts";
import { drainLine, exitLine, providersLine, say } from "../admin/daemon-log.ts";
import { beginWatch, during, timed } from "../admin/stall.ts";
import { newestTurn } from "../admin/marks.ts";
import { originOf } from "../admin/timeline-rows.ts";

export { defaultStateDir };

// What a session went on with when the turn a restart cut was not the one
// continued: its newer turn and who started it, or why nothing could go on.
// Nothing when the session is as the cut left it.
function wentOn(store: Store, engine: Engine, sessionId: string, cutTurn: string): string | undefined {
  const s = store.session(sessionId);
  if (!s) return "not continued: its session was deleted";
  const newest = newestTurn(store, sessionId);
  if (!newest || newest.id === cutTurn) return s.archived ? "not continued: its session was archived" : engine.isRunning(sessionId) ? "went on: a turn is starting in it" : undefined;
  // The prompt before the newer turn's start, past the notes between, says who started it.
  let e = store.event(newest.id);
  for (let hops = 0; e?.parent && hops < 32; hops++) {
    e = store.event(e.parent);
    if (!e || (e.kind !== "note" && e.kind !== "compaction")) break;
  }
  return `went on in a turn started by ${e?.kind === "user" ? originOf(e.data).words : "something else"}`;
}

export type Started = { url: string; stateDir: string; engine: Engine; stop: (drainMs?: number) => Promise<void> };

export async function startDaemon(opts: { stateDir?: string; bind: string; workspace?: string; dev?: boolean; client?: boolean }): Promise<Started> {
  runMode.client = !!opts.client;
  const stateDir = resolve(opts.stateDir ?? defaultStateDir());
  const bind = parseBind(opts.bind);
  if ("error" in bind) throw new Error(bind.error);
  const { hostname, port } = bind;
  // Once per process (a hot reload serves the same port again): a port that
  // something already answers on is refused, after a restart's old daemon is
  // gone and one that was killed has left.
  if (!(globalThis as { __keelEngine?: unknown }).__keelEngine && port !== 0) {
    waitForLeaving(stateDir);
    const holder = await portHolder(hostname, port);
    if (holder) {
      console.error(`keel: ${opts.bind} is already in use by ${holder}; pick another --bind or stop it first`);
      process.exit(1);
    }
  }
  // The state folder is claimed before anything of it is opened: a second
  // daemon on it stops here, with the database untouched.
  acquireLock(stateDir);
  const cut = undoCutRestore(stateDir);
  if (cut === "undone") console.error(`keel: a restore of a backup into ${stateDir} was cut part way. It was undone: the state is the one before it.`);
  if (cut === "unreadable") console.error(`keel: restore.pending in ${stateDir} could not be read, so nothing was undone: the state is as it was found. The file is now restore.pending.unreadable, and what a restore moved aside is in the before-restore folders.`);
  // How the daemon before this one ended, read before this one leaves its own
  // sign of life. A command's own daemon is not the machine's: it keeps none.
  const life = opts.client ? undefined : beginLife(stateDir);
  // The daemon's git calls keep their views of repositories here, where a confined command cannot write.
  setGitViews(stateDir);
  const store = new Store(stateDir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  errors.installGlobal();
  // The log is synced and checkpointed on a thread, not in the commit that
  // fills it (a hot reload's old store gives its thread up first).
  // A session that is not in memory has its pages read by the read thread before the loop reads them.
  store.offLoop = (sql, params) => readsOf(store).readAhead(sql, params);
  // The daemon's lock on its store, looked at in the kernel's table twice a
  // minute: a lock that is gone (some code of this process closed a
  // descriptor of keel.db: src/core/store-files.ts) is said once, loudly.
  if (storeLocked(stateDir)) {
    const watch = setInterval(() => {
      if (storeLocked(stateDir) !== false) return;
      clearInterval(watch);
      errors.capture("server", new Error("The daemon no longer holds its lock on its store (keel.db): something in this process opened the file outside SQLite and closed it. Until the daemon is restarted, another program that opens the store read-write and closes it can remove the store's log, and what is written after that is lost. Restart the daemon now (keel restart)."), { at: "store lock" });
    }, 30_000);
    watch.unref?.();
  }
  const threads = globalThis as { __keelCheckpointer?: Checkpointer };
  threads.__keelCheckpointer?.stop();
  (threads.__keelCheckpointer = new Checkpointer(store, (e) => errors.capture("server", e, { at: "checkpoint thread" }))).start();
  const providers = new Providers(stateDir, { capture: (source, e, ctx) => errors.capture(source, e, ctx) });
  const engine = new Engine(store, bus, providers, errors, join(stateDir, "spill"));
  engine.wentDown = life?.before?.down_ms;
  // Before any module: the turns this start finds cut are recorded whoever closes them.
  const restarts = life ? new Restarts(store, life) : undefined;
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
    { hostname, port, development: opts.dev },
    routeModules,
  );
  const url = server.url.href.replace(/\/+$/, "");
  recordUrl(stateDir, url, !!opts.client);
  // It answers from here on: its sign of life says so, and only now is a late
  // timer a stall (the start-up before this is not one).
  lifeListening();
  beginWatch();
  // A client's daemon recovers nothing; the sessions the last daemon left
  // working are idle again, as no turn runs in them.
  if (opts.client) for (const id of store.bootWorking) store.bootSettled(id);
  if (!opts.client) {
    providers.models().then(async () => {
      // One line of what the first listing found: the providers with credentials and their models, and the ones whose listing failed.
      // A key nobody has looked for yet counts as there: the line waits for the look, a bounded time.
      await providers.looked(15_000);
      // Once a process: a hot reload lists again and has nothing new to say.
      const said = globalThis as { __keelProvidersSaid?: boolean };
      if (said.__keelProvidersSaid) return;
      said.__keelProvidersSaid = true;
      const count = new Map<string, number>();
      for (const m of providers.current()) count.set(m.provider, (count.get(m.provider) ?? 0) + 1);
      const all = providers.statuses();
      const failed = all.filter((s) => s.available && providers.listing(s.id).state === "failed").map((s) => s.id);
      say(providersLine({ available: all.filter((s) => s.available && !failed.includes(s.id)).map((s) => ({ id: s.id, models: count.get(s.id) ?? 0 })), failed, unset: all.filter((s) => !s.available).length }));
    }).catch((e) => errors.capture("provider", e, { at: "startup listing" }));
    // Turns the last daemon left open or parked continue; a model whose provider is
    // still starting (a plugin) is waited for, up to a minute.
    // The recovery reads the branch of every session before its first await,
    // while the daemon already listens: timed, so a stall it makes is named.
    void timed(() => "the start's recovery read every session's branch", () => during("the start's recovery", engine.recover(store.bootWorking, async (model) => {
      for (let i = 0; ; i++) {
        try { await providers.resolve(model); return; } catch (e) { if (i >= 12) throw e; }
        await Bun.sleep(5_000);
      }
    }))).catch((e) => errors.capture("server", e, { at: "recover" }))
      // Every cut turn is decided: one that nobody settled went on by other means when its session has a newer turn.
      .then(() => restarts?.finish((id, cut) => wentOn(store, engine, id, cut.turn_event)))
      .catch((e) => errors.capture("server", e, { at: "restart record" }));
  }
  // From here the loop serves: a session read whole on it holds everyone, and is counted as that
  // (Store.coldReads). What the start read before this, the recovery's first reads included, held nobody.
  store.serving = true;
  if (!opts.client) {
    // The sessions used in the last hour have their rows brought into memory, off the loop and one
    // after another: after a start nothing is, and the first reader that cannot wait (a report sent
    // into a session, a hook at a turn's end) would read its session whole where the loop waits.
    void during("the start's pass bringing the rows of sessions used in the last hour into memory", (async () => {
      const recent = store.db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE archived = 0 AND updated >= ? ORDER BY updated DESC LIMIT 200").all(Date.now() - 3_600_000);
      for (const { id } of recent) {
        const kept = store.keptEvents();
        if (kept.bytes > kept.budget / 2) break;
        await store.warm(id, false);
        await new Promise((r) => setImmediate(r));
      }
    })()).catch((e) => errors.capture("server", e, { at: "warming recent sessions" }));
    // It reads the context of every session used in the last hour, an await a session.
    void providers.models().then(() => during("the start's pass over the sessions used in the last hour (idle compaction)", engine.resumeIdle())).catch((e) => errors.capture("server", e, { at: "idle compaction" }));
  }
  const stop = async (drainMs = 0) => {
    stopDiagnostics?.();
    // The stop's two lines in the log: what it waits for, and what it parked.
    const running = store.db.query<{ id: string }, []>("SELECT id FROM sessions").all().filter((r) => engine.isRunning(r.id)).length;
    const up = Date.now() - ((globalThis as { __keelStarted?: number }).__keelStarted ?? Date.now());
    say(drainLine({ restart: false, running, timeoutMs: drainMs, reason: "a stop signal" }));
    let parked = 0;
    const off = bus.on((f) => { if (f.t === "event" && f.event.kind === "turn_end" && f.event.data?.reason === "restart") parked++; });
    await engine.drain(drainMs).catch((e) => errors.capture("server", e, { at: "drain" }));
    off();
    say(exitLine({ restart: false, parked, upMs: up }));
    providers.shutdown();
    server.stop(true);
  };
  return { url, stateDir, engine, stop };
}
