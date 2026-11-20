// What the e2e cannot see: the messages of a summary request that is the
// first request of a turn, with the hooks that answer a new prompt installed.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { hookRoutes } from "../server/routes/hooks.ts";
import { Tacit } from "./tacit.ts";

// A context over its limit is summarized before the turn's first request. That
// request carries the summary's own ask and none of the new prompt: memory and
// the owner's prompt hooks answer the prompt on the turn request, after the
// summary. (They used to rebuild the summary request from the branch, so the
// model got the prompt with no ask for a summary and went on with the work.)
test("a summary sent before a turn's first request keeps its ask; the prompt's hooks run on the turn request", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "prompt-hooks-"));
  const bin = join(dir, "tacit");
  writeFileSync(bin, '#!/bin/sh\ncat > /dev/null\nif [ "$2" = prompt ]; then echo MEMORY-FOR-PROMPT; fi\n', { mode: 0o755 });
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
    new Tacit(store, bus, errors, bin).install();
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
  } finally {
    allHooks().length = installed; // the hooks are process-wide: other test files run without these
    if (ownerHooks === undefined) delete process.env.KEEL_HOOKS;
    else process.env.KEEL_HOOKS = ownerHooks;
  }
});
