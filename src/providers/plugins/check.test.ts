import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Check } from "./check.ts";

// The conformance runner against a small plugin: a plugin that keeps the
// protocol passes every fixture, and one that breaks a rule fails that fixture.
const stub = join(import.meta.dir, "../../../test/fixtures/plugin-check-stub.ts");
const run = async (mode: string, only: string[] = []) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "keel-check-"));
  try {
    const c = new Check({ id: "stub", command: stub, args: mode ? [mode] : [], env: [], settings: {}, providerSettings: {} }, dir, only);
    await c.run();
    return Object.fromEntries(c.rows.map((r) => [r.fixture, r.result]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a plugin that keeps protocol v1 passes every fixture", async () => {
  const rows = await run("");
  expect(Object.keys(rows).length).toBe(23);
  expect(Object.entries(rows).filter(([, r]) => r !== "pass")).toEqual([]);
}, 60_000);

test("a broken rule fails its fixture", async () => {
  expect((await run("leak", ["turn:", "credential"])).credential).toBe("fail");
  expect((await run("body", ["turn:"]))["turn:stub"]).toBe("fail");
  expect((await run("noretry")).handshake).toBe("fail");
}, 60_000);
