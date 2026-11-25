// A probe that failed is asked again after RETRY_MS: an agent the owner signs in later lists its models on its own.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgents, RETRY_MS, programKey } from "./agents.ts";

const AGENT = `
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] }] } });
  }
});
`;

test("an agent whose probe failed for want of a sign-in is probed again after the retry time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-retry-"));
  try {
    writeFileSync(join(dir, "agent.js"), AGENT);
    const run = { command: "bun", args: [join(dir, "agent.js")] };
    const agent = { id: "late", name: "late", source: "custom" as const, run };
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const failed = (at: number) => writeFileSync(join(state, "acp-choices.json"), JSON.stringify({ late: { key: programKey(run), at, error: "it needs its own sign-in first", commands: [] } }));
    // A failure a minute old stands: the program is the same and nothing asked for it again.
    failed(Date.now() - 60_000);
    const fresh = new AcpAgents(state);
    fresh.ask([agent]);
    await Bun.sleep(300);
    expect(fresh.learned("late")?.error).toBeTruthy();
    // One past the retry time is asked again, and what it offers is listed.
    failed(Date.now() - RETRY_MS - 1_000);
    const old = new AcpAgents(state);
    old.ask([agent]);
    const end = Date.now() + 20_000;
    while (old.learned("late")?.error && Date.now() < end) await Bun.sleep(25);
    expect(old.learned("late")?.error).toBeUndefined();
    expect(old.learned("late")?.models?.options.map((o) => o.value)).toEqual(["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
