import { afterEach, expect, test } from "bun:test";
import { ownEnv } from "../../test/env.ts";
import { KEYRING_WAIT_MS, key, keyringRead, shown } from "./creds.ts";

// KEEL_CRED_GET names a program that prints nothing, so no helper of the machine is asked.
ownEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: undefined, KEEL_CRED_GET: "/bin/true", KEEL_KEYRING_SERVICE: "keel-creds-test" });

const real = keyringRead.get;
afterEach(() => { keyringRead.get = real; });

test("a headless daemon does not wait on a keyring that waits for an unlock", async () => {
  if (process.platform !== "linux") return;
  let release: (v: string | null) => void = () => {};
  keyringRead.get = () => new Promise((r) => { release = r; }); // a locked collection: the prompt nobody answers
  const src = { cred: "LOCKED_KEY" };
  const t = Date.now();
  expect(await key(src)).toBeNull();
  expect(Date.now() - t).toBeLessThan(2000);
  expect(KEYRING_WAIT_MS).toBeLessThan(2000);
  expect(shown(src)).toContain("is locked");
  // The same read is not started again, and it answers as fast the second time.
  const t2 = Date.now();
  expect(await key(src)).toBeNull();
  expect(Date.now() - t2).toBeLessThan(2000);
  // The keyring unlocks later: the key is there without another read.
  release("sk-late\n");
  await Bun.sleep(20);
  expect(await key(src)).toBe("sk-late");
  expect(shown(src)).not.toContain("locked");
});

test("a display means someone can answer the prompt: the read is not cut short", async () => {
  if (process.platform !== "linux") return;
  process.env.DISPLAY = ":99";
  try {
    keyringRead.get = async () => { await Bun.sleep(KEYRING_WAIT_MS + 300); return "sk-slow"; };
    expect(await key({ cred: "SLOW_KEY" })).toBe("sk-slow");
  } finally { delete process.env.DISPLAY; }
});
