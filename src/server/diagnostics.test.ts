import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { emptyUsage } from "../core/types.ts";
import { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import type { ModelInfo, ProviderRequest } from "../providers/types.ts";
import { relayDiagnostics } from "./diagnostics.ts";
import { errorRoutes } from "./routes/errors.ts";

test("browser error capture counts only the exact ResizeObserver notice without recording it", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "browser-notice-"));
  const store = new Store(dir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const notice = "ResizeObserver loop completed with undelivered notifications.";
  const frames: string[] = [];
  bus.on((f) => { if (f.t === "error") frames.push(f.error.message); });
  try {
    const routes = errorRoutes({ store, bus, errors } as Parameters<typeof errorRoutes>[0]);
    const post = (message: string) => routes["/api/errors"]!.POST!(new Request("http://localhost/api/errors", {
      method: "POST",
      body: JSON.stringify({ message, context: { kind: "window.error" } }),
    }) as never, {} as never);
    const first = await post(notice);
    await post(notice);
    expect(store.errors(10)).toEqual([]);
    expect(frames).toEqual([]);
    expect(await first.json()).toEqual({ ok: true, ignored: true });
    const real = await post(`${notice} Then the page failed`);
    expect(real.status).toBe(201);
    expect(frames).toEqual([`${notice} Then the page failed`]);
    expect(errors.ignoredClientErrors()).toEqual({ resize_observer: 2 });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captured failures wake only the designated session with a bounded, safe batch", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "diagnostics-"));
  const store = new Store(dir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const s = store.createSession({ model: "fixture:test", workspace: dir, settings: { idle_compact: false } });
  const other = store.createSession({ model: s.model, workspace: dir, title: "fixture unrelated title" });
  const info: ModelInfo = { id: s.model, provider: "fixture", model: "test", name: "Fixture", family: "other", context: 100_000, output: 1_000, tools: false, efforts: [], billing: "unknown" };
  const requests: ProviderRequest[] = [];
  const busy = Promise.withResolvers<void>();
  const firstCall = Promise.withResolvers<void>();
  let diagnosticCall = Promise.withResolvers<void>();
  const provider = {
    async stream(req: ProviderRequest) {
      requests.push(req);
      if (requests.length === 1) {
        firstCall.resolve();
        await busy.promise;
      } else {
        // A fault with no explicit session from inside the diagnostic turn.
        await Promise.resolve();
        errors.capture("server", new Error("diagnostic callback failure"));
        diagnosticCall.resolve();
      }
      return { blocks: [{ type: "text", text: "ok" }], usage: emptyUsage(), stop: "end_turn" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }) } as unknown as Providers;
  const engine = new Engine(store, bus, providers, errors, dir);
  const deps = { store, bus, errors, engine, providers, workspace: dir };
  const options = { batchMs: 10, spacingMs: 20 };
  let stop: (() => void) | undefined;
  try {
    const old = errors.capture("server", new Error("before opt-in"));
    engine.send(s.id, "owner request already running");
    await firstCall.promise;
    stop = relayDiagnostics(deps, s.id, options);
    // Browser POST can record an error but cannot promote it to a paid wake,
    // even with a claimed source or if the daemon wrapper catches the failure.
    const routes = errorRoutes(deps);
    const post = routes["/api/errors"]!.POST!;
    const browserReport = () => post(new Request("http://localhost/api/errors", {
      method: "POST",
      body: JSON.stringify({ message: "fixture browser failure", stack: "fixture browser stack", context: { source: "provider" } }),
    }) as never, {} as never);
    const client = (await (await browserReport()).json()).id;
    const ingest = errors.capture("server", new Error("fixture browser report handler failure"), { url: "/api/errors", method: "POST" });
    const retry = errors.capture("provider", new Error("fixture provider failure"), { session: other.id, retry: 1, wait_ms: 1000 });
    errors.capture("provider", new Error("fixture provider failure"), { session: other.id });
    const own = errors.capture("tool", new Error("fixture coordinator failure"), { session: s.id });
    const daemonIds = "abcdefgh".split("").map((kind) => errors.capture("server", Object.assign(new Error(`fixture raw failure ${kind}`), { stack: "fixture raw stack" }), { session: other.id, token: "fixture private token" }).id);
    errors.capture("server", new Error("fixture raw failure a"), { session: other.id });
    bus.emit({ t: "error", error: old }); // read, resolve and replay use the same UI frame
    await Bun.sleep(30);
    expect(store.events(s.id).filter((e) => e.data.kind === "diagnostic")).toHaveLength(0);
    busy.resolve();
    await diagnosticCall.promise;
    await engine.idle(s.id);
    const transcript = store.events(s.id).filter((e) => e.data.kind === "diagnostic");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.data.text).toContain(`Provider: 1 occurrence (Errors ID: ${retry.id})`);
    expect(transcript[0]!.data.text).toContain(`Daemon: 2 occurrences (Errors ID: ${daemonIds[0]})`);
    expect(transcript[0]!.data.text).toContain("1 additional occurrence not listed");
    const sent = JSON.stringify(requests[1]!.messages);
    for (const secret of ["fixture raw", "fixture private token", other.id, other.title, old.id, own.id, client, ingest.id, daemonIds.at(-1)!]) expect(sent).not.toContain(secret);
    expect(sent).toContain(daemonIds[0]!);
    await Bun.sleep(40);
    expect(requests).toHaveLength(2);

    // Subsequent unattributed watchdog failures fold into the delivered
    // provider error but must not start a new coordinator turn each time.
    await browserReport();
    bus.emit({ t: "error", error: store.readError(retry.id, true)! }); // read is not resolved
    for (let n = 0; n < 3; n++) {
      const repeat = errors.capture("provider", new Error("fixture provider failure"), { at: "plugin watchdog" });
      expect(repeat.id).toBe(retry.id);
      await Bun.sleep(40);
    }
    expect(requests).toHaveLength(2);
    expect(store.error(client)?.count).toBe(2);

    diagnosticCall = Promise.withResolvers<void>();
    const independent = errors.capture("tool", new Error("fixture independent tool error"), { session: other.id });
    await diagnosticCall.promise;
    await engine.idle(s.id);
    expect(requests).toHaveLength(3);
    expect(store.events(s.id).findLast((e) => e.data.kind === "diagnostic")?.data.text).toContain(`Tool: 1 occurrence (Errors ID: ${independent.id})`);

    // Owner resolution opens the dedup gate, not a turn. A later watchdog
    // occurrence is reported again and keeps the same Errors ID.
    bus.emit({ t: "error", error: store.resolveError(retry.id, true)! });
    await Bun.sleep(40);
    expect(requests).toHaveLength(3);
    diagnosticCall = Promise.withResolvers<void>();
    errors.capture("provider", new Error("fixture provider failure"), { at: "plugin watchdog" });
    await diagnosticCall.promise;
    await engine.idle(s.id);
    expect(requests).toHaveLength(4);
    expect(store.events(s.id).findLast((e) => e.data.kind === "diagnostic")?.data.text).toContain(`Provider: 1 occurrence (Errors ID: ${retry.id})`);

    errors.capture("server", new Error("fixture pending when daemon stops"));
    bus.emit({ t: "feature", name: "daemon", data: { draining: true } });
    errors.capture("server", new Error("fixture during drain"));
    await Bun.sleep(30);
    stop();
    stop = relayDiagnostics(deps, s.id, options); // reattaching never reads old rows
    await Bun.sleep(30);
    expect(requests).toHaveLength(4);
    expect(store.events(other.id)).toHaveLength(0);
    expect(store.error(retry.id)?.count).toBe(6);
  } finally {
    busy.resolve();
    stop?.();
    await engine.drain(0);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
