// Every model request is a row of the ledger with what its stream reported and
// what that cost: the policy judge's verdict and its time limit, a turn stopped
// after its stream counted the prompt, an attempt whose stream broke and the
// retry after it (each attempt once, with its own counts). The real engine,
// provider registry and ledger, with the scripted stand-in as the model.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { Providers } from "../providers/registry.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { askJudge, makeJudge } from "../safety/judge.ts";
import { Telemetry } from "./telemetry.ts";

setDefaultTimeout(20_000);
// The stand-in answers only where scripted models are turned on.
ownEnv({ KEEL_SCRIPTED_PROVIDER: "1" });
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ledger-requests-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const state = join(dir, "state");
const store = new Store(state);
if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
const bus = new Bus();
const telemetry = new Telemetry(store, bus);
const scripted = new ScriptedProvider(state);
// The requests the stand-in has begun to answer, so a test stops one only after its stream began.
const begun: ProviderRequest[] = [];
const stream = scripted.stream.bind(scripted);
scripted.stream = (req, d) => { begun.push(req); return stream(req, d); };
const providers = new Providers(state, { providers: [scripted], capture: () => {} });
providers.catalog.load = async () => {};
const errors = { capture: (_s: string, e: unknown) => ({ id: "captured", message: String((e as Error)?.message ?? e) }), recovered: () => {} };
const engine = new Engine(store, bus, providers as any, errors as any, join(dir, "spill"));
(engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
const MODEL = "scripted:stand-in";
// The stand-in's listed price, dollars a million tokens.
const PRICE = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
const costOf = (r: Row) => (r.input * PRICE.input + r.output * PRICE.output + r.cache_read * PRICE.cache_read + r.cache_write * PRICE.cache_write) / 1e6;

type Row = { purpose: string | null; outcome: string; attempt: number | null; model: string; input: number; output: number; cache_read: number; cache_write: number; cost: number | null };
const rows = (sessionId: string): Row[] => {
  store.side.flush();
  return store.db.query<Row, [string]>("SELECT purpose, outcome, attempt, model, input, output, cache_read, cache_write, cost FROM telemetry_calls WHERE session_id = ? ORDER BY id").all(sessionId);
};
const session = (title: string) => store.createSession({ model: MODEL, workspace: dir, title });

test("an attempt whose stream broke is a row with what it reported, and its retry one of its own", async () => {
  const s = session("Retry");
  engine.send(s.id, "script:drop");
  await engine.idle(s.id);
  const r = rows(s.id).filter((x) => (x.purpose ?? "turn") === "turn");
  expect(r.map((x) => [x.attempt, x.outcome])).toEqual([[1, "error"], [2, "ok"]]);
  // Each attempt with its own stream's counts, priced: nothing carried from one to the next.
  for (const x of r) {
    expect(x.input + x.cache_read).toBeGreaterThan(0);
    expect(x.cost).toBeCloseTo(costOf(x), 12);
  }
  expect(r[0]!.output).toBeGreaterThan(0);
  // The session's own total is what the ledger holds of it.
  const u = store.session(s.id)!.usage;
  expect([u.input, u.output, u.cache_read]).toEqual(["input", "output", "cache_read"].map((k) => r.reduce((n, x) => n + (x as any)[k], 0)));
});

test("a turn stopped after its stream counted the prompt is a row with those tokens and their cost", async () => {
  const s = session("Stopped");
  const at = begun.length;
  engine.send(s.id, `script:started ${join(dir, "never")}`);
  for (let i = 0; i < 200 && !begun.slice(at).some((q) => q.sessionKey === s.id); i++) await Bun.sleep(10);
  await engine.interrupt(s.id, "owner");
  await engine.idle(s.id);
  const [row, ...more] = rows(s.id);
  expect(more).toEqual([]);
  expect(row).toMatchObject({ purpose: "turn", outcome: "interrupted", input: 1_000, cache_read: 50_000, model: MODEL });
  expect(row!.cost).toBeCloseTo(0.006, 12);
});

test("a judge's verdict and a judge cut by its time limit are rows of the session they judged", async () => {
  const s = session("Judged");
  const judge = makeJudge(store, providers, () => MODEL);
  const v = await judge({ session: store.session(s.id)!, tool: "Write", kind: "write", summary: "judge-allow.txt", input: {} });
  expect(v).toMatchObject({ allow: true });
  const text = "The owner's recent messages (oldest first):\n- write it\n\nThe action: tool Write (write)\njudge-slow.txt";
  await expect(askJudge(providers, MODEL, { system: "Judge the action.", text }, `judge-${s.id}`, 300, store.session(s.id)!)).rejects.toThrow();
  const r = rows(s.id);
  expect(r.map((x) => [x.purpose, x.outcome, x.model])).toEqual([["judge", "ok", MODEL], ["judge", "error", MODEL]]);
  for (const x of r) {
    expect(x.input + x.cache_read).toBeGreaterThan(0);
    expect(x.cost).toBeCloseTo(costOf(x), 12);
  }
});

test("the day's spend is the sum of the ledger's rows", () => {
  store.side.flush();
  const { sum } = store.db.query<{ sum: number }, []>("SELECT COALESCE(SUM(cost), 0) AS sum FROM telemetry_calls").get()!;
  expect(sum).toBeGreaterThan(0.006);
  telemetry.spendChanged();
  expect(telemetry.spend().day.usd).toBeCloseTo(sum, 12);
});

test("a judge's request is counted in the session's total and does not move it in the list", async () => {
  const s = session("Judge keeps its place");
  const before = store.session(s.id)!;
  // A later clock, so a moved session would show it.
  await Bun.sleep(5);
  const judge = makeJudge(store, providers, () => MODEL);
  await judge({ session: before, tool: "Write", kind: "write", summary: "judge-allow.txt", input: {} });
  const after = store.session(s.id)!;
  const r = rows(s.id);
  expect(r.length).toBe(1);
  expect([after.usage.input, after.usage.cache_read]).toEqual([r[0]!.input, r[0]!.cache_read]);
  expect(after.usage.input + after.usage.cache_read).toBeGreaterThan(0);
  expect(after.updated).toBe(before.updated);
});
