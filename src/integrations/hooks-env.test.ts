import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { Hooks } from "./hooks.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-hooks-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "hooks.json");
ownEnv({ KEEL_HOOKS: file, HOOK_TEST_API_KEY: "fake-key", HOOK_TEST_PLAIN: "plain" });

test("a command hook gets the daemon's environment without its secrets, except the names it lists", async () => {
  const say = 'printf "key=%s plain=%s" "$HOOK_TEST_API_KEY" "$HOOK_TEST_PLAIN"';
  writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: say }, { type: "command", command: say, allowedEnvVars: ["HOOK_TEST_API_KEY"] }] }] } }));
  const h = new Hooks(new Store(mkdtempSync(join(dir, "state-"))));
  const r = await h.run("UserPromptSubmit", { id: "s", workspace: dir, model: "x:y" } as any, { prompt: "p" });
  expect(r.context.sort()).toEqual(["key= plain=plain", "key=fake-key plain=plain"]);
});
