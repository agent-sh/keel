import { expect, test } from "bun:test";
import { URGENT } from "../core/build.ts";
import { blockName, blocksOf } from "../engine/prompt-store.ts";
import { SECRETS_BLOCK } from "./routes/secrets.ts";

// The block is a safety instruction: it says exactly where a placeholder becomes its value, and a
// live session takes a change of it at once (src/core/build.ts URGENT).
test("the secrets block says where a placeholder becomes its value, and is marked urgent", () => {
  expect(SECRETS_BLOCK).toContain("a shell command");
  expect(SECRETS_BLOCK).toContain("a file tool refuses");
  expect(SECRETS_BLOCK).not.toContain("runs with the real value");
  const name = blockName(SECRETS_BLOCK);
  expect(name).toBe("Secrets");
  expect(URGENT.blocks[name]).toBeTruthy();
  expect(blocksOf([{ name, text: SECRETS_BLOCK }])[0]!.mark).toBe(URGENT.blocks[name]!);
});
