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
  const diagnosticCall = Promise.withResolvers<void>();
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
    // Browser errors take the same path as production. Raw strings and the
    // unrelated session's metadata must not reach the destination provider.
    const post = errorRoutes(deps)["/api/errors"]!.POST!;
    const r = await post(new Request("http://localhost/api/errors", {
      method: "POST",
      body: JSON.stringify({ message: "fixture raw failure", stack: "fixture raw stack", context: { session: other.id, token: "fixture private token" } }),
    }) as never, {} as never);
    const client = (await r.json()).id;
    errors.capture("client", new Error("fixture raw failure"), { session: other.id });
    const retry = errors.capture("provider", new Error("fixture provider failure"), { session: other.id, retry: 1, wait_ms: 1000 });
    errors.capture("provider", new Error("fixture provider failure"), { session: other.id });
    const own = errors.capture("tool", new Error("fixture coordinator failure"), { session: s.id });
    const daemonIds = "abcdefg".split("").map((kind) => errors.capture("server", new Error(`fixture daemon failure ${kind}`)).id);
    bus.emit({ t: "error", error: old }); // read, resolve and replay use the same UI frame
    await Bun.sleep(30);
    expect(store.events(s.id).filter((e) => e.data.kind === "diagnostic")).toHaveLength(0);
    busy.resolve();
    await diagnosticCall.promise;
    await engine.idle(s.id);
    const transcript = store.events(s.id).filter((e) => e.data.kind === "diagnostic");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]!.data.text).toContain(`Browser: 2 occurrences (Errors ID: ${client})`);
    expect(transcript[0]!.data.text).toContain(`Provider: 1 occurrence (Errors ID: ${retry.id})`);
    expect(transcript[0]!.data.text).toContain(`Daemon: 1 occurrence (Errors ID: ${daemonIds[0]})`);
    expect(transcript[0]!.data.text).toContain("1 additional occurrence not listed");
    const sent = JSON.stringify(requests[1]!.messages);
    for (const secret of ["fixture raw", "fixture private token", other.id, other.title, old.id, own.id, daemonIds.at(-1)!]) expect(sent).not.toContain(secret);
    expect(sent).toContain(client);
    await Bun.sleep(40);
    expect(requests).toHaveLength(2);

    errors.capture("server", new Error("fixture pending when daemon stops"));
    bus.emit({ t: "feature", name: "daemon", data: { draining: true } });
    errors.capture("server", new Error("fixture during drain"));
    await Bun.sleep(30);
    stop();
    stop = relayDiagnostics(deps, s.id, options); // reattaching never reads old rows
    await Bun.sleep(30);
    expect(requests).toHaveLength(2);
    expect(store.events(other.id)).toHaveLength(0);
    expect(store.errors()).toHaveLength(14);
  } finally {
    busy.resolve();
    stop?.();
    await engine.drain(0);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
