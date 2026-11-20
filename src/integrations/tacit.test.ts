// What the e2e cannot see: the messages of a summary request that is the
// first request of a turn, with the hooks that answer a new prompt installed.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { hookRoutes } from "../server/routes/hooks.ts";
import { MEMORY_CAP, Tacit } from "./tacit.ts";

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
    const { rebuilt, bytes: { total: bytesBefore } } = tacit.stats().transcript;
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
    expect(stats.transcript.rebuilt - rebuilt).toBe(5);
    expect(stats.transcript.bytes.total - bytesBefore).toBe(5 * statSync(tacit.transcriptPath(s)).size);
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
