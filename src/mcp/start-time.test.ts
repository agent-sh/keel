// What a server's last start cost: ready_ms or failed_after_ms in its row, and how long a connecting one has waited.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSources } from "../tools/catalog.ts";
import { McpManager } from "./manager.ts";

const ECHO = join(import.meta.dir, "../../test/e2e/fixtures/echo-mcp.ts");
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); });
const fresh = () => {
  const m = new McpManager({ capture() {} } as any, mkdtempSync(join(tmpdir(), "keel-mcp-")), "/");
  managers.push(m);
  return m;
};
const row = (m: McpManager, name: string) => m.list().find((x) => x.name === name)!;

test("a server says how long its last start took, and a connecting one how long it has waited", async () => {
  const m = fresh();
  (m as any).addEntry("slow", { command: "bun", args: [ECHO, "--init-delay=2000"] });
  const t0 = Date.now();
  const up0 = m.ensure("slow");
  await new Promise((r) => setTimeout(r, 300));
  const mid = row(m, "slow");
  expect(mid.state).toBe("connecting");
  expect(mid.started_at).toBeGreaterThan(t0 - 1000);
  expect(mid.ready_ms).toBeUndefined();
  const note = catalogSources().flatMap((s) => s.pending?.() ?? []).find((n) => n.startsWith("slow"));
  expect(note).toMatch(/^slow \(connecting for \d+ ms\)$/);

  await up0;
  const up = row(m, "slow");
  expect(up.state).toBe("ready");
  expect(up.ready_ms).toBeGreaterThanOrEqual(2000);
  expect(up.failed_after_ms).toBeUndefined();
  expect(up.started_at).toBeUndefined();

  // Connected again: the figure of the first start is gone while it connects, and the new one is its own.
  const back = m.reconnect("slow");
  const mid2 = row(m, "slow");
  expect([mid2.state, mid2.ready_ms, typeof mid2.started_at]).toEqual(["connecting", undefined, "number"]);
  await back;
  const again = row(m, "slow");
  expect(again.state).toBe("ready");
  expect(again.ready_ms).toBeGreaterThanOrEqual(2000);
}, 20_000);

test("a server that fails to start says how long it ran before it failed", async () => {
  const m = fresh();
  (m as any).addEntry("broken", { command: "bun", args: ["-e", "await Bun.sleep(400); process.exit(3)"] });
  await m.ensure("broken").catch(() => {});
  const r = row(m, "broken");
  expect(r.state).toBe("error");
  expect(r.failed_after_ms).toBeGreaterThanOrEqual(300);
  expect(r.ready_ms).toBeUndefined();
}, 10_000);
