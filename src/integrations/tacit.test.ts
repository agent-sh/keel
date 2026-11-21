// What the e2e cannot see: the messages of a summary request that is the
// first request of a turn, with the hooks that answer a new prompt installed.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { hookRoutes } from "../server/routes/hooks.ts";
import { MEMORY_CAP, Tacit } from "./tacit.ts";

test("Tacit reuses only the retained transcript of the same version", () => {
  const dir = mkdtempSync(join(tmpdir(), "tacit-transcript-"));
  const store = new Store(dir);
  try {
    const failures: unknown[] = [];
    const tacit = new Tacit(store, new Bus(), { capture: (_: string, error: unknown) => failures.push(error) } as unknown as ErrorTracker, null);
    const s = store.createSession({ model: "fixture:model", workspace: dir });
    const first = store.append(s.id, "user", { text: "First branch" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Synthetic reply" }] });
    const read = (session = s) => readFileSync(tacit.transcript(session), "utf8");
    const stats = tacit.stats().transcript;
    const initial = read();
    const path = tacit.transcriptPath(s);
    expect(initial).toContain("First branch");
    expect(read()).toBe(initial); // exact JSONL bytes, including UUIDs
    expect(stats).toMatchObject({ rebuilt: 1, reused: 1, failed: 0, bytes: { total: Buffer.byteLength(initial) } });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Same original Session object, but the head is now on a sibling branch.
    store.append(s.id, "user", { text: "Fresh branch" }, first.id);
    const fresh = read();
    expect(fresh).toContain("Fresh branch");
    expect(fresh).not.toContain("Synthetic reply");
    expect(stats.rebuilt).toBe(2);
    store.updateSession(s.id, { head: first.id });
    expect(read()).not.toContain("Fresh branch");
    expect(stats.rebuilt).toBe(3);

    const moved = store.updateSession(s.id, { workspace: join(dir, "moved") });
    expect(JSON.parse(read()).cwd).toBe(moved.workspace);
    expect(stats.rebuilt).toBe(4);
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "No stored model" }] });
    const beforeAppend = readFileSync(path, "utf8");
    const beforeModel = read(moved);
    // The branch only grew: the reply is appended under the file's last record,
    // and what was there keeps its bytes (the file is not written whole again).
    expect(stats).toMatchObject({ rebuilt: 4, appended: 1 });
    expect(beforeModel.startsWith(beforeAppend)).toBe(true);
    const records = beforeModel.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.map((r) => r.parentUuid)).toEqual([null, ...records.slice(0, -1).map((r) => r.uuid)]);
    const changedModel = store.updateSession(s.id, { model: "fixture:new-model" });
    const modelUpdated = read(moved);
    expect(beforeModel).toContain('"model":"model"');
    expect(modelUpdated).toContain('"model":"new-model"');
    expect(stats.rebuilt).toBe(5);

    rmSync(path);
    mkdirSync(path); // a failed replacement must leave no cached version or temporary file
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 5, reused: 1, failed: 1 });
    expect(failures).toHaveLength(1);
    expect(readdirSync(join(dir, "transcripts"))).toEqual([`${s.id}.jsonl`]);
    rmSync(path, { recursive: true });
    const restored = read(changedModel);
    expect(restored).toContain('"model":"new-model"');
    expect(restored).not.toBe(modelUpdated);
    expect(read(changedModel)).toBe(restored);
    expect(stats).toMatchObject({ rebuilt: 6, reused: 2 });

    tacit.forget(s.id);
    expect(read(changedModel)).not.toBe(restored);
    tacit.setFlags(s.id, { feed_memory: false });
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 7, reused: 2 });
    tacit.setFlags(s.id, { feed_memory: true });
    read(changedModel);
    expect(stats.rebuilt).toBe(8);
    store.deleteSession(s.id);
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 8, reused: 2 });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A context over its limit is summarized before the turn's first request. That
// request carries the summary's own ask and none of the new prompt: memory and
// the owner's prompt hooks answer the prompt on the turn request, after the
// summary. (They used to rebuild the summary request from the branch, so the
// model got the prompt with no ask for a summary and went on with the work.)
test("a summary sent before a turn's first request keeps its ask; the prompt's hooks run on the turn request", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "prompt-hooks-"));
  const bin = join(dir, "tacit");
  const context = "é".repeat(MEMORY_CAP + 1);
  writeFileSync(bin, `#!/bin/sh
input=$(cat)
case "$2" in
  prompt) echo MEMORY-FOR-PROMPT ;;
  pre-tool)
    case "$input" in
      *fixture-hit*) printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { additionalContext: context } })}' ;;
      *fixture-timeout*) exec sleep 3 ;;
      *fixture-failure*) exit 1 ;;
      *fixture-invalid*) echo not-json ;;
      *) echo '{}' ;;
    esac ;;
esac
`, { mode: 0o755 });
  const ownerHooks = process.env.KEEL_HOOKS;
  process.env.KEEL_HOOKS = join(dir, "hooks.json");
  writeFileSync(process.env.KEEL_HOOKS, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo HOOK-FOR-PROMPT" }] }] } }));
  const installed = allHooks().length;
  try {
    const store = new Store(dir);
    const bus = new Bus();
    const errors = { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any;
    const asked: any[] = [];
    const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
    const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
    const provider = {
      id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
      stream: async (req: any) => {
        asked.push(req);
        return { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY-OF-IT" : "ok" }], usage, stop: "end_turn", model: "m" };
      },
    };
    const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] } as any;
    const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
    const tacit = new Tacit(store, bus, errors, bin);
    tacit.install();
    hookRoutes({ store, bus, engine, providers, errors, workspace: dir });

    const s = store.createSession({ model: "p:m", workspace: dir });
    store.updateSession(s.id, { settings: { compact_at: 2_000 } });
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(20_000) }], model: "p:m", stop: "end_turn", usage: { ...usage, input: 6_000 } });
    engine.send(s.id, "THE-NEW-PROMPT");
    await engine.idle(s.id);

    expect(asked.map((r) => r.purpose)).toEqual(["summary", "turn"]);
    const [summary, turn] = asked.map((r) => JSON.stringify(r.messages));
    expect(JSON.stringify(asked[0].messages.at(-1).content.at(-1))).toContain("The context is being compacted");
    for (const later of ["THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "HOOK-FOR-PROMPT"]) expect(summary).not.toContain(later);
    // The turn request: the summary, then the prompt whole with what its hooks added.
    expect(JSON.stringify(asked[1].messages[0])).toContain("SUMMARY-OF-IT");
    expect(turn).not.toContain("x".repeat(20_000));
    for (const here of ["THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "HOOK-FOR-PROMPT"]) expect(turn).toContain(here);
    expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");

    expect(await tacit.startBlock(s)).toBeNull();
    const path = tacit.transcript(s);
    const transcriptBefore = readFileSync(path);
    const { rebuilt, reused, bytes: { total: bytesBefore } } = tacit.stats().transcript;
    expect(await tacit.preToolBlock(s, "read", {})).toBeNull(); // no Tacit call
    expect(await tacit.preToolBlock(s, "bash", { command: "fixture-hit" })).toBe(context);
    for (const kind of ["empty", "failure", "invalid", "timeout"])
      expect(await tacit.preToolBlock(s, "bash", { command: `fixture-${kind}` })).toBeNull();
    const stats = tacit.stats();
    expect(stats.hooks["prompt"].outcomes.hit).toBe(1);
    expect(stats.hooks["session-start"].outcomes.empty).toBe(1);
    expect(stats.hooks["pre-compact"].outcomes.ok).toBe(1);
    const preTool = stats.hooks["pre-tool"];
    expect(preTool.outcomes).toEqual({ hit: 1, empty: 1, failure: 2, timeout: 1, ok: 0 });
    expect(preTool.context_bytes).toEqual({ total: MEMORY_CAP * 2, max: MEMORY_CAP * 2 });
    expect(preTool.duration_ms.max).toBeGreaterThan(0);
    expect(preTool.duration_ms.total).toBeGreaterThan(preTool.duration_ms.max);
    expect(stats.transcript.failed).toBe(0);
    expect(stats.transcript.rebuilt - rebuilt).toBe(0);
    expect(stats.transcript.reused - reused).toBe(5);
    expect(stats.transcript.bytes.total - bytesBefore).toBe(0);
    expect(readFileSync(path).equals(transcriptBefore)).toBe(true);
    expect(stats.transcript.duration_ms.total).toBeGreaterThan(0);
    const json = JSON.stringify(stats);
    for (const secret of [context.slice(0, 20), "THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "fixture-timeout", s.id, dir]) expect(json).not.toContain(secret);
  } finally {
    allHooks().length = installed; // the hooks are process-wide: other test files run without these
    if (ownerHooks === undefined) delete process.env.KEEL_HOOKS;
    else process.env.KEEL_HOOKS = ownerHooks;
    rmSync(dir, { recursive: true, force: true });
  }
});

// What the memory hooks add across the prompts of one session, with a store
// that answers, then stops answering, then answers again (no e2e can hold a
// store back for one prompt and release it for the next).
test("memory across prompts: nothing twice, nothing for a delivered input, a slow store told once and not waited for", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "memory-flow-"));
  const bin = join(dir, "store");
  writeFileSync(join(dir, "mode"), "ok");
  writeFileSync(bin, `#!/bin/sh
input=$(cat)
mode=$(cat ${JSON.stringify(join(dir, "mode"))})
echo "$2" >> ${JSON.stringify(join(dir, "calls"))}
[ "$mode" = slow ] && exec sleep 5
if [ "$2" = prompt ]; then
  echo "# store: facts matching this request"
  echo "- fact-a: Always keep the alpha rule"
  case "$input" in *beta*) echo "- fact-b: The beta rule applies too" ;; esac
  case "$input" in *gamma*) echo "- fact-c: The gamma rule came late" ;; esac
fi
`, { mode: 0o755 });
  const installed = allHooks().length;
  try {
    const store = new Store(dir);
    const bus = new Bus();
    const captured: string[] = [];
    const errors = { capture: (_s: string, e: unknown) => { captured.push(String((e as Error).message)); return { message: "" }; } } as any;
    const asked: { at: number; messages: string }[] = [];
    const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
    const provider = {
      id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
      stream: async (req: any) => {
        asked.push({ at: performance.now(), messages: JSON.stringify(req.messages) });
        const said = JSON.stringify(req.messages.at(-1)).includes("first") ? "Following fact-a here." : "ok";
        return { blocks: [{ type: "text", text: said }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" };
      },
    };
    const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] } as any;
    const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
    const tacit = new Tacit(store, bus, errors, bin);
    tacit.install();
    const s = store.createSession({ model: "p:m", workspace: dir });
    const say = async (text: string, meta?: Record<string, unknown>) => {
      const t0 = performance.now();
      engine.send(s.id, text, { meta });
      await engine.idle(s.id);
      return asked.at(-1)!.at - t0;
    };
    const notes = () => store.events(s.id).filter((e) => e.kind === "note" && e.data.memory).map((e) => String(e.data.text));
    const told = () => store.events(s.id).filter((e) => e.kind === "note" && e.data.kind === "memory_out");
    const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter((c) => c === "prompt").length;
    // Waits on what the store did, never on the clock alone.
    const until = async (what: () => boolean) => { for (let i = 0; i < 400 && !what(); i++) await Bun.sleep(25); expect(what()).toBe(true); };

    await say("first alpha");
    await say("second beta");
    // The second prompt got the new fact; the one the context holds was not added again.
    expect(notes().length).toBe(2);
    expect(notes()[1]).toContain("fact-b");
    expect(notes()[1]).not.toContain("fact-a");
    // The request carries each fact once, and the first note's bytes are where they were.
    expect(asked.at(-1)!.messages.split("fact-a: Always").length - 1).toBe(1);
    // A report is not a request: the store is not asked, nothing is added.
    await say("<agent_report>the beta work is done</agent_report>", { kind: "subagent", agent_id: "a" });
    expect(calls()).toBe(2);
    expect(notes().length).toBe(2);

    // The store stops answering: the turn waits the hook's deadline once and is told once.
    writeFileSync(join(dir, "mode"), "slow");
    const waited = await say("third");
    expect(waited).toBeGreaterThan(2_000);
    expect(waited).toBeLessThan(4_000);
    expect(told().length).toBe(1);
    expect(told()[0]!.data.model).toBeUndefined(); // a line for the owner, not sent to the model
    expect(asked.at(-1)!.messages).not.toContain("Memory did not answer");
    // The next prompt does not wait for it, and says nothing more.
    expect(await say("fourth")).toBeLessThan(1_000);
    expect(told().length).toBe(1);
    expect(captured.filter((m) => m.includes("memory store"))).toHaveLength(1);
    await until(() => calls() === 4); // its call started while the store was not answering

    // It answers again: the prompt that found out did not wait, and its block joins the next one.
    writeFileSync(join(dir, "mode"), "ok");
    const hits = tacit.stats().hooks.prompt.outcomes.hit;
    expect(await say("fifth gamma")).toBeLessThan(1_000);
    expect(notes().length).toBe(2);
    await until(() => tacit.stats().hooks.prompt.outcomes.hit === hits + 1);
    await say("sixth");
    expect(notes().length).toBe(3);
    expect(notes()[2]).toContain("fact-c");
    expect(notes()[2]).not.toContain("fact-a");
    expect(store.events(s.id).filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(Array(7).fill("end_turn"));

    // The measurements, without content: what was asked, added, left out, used and waited for.
    const { memoryMeter } = await import("./memory-meter.ts");
    const report = memoryMeter(store).report({ session: s.id });
    const prompt = report.paths.find((p) => p.path === "store_prompt")!;
    // Seven inputs, one row each: three added (the late one among them, written
    // over its own row), the report not asked, the last one all held already.
    expect(prompt).toMatchObject({ asked: 7, recalls: 3, skipped: 1, facts: 3, facts_checked: 3, used: 1, recalls_used: 1 });
    expect(prompt.timeouts + prompt.late).toBe(2); // "fourth" is late until its call is given up
    expect(prompt.repeats).toBe(3); // fact-a: with the second prompt, with the late block, with the last prompt
    expect(prompt.wait_ms).toBeGreaterThan(2_000);
    expect(JSON.stringify(report)).not.toContain("fact-");
  } finally {
    allHooks().length = installed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
