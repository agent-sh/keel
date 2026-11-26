// Engine.heldInstructions on a real engine and store, fed to newInstructions: an idle edit before a move is told first.
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
import { newInstructions, instructionsSaid } from "../server/routes/places.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });
const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "held-instr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const top = join(dir, "top"), one = join(top, "one"), two = join(top, "two");
mkdirSync(one, { recursive: true }); mkdirSync(two, { recursive: true });
ownEnv({ KEEL_SCRIPTED_CACHE: "prefix" });

function rig() {
  const store = new Store(join(dir, "state"));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const scripted = new ScriptedProvider();
  const info = { id: "scripted:stand-in", provider: "scripted", model: "stand-in", name: "S", family: "other", context: 100_000, output: 2_000, tools: false, efforts: [], billing: "unknown" };
  const sent: ProviderRequest[] = [];
  const provider = { id: "scripted", family: "other" as const, available: () => true, list: () => scripted.list(), stream: (req: ProviderRequest, d: any) => { sent.push(req); return scripted.stream(req, d); } };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const errors = { capture: (_s: string, e: unknown) => ({ id: "c", message: String((e as Error)?.message ?? e) }) };
  return { store, engine: new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill")), sent };
}

test("held block after a checkpoint and a prompt note; an agent riding its top session", async () => {
  writeFileSync(join(top, "AGENTS.md"), "# Shared\n\n- shared v1.\n");
  writeFileSync(join(one, "AGENTS.md"), "# One\n\n- one v1.\n");
  writeFileSync(join(two, "AGENTS.md"), "# Two\n\n- two v1.\n");
  const { store, engine } = rig();
  const s = store.createSession({ model: "scripted:stand-in", workspace: one, title: "T" });
  const run = async (t: string) => { engine.send(s.id, t); await engine.idle(s.id); };
  await run("hello");
  writeFileSync(join(one, "AGENTS.md"), "# One\n\n- one v2 EARLY.\n");
  await run("edit before checkpoint");
  await engine.compactNow(s.id);
  await run("after compaction");
  writeFileSync(join(top, "AGENTS.md"), "# Shared\n\n- shared v2 TOLD.\n");
  await run("edit after checkpoint");
  const notes = store.events(s.id).filter((e) => e.kind === "note" && e.data.kind === "prompt_update");
  console.log("prompt notes:", notes.length, notes.map((n) => n.seq));
  const held = engine.heldInstructions(s.id)!;
  console.log("held has TOLD:", held.text.includes("TOLD"), "has EARLY:", held.text.includes("EARLY"));
  expect(held.text).toContain("TOLD");
  // Idle edit of the shared parent, then a move.
  writeFileSync(join(top, "AGENTS.md"), "# Shared\n\n- shared v3 IDLE.\n");
  const inst = newInstructions(two, one, 100_000, s, held);
  const said = instructionsSaid(inst, one);
  console.log("SAID:\n" + said);
  expect(said).toContain("IDLE");
  expect(inst.owed).not.toContain("+- one v2 EARLY");
  expect(said).toContain("two v1");

  // An agent riding the top session, no request of its own.
  const a = store.createSession({ model: "scripted:stand-in", workspace: one, title: "A" });
  store.migrate(`UPDATE sessions SET parent_id = '${s.id}' WHERE id = '${a.id}'`);
  (store as any).invalidate?.(a.id);
  const ah = engine.heldInstructions(a.id);
  console.log("agent parent:", store.session(a.id)?.parent_id === s.id, "agent held:", ah ? `TOLD=${ah.text.includes("TOLD")} v1=${ah.text.includes("shared v1")}` : "none");
});
