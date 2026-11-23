// An instruction file edited while a session lives: the real engine and store,
// the scripted stand-in as the model, no daemon restart. Its next request
// keeps the system prompt's bytes and carries the change as a note at the
// tail; a compaction folds the change into the prompt and the note is not
// told again; a deleted file is told as deleted, not as an edit. (The page's
// side, the note and the context popup, is test/e2e/build-pin.spec.ts.)
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import { allHooks } from "./hooks.ts";
import { editedPath, markOf, noteMark, type Marks } from "./instruction-marks.ts";
import { Engine } from "./turn.ts";

const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "instructions-refresh-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// The session's folder, and its parent: both in the chain of folders read.
const home = dir, work = join(dir, "work");
mkdirSync(work, { recursive: true });
// The stand-in reports cache reads by the request's prefix, as a real cache does: the session is warm.
ownEnv({ KEEL_SCRIPTED_CACHE: "prefix" });

function rig() {
  const store = new Store(join(dir, "state"));
  // (The agents' module adds the column in the daemon; a prompt taken at a cold moment reads the session's agents.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const scripted = new ScriptedProvider();
  const info = { id: "scripted:stand-in", provider: "scripted", model: "stand-in", name: "Scripted stand-in", family: "other", context: 100_000, output: 2_000, tools: false, efforts: [], billing: "unknown" };
  const sent: ProviderRequest[] = [];
  const provider = { id: "scripted", family: "other" as const, available: () => true, list: () => scripted.list(), stream: (req: ProviderRequest, d: any) => { sent.push(req); return scripted.stream(req, d); } };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] };
  const errors = { capture: (_s: string, e: unknown) => ({ id: "captured", message: String((e as Error)?.message ?? e) }) };
  const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
  return { store, engine, sent };
}
const turns = (sent: ProviderRequest[]) => sent.filter((r) => (r.purpose ?? "turn") === "turn");
const tail = (r: ProviderRequest) => JSON.stringify(r.messages.at(-1));
const notes = (store: Store, id: string) => store.events(id).filter((e) => e.kind === "note" && e.data.kind === "prompt_update");

test("an edited instruction file reaches the next request as a note, and the prompt at a compaction, with no restart", async () => {
  const file = join(work, "AGENTS.md");
  const RULE = "Never touch the live daemon.";
  writeFileSync(file, "# Rules\n\nAnswer in one line.\n");
  const { store, engine, sent } = rig();
  const s = store.createSession({ model: "scripted:stand-in", workspace: work, title: "Refresh" });
  const run = async (text: string) => { engine.send(s.id, text); await engine.idle(s.id); return turns(sent).at(-1)!; };

  const first = await run("hello");
  expect(first.system).toContain("Answer in one line.");
  expect(first.system).not.toContain(RULE);
  // Nothing edited: nothing told.
  const quiet = await run("again");
  expect(quiet.system).toBe(first.system);
  expect(notes(store, s.id)).toHaveLength(0);

  writeFileSync(file, `# Rules\n\nAnswer in one line.\n${RULE}\n`);
  const second = await run("after the edit");
  expect(second.system, "the cached prefix keeps its bytes").toBe(first.system);
  expect(tail(second)).toContain(`+${RULE}`);
  expect(tail(second)).toContain(file);
  expect(notes(store, s.id)).toHaveLength(1);
  // Told once.
  const third = await run("and again");
  expect(third.system).toBe(first.system);
  expect(notes(store, s.id)).toHaveLength(1);

  // A compaction makes the cache cold anyway: the prompt takes the edit, and the note is not repeated.
  await engine.compactNow(s.id);
  const folded = await run("after the compaction");
  expect(folded.system).toContain(RULE);
  expect(JSON.stringify(folded.messages)).not.toContain(`+${RULE}`);
  expect(notes(store, s.id)).toHaveLength(1);

  // A deleted file is told as deleted.
  rmSync(file);
  const gone = await run("after the delete");
  expect(gone.system).toBe(folded.system);
  expect(tail(gone)).toContain(`Deleted (or no longer found where it was read): ${file}. What it said no longer applies.`);
  expect(notes(store, s.id)).toHaveLength(2);

  // A file made where none was (the parent folder's) is noticed too.
  writeFileSync(join(home, "CLAUDE.md"), "Home rule.\n");
  const came = await run("after a new file");
  expect(tail(came)).toContain(`New: ${join(home, "CLAUDE.md")}.`);
  expect(tail(came)).toContain("Home rule.");
  rmSync(join(home, "CLAUDE.md"));
});

test("the check is a stat of each noted file", () => {
  const marks: Marks = new Map();
  const a = join(dir, "marked.md");
  writeFileSync(a, "one\n");
  noteMark(marks, a);
  noteMark(marks, join(dir, "absent.md"));
  expect(editedPath(marks)).toBeUndefined();
  // (Of another size: a file's times move by the kernel's clock tick, a few milliseconds.)
  writeFileSync(a, "one more\n");
  expect(editedPath(marks)).toBe(a);
  marks.set(a, markOf(a));
  writeFileSync(join(dir, "absent.md"), "x");
  expect(editedPath(marks)).toBe(join(dir, "absent.md"));
  // Its cost, for the report: a chain of twenty paths, checked many times.
  const many: Marks = new Map();
  for (let i = 0; i < 20; i++) noteMark(many, join(dir, `f${i}.md`));
  const t = performance.now();
  for (let i = 0; i < 1000; i++) editedPath(many);
  const us = ((performance.now() - t) / 1000) * 1000;
  console.log(`instruction marks: ${us.toFixed(1)} us a check of 20 paths`);
  expect(us).toBeLessThan(5_000);
});
