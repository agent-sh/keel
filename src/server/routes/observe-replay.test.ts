// A replay sends a paid request again: the ledger books it with its session (purpose side, what its
// stream reported and its cost), and the span it leaves is the one the measuring hooks made, marked
// as the replay of the failed one. The real route, tracer, ledger and provider registry, with the
// scripted stand-in as the model.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../../test/env.ts";
import { Telemetry } from "../../admin/telemetry.ts";
import { packRequest } from "../../admin/trace.ts";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { Providers } from "../../providers/registry.ts";
import { ScriptedProvider } from "../../providers/scripted.ts";
import { observeRoutes } from "./observe.ts";

setDefaultTimeout(20_000);
ownEnv({ KEEL_SCRIPTED_PROVIDER: "1" });
const hooksAtStart = allHooks().length;
const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "observe-replay-"));
const store = new Store(dir);
const bus = new Bus();
new Telemetry(store, bus);
const providers = new Providers(dir, { providers: [new ScriptedProvider(dir)], capture: () => {} });
providers.catalog.load = async () => {};
const routes = observeRoutes({ store, bus, engine: { isRunning: () => false, statusOf: () => undefined }, providers, errors: { capture: () => {} }, workspace: dir } as any) as any;
const G = globalThis as any;
afterAll(() => {
  clearInterval(G.__keelSpanPrune);
  G.__keelOtlp?.stop();
  G.__keelOtlpMore?.();
  allHooks().length = hooksAtStart;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a replay is a row of the ledger, booked to the span's session, and its span is the replay's", async () => {
  const MODEL = "scripted:stand-in";
  const s = store.createSession({ workspace: dir, model: MODEL });
  const kept = packRequest({ model: "stand-in", route: MODEL, system: "A stand-in system prompt.", messages: [{ role: "user", content: [{ type: "text", text: "say something" }] }], tools: [] } as any)!;
  store.db.run("INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, request, attrs) VALUES ('failed-one', 'trace-failed-one', ?, 'request', 'chat stand-in', ?, ?, 'error', 'HTTP 529', 'overloaded', ?, ?)",
    [s.id, Date.now() - 10, Date.now(), kept, JSON.stringify({ route: MODEL })]);
  const rows = () => { store.side.flush(); return store.db.query<any, [string]>("SELECT purpose, outcome, model, input, output, cache_read, cost FROM telemetry_calls WHERE session_id = ?").all(s.id); };
  expect(rows()).toEqual([]);

  const req = new Request("http://x/api/debug/spans/failed-one/replay", { method: "POST", body: "{}" }) as any;
  req.params = { id: "failed-one" };
  const body = (await (await routes["/api/debug/spans/:id/replay"].POST(req)).json()) as any;
  expect(body.ok).toBe(true);
  expect(body.span.attrs.replay_of).toBe("failed-one");

  const r = rows();
  expect(r.length).toBe(1);
  expect(r[0]).toMatchObject({ purpose: "side", outcome: "ok", model: MODEL });
  expect(r[0].input + r[0].cache_read).toBeGreaterThan(0);
  expect(r[0].cost).toBeGreaterThan(0);
  // The session's own total holds it, and the replay is one span, not two.
  expect(store.session(s.id)!.usage.cost).toBeCloseTo(r[0].cost, 12);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM spans WHERE session_id = ? AND span_id != 'failed-one'").get(s.id)!.n).toBe(1);
});
