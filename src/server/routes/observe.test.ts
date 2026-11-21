// The observe routes over a real store, where the e2e cannot reach: a session
// with more traces than a list may return.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { observeRoutes } from "./observe.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "observe-routes-"));
const store = new Store(dir);
const routes = observeRoutes({ store, bus: new Bus(), engine: { isRunning: () => false, statusOf: () => undefined }, providers: {}, errors: { capture: () => {} }, workspace: dir } as any) as any;
const G = globalThis as any;
afterAll(() => {
  clearInterval(G.__keelSpanPrune);
  G.__keelOtlp?.stop();
  G.__keelOtlpOff?.();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the trace list takes a whole number from 1, gives 50 by default and never more than 200", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const now = Date.now();
  const add = store.db.prepare("INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, attrs) VALUES (?, ?, ?, 'turn', 'invoke_agent', ?, ?, 'ok', '{}')");
  for (let i = 0; i < 250; i++) add.run(i.toString(16).padStart(16, "0"), i.toString(16).padStart(32, "0"), s.id, now - i * 1000, now - i * 1000 + 5);
  const list = (limit?: string) => routes["/api/debug/traces"].GET(new Request(`http://x/api/debug/traces?session_id=${s.id}${limit === undefined ? "" : `&limit=${limit}`}`)) as Response;
  const count = async (limit?: string) => ((await list(limit).json()) as any).traces.length;

  for (const bad of ["-1", "2.5", "0", "abc", "", "1e2"]) {
    const r = list(bad);
    expect([bad, r.status]).toEqual([bad, 400]);
    expect(((await r.json()) as any).error).toContain("whole number");
  }
  expect(await count()).toBe(50);
  expect(await count("3")).toBe(3);
  expect(await count("200")).toBe(200);
  expect(await count("100000")).toBe(200);
  expect(await count("99999999999999999999999999")).toBe(200);
  // Newest first.
  expect(((await list("1").json()) as any).traces[0].span_id).toBe("0".repeat(16));
});

test("a retry whose kept request aged out is not offered for replay, and says why when asked", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  store.db.run("INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs) VALUES ('lone-retry', 'trace-lone-retry', ?, 'request', 'chat m', ?, ?, 'error', 'HTTP 529', 'overloaded', ?)", [s.id, Date.now() - 10, Date.now(), JSON.stringify({ request_in: "aged-out" })]);
  const at = (method: "GET" | "POST", path: string) => {
    const r = new Request(`http://x/api/debug/spans/lone-retry${path}`, { method }) as any;
    r.params = { id: "lone-retry" };
    return routes[`/api/debug/spans/:id${path}`][method](r) as Promise<Response>;
  };
  expect(((await (await at("GET", "")).json()) as any).span.replayable).toBe(false);
  const r = await at("POST", "/replay");
  expect(r.status).toBe(409);
  expect(((await r.json()) as any).error).toContain("aged out");
});
