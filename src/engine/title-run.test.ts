// The title request as the engine sends it (src/engine/title.ts): after the
// turn, never part of the session's status, never on the session's own model,
// and made again when the first prompt changed while one was out.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { TurnStatus } from "../core/types.ts";
import { ProviderError } from "../providers/http.ts";
import { Engine } from "./turn.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const model = (name: string, input: number) => ({ id: `p:${name}`, provider: "p", model: name, name, family: "other", context: 100_000, output: 4_000, efforts: [], billing: "per_token", price: { input, output: input * 5 } });
const BIG = model("big", 10), SMALL = model("small", 1);
const said = (text: string) => ({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" });

// `title(req, n)`: the answer to the n-th title request (it may throw or wait).
function rig(listed: any[], title: (req: any, n: number) => Promise<any>, turn: (req: any) => Promise<any> = async () => said("Done.")) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "title-run-"));
  dirs.push(dir);
  const store = new Store(dir);
  const bus = new Bus();
  const asked: any[] = [];
  let n = 0;
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => { asked.push(req); return req.purpose === "title" ? title(req, n++) : turn(req); },
  };
  const providers = { resolve: async (id: string) => ({ provider, info: listed.find((m) => m.id === id) ?? BIG }), models: async () => listed, current: () => listed };
  const engine = new Engine(store, bus, providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
  const s = store.createSession({ model: BIG.id, workspace: dir });
  const statuses: TurnStatus[] = [];
  bus.on((f: any) => { if (f.t === "status" && f.session_id === s.id) statuses.push(f.status); });
  return { store, engine, s, asked, statuses, titled: (t: string) => waitFor(() => store.session(s.id)!.title === t) };
}

async function waitFor(ok: () => boolean, ms = 3_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (ok()) return;
  throw new Error("timed out");
}

test("a title request that is retried says nothing in the session's status", async () => {
  const busy = new ProviderError("overloaded", "overloaded", 529, 1);
  const { engine, s, statuses, titled } = rig([BIG, SMALL], async (_req, n) => { if (n === 0) throw busy; return said("Cart discounts"); });
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  const after = statuses.length;
  await titled("Cart discounts");
  expect(statuses.slice(after)).toEqual([]);
});
