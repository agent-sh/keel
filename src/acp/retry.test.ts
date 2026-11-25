// A probe that failed is asked again after RETRY_MS: an agent the owner signs in later lists its models on its own.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgents, RETRY_MS, RETRY_MOST_MS, programKey, retryAfter } from "./agents.ts";

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

test("the retry time doubles with each failure in a row, up to six hours", () => {
  expect([1, 2, 3, 6, 7, 100].map(retryAfter)).toEqual([RETRY_MS, 2 * RETRY_MS, 4 * RETRY_MS, 32 * RETRY_MS, RETRY_MOST_MS, RETRY_MOST_MS]);
  expect(RETRY_MOST_MS).toBe(6 * 3_600_000);
});

test("a failure in a row waits longer, and a changed program or a success starts over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-backoff-"));
  try {
    writeFileSync(join(dir, "agent.js"), AGENT);
    writeFileSync(join(dir, "bad.js"), `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "auth" } }) + "\n"); setTimeout(() => {}, 1000);`);
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const good = { command: "bun", args: [join(dir, "agent.js")] };
    const bad = { command: "bun", args: [join(dir, "bad.js")] };
    const save = (run: typeof good, fails: number, ago: number) => writeFileSync(join(state, "acp-choices.json"), JSON.stringify({ a: { key: programKey(run), at: Date.now() - ago, error: "it needs its own sign-in first", fails, commands: [] } }));
    // Three failures in a row: past the first retry time it still waits (the third waits 40 minutes).
    save(good, 3, RETRY_MS + 1_000);
    const waiting = new AcpAgents(state);
    waiting.ask([{ id: "a", name: "a", source: "custom", run: good }]);
    await Bun.sleep(400);
    expect(waiting.learned("a")?.fails).toBe(3);
    // Past its own time it is asked, and the success clears the count.
    save(good, 3, retryAfter(3) + 1_000);
    const due = new AcpAgents(state);
    due.ask([{ id: "a", name: "a", source: "custom", run: good }]);
    const end = Date.now() + 20_000;
    while (due.learned("a")?.error && Date.now() < end) await Bun.sleep(25);
    expect(due.learned("a")?.error).toBeUndefined();
    expect(due.learned("a")?.fails).toBeUndefined();
    // A failure again counts one more.
    save(bad, 2, retryAfter(2) + 1_000);
    const again = new AcpAgents(state);
    again.ask([{ id: "a", name: "a", source: "custom", run: bad }]);
    while (again.learned("a")?.fails === 2 && Date.now() < end) await Bun.sleep(25);
    expect(again.learned("a")?.fails).toBe(3);
    // A changed program is asked at once and counts from one.
    save(bad, 5, 1_000);
    const changed = new AcpAgents(state);
    changed.ask([{ id: "a", name: "a", source: "custom", run: { ...bad, args: [...bad.args, "x"] } }]);
    while (changed.learned("a")?.fails === 5 && Date.now() < end) await Bun.sleep(25);
    expect(changed.learned("a")?.fails).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
