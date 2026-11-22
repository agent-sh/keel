import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { emptyUsage } from "../core/types.ts";
import { ProviderError } from "../providers/http.ts";
import { makeJudge } from "./judge.ts";

test("an offline policy judge fails closed instead of waiting for a later approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-judge-outage-"));
  const store = new Store(dir);
  try {
    const model = "fixture:judge";
    const session = store.createSession({ model, workspace: dir });
    let asked = 0;
    let waited = 0;
    const providers = {
      outages: { wait: async () => { waited++; } },
      resolve: async () => ({
        info: { id: model, name: "Judge", model: "judge", efforts: [], output: 1000 },
        provider: { stream: async () => {
          if (++asked === 1) throw new ProviderError("unreachable", "getaddrinfo EAI_AGAIN");
          return { blocks: [{ type: "text", text: '{"decision":"allow","risk":"low","reason":"in scope"}' }], usage: emptyUsage() };
        } },
      }),
    } as any;
    const judge = makeJudge(store, providers, () => model);
    // Include the old wait trigger to ensure it cannot turn a refusal into an approval.
    const ask = { session, tool: "Bash", kind: "shell", summary: "remove a build directory", input: {}, mode: "auto" as const, signal: new AbortController().signal };
    expect(await judge(ask)).toEqual({ unavailable: `${model}: getaddrinfo EAI_AGAIN` });
    expect(asked).toBe(1);
    expect(waited).toBe(0);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
