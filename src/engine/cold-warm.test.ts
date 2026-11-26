// Whether a session's cache is cold is read from its context alone (the last checkpoint and what
// follows it), so asking it after a restart brings in no body from before that checkpoint. A long
// coordinator whose prompt is compared again at a daemon's start read every body it ever stored
// (all of its history, not its context) and held them in memory for half an hour.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import { allHooks } from "./hooks.ts";
import { Engine } from "./turn.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "cold-warm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const work = join(dir, "work");
mkdirSync(work, { recursive: true });
ownEnv({ KEEL_SCRIPTED_CACHE: "prefix" });

function rig() {
  const store = new Store(join(dir, "state"));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const scripted = new ScriptedProvider();
  const info = { id: "scripted:stand-in", provider: "scripted", model: "stand-in", name: "Scripted stand-in", family: "other", context: 1_000_000, output: 2_000, tools: false, efforts: [], billing: "unknown" };
  const sent: ProviderRequest[] = [];
  const provider = { id: "scripted", family: "other" as const, available: () => true, list: () => scripted.list(), stream: (req: ProviderRequest, d: any) => { sent.push(req); return scripted.stream(req, d); } };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const errors = { capture: (_s: string, e: unknown) => ({ id: "captured", message: String((e as Error)?.message ?? e) }) };
  const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
  return { store, engine, sent };
}

test("a start that asks whether a session's cache is cold reads no body from before its last checkpoint", async () => {
  const file = join(work, "AGENTS.md");
  writeFileSync(file, "# Rules\n\nAnswer in one line.\n");
  const first = rig();
  const s = first.store.createSession({ model: "scripted:stand-in", workspace: work, title: "Long" });
  const run = async (e: Engine, text: string) => { e.send(s.id, text); await e.idle(s.id); };
  // A long history: forty prompts of 60 KB each (bodies are read in runs of 64 events), then a compaction, then a short context.
  const big = "x".repeat(60_000);
  for (let i = 0; i < 40; i++) await run(first.engine, `old prompt ${i} ${big}`);
  await first.engine.compactNow(s.id);
  await run(first.engine, "after the compaction");
  // Every body read once: what the whole session costs in memory.
  await first.store.warm(s.id);
  const whole = first.store.keptEvents().bytes;
  first.store.db.close();

  // An owner's-side change waits for a cold cache: the next start compares the kept prompt and asks.
  writeFileSync(file, "# Rules\n\nAnswer in one line.\nA new rule.\n");
  const again = rig();
  await run(again.engine, "after the restart");
  const kept = again.store.keptEvents().bytes;
  // The context is the run of events that holds the checkpoint (bodies are read 64 events at a time) and what follows.
  console.log(`kept after the restart's first turn: ${Math.round(kept / 1024)} KB of ${Math.round(whole / 1024)} KB`);
  expect(kept).toBeLessThan(whole / 3);
  again.store.db.close();
});
