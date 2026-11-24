import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { fixedRefusal, realProviders } from "./fixed-world-gate.ts";

ownEnv({ ANTHROPIC_API_KEY: "sk-test-not-a-key", KEEL_ACP_REGISTRY: "/nonexistent/registry.json" });

const none = async () => [] as string[];
const folder = () => mkdtempSync(join(tmpdir(), "fixed-gate-"));

test("a fresh folder with no real provider may start fixed", async () => {
  expect(await fixedRefusal(folder(), none)).toBeNull();
  expect(await fixedRefusal(join(folder(), "not-made-yet"), none)).toBeNull();
});

test("a folder a real daemon used stays real, and a fixed daemon's restart stays fixed", async () => {
  const used = folder();
  writeFileSync(join(used, "store.db"), "");
  expect(await fixedRefusal(used, none)).toContain("already holds a store");
  writeFileSync(join(used, "fixed-world.json"), "{}");
  expect(await fixedRefusal(used, none)).toBeNull();
});

test("a real provider that would list keeps the daemon real", async () => {
  expect(await fixedRefusal(folder(), async () => ["anthropic"])).toBe("a real provider would list (anthropic)");
  expect(await realProviders(folder())).toContain("anthropic");
});
