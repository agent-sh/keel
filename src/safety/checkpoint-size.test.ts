// The size of the checkpoint store is counted off the loop: the walk starts, and the caller goes on before it reads the folders.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { sizeOf } from "./checkpoints.ts";

const dir = tempTree("checkpoint-size-");

test("a folder's bytes are summed by a walk that does not run in the caller's turn", async () => {
  let bytes = 0;
  for (let i = 0; i < 40; i++) {
    const d = join(dir, `r${i}`, "objects");
    mkdirSync(d, { recursive: true });
    for (let j = 0; j < 50; j++) { writeFileSync(join(d, `f${j}`), "x".repeat(j + 1)); bytes += j + 1; }
  }
  const walk = sizeOf(dir);
  // Written after the call returned: a walk made in the call itself has read this folder already and misses it.
  writeFileSync(join(dir, "r0", "objects", "late"), "y".repeat(1000));
  expect(await walk).toBe(bytes + 1000);
});
