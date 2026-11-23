import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openPanel, shoot } from "./shots.ts";

// Feature: a session that waits past its prompt cache's lifetime does not pay
// to write its whole context again. An agent parked on a timer, and a turn
// whose command runs long, each get a cache plan: before the cache lapses, a
// request reads it (at the read price), so the request after the wait reads
// it too. The timeline says what was chosen and what it cost against a rewrite.
// The spec runs its own daemon on a scratch state folder, on the scripted
// stand-in with a cache that lapses after 12 s (KEEL_SCRIPTED_CACHE_TTL_MS),
// as a provider's does after its lifetime.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const TTL = 12_000;

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DRAIN_MS: "300",
    KEEL_SCRIPTED_LOG: join(state, "requests.jsonl"), KEEL_SCRIPTED_CACHE_TTL_MS: String(TTL), KEEL_CONFIG_DIR: join(state, "config"),
    KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off",
  };
  delete env.KEEL_MCP_CONFIG;
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("a waiting agent and a long command keep their prompt cache warm, and the timeline says what it cost", async ({ page }) => {
  test.setTimeout(150_000);
  const state = join(ROOT, `cache-plan-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const log = join(state, "requests.jsonl");
  const sent = (id: string, purpose: string) => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.session === id && r.purpose === purpose);
  const events = async (id: string) => (await call(`/api/sessions/${id}`)).events as any[];
  try {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Waits past the cache" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    // The agent parks on a 30 s timer (past the 12 s cache); the parent's own turn runs a 30 s command.
    const agentCalls = [{ name: "wait_for", input: { kind: "timer", seconds: 30, note: "check back" } }];
    const calls = [
      // (A context worth keeping: for a few hundred tokens a rewrite costs less than the warm requests, and the plan lets it lapse.)
      { name: "spawn_agent", input: { message: `Waiter\n${"Notes the agent carries through its wait. ".repeat(500)}\nscript:calls ${JSON.stringify(agentCalls)}`, isolation: "none" } },
      { name: "Bash", input: { command: "sleep 30", timeout: 60_000 } },
    ];
    await call(`/api/sessions/${session.id}/messages`, { text: `${"Notes the session carries through its wait. ".repeat(500)}\nscript:calls ${JSON.stringify(calls)}` });
    await expect.poll(async () => (await call(`/api/sessions/${session.id}/agents`)).agents[0]?.status, { timeout: 30_000 }).toBe("waiting");
    const agent = (await call(`/api/sessions/${session.id}/agents`)).agents[0];

    // Both waits are kept warm: requests beside the history, at least two each before the 30 s are over.
    await expect.poll(() => sent(agent.session_id, "warm").length, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => sent(session.id, "warm").length, { timeout: 40_000 }).toBeGreaterThanOrEqual(2);

    // The agent's wake and the parent's next step read the cache: nothing of the context is written again.
    const after = async (id: string) => {
      const evs = await events(id);
      const at = evs.findLastIndex((e) => e.kind === "user" && String(e.data.text).includes("<wait_fired"));
      return at < 0 ? undefined : evs.slice(at + 1).find((e) => e.kind === "assistant")?.data.usage;
    };
    await expect.poll(async () => (await after(agent.session_id))?.cache_read ?? -1, { timeout: 40_000 }).toBeGreaterThan(0);
    expect((await after(agent.session_id)).cache_write).toBe(0);
    const note = async (id: string) => (await events(id)).find((e) => e.kind === "note" && e.data.kind === "cache_plan")?.data;
    await expect.poll(async () => (await note(session.id))?.outcome, { timeout: 40_000 }).toBe("warm");
    const told = await note(session.id);
    expect(told).toMatchObject({ plan: "tool", wait_kind: "tool:Bash", choice: "warm" });
    expect(told.pings).toBeGreaterThanOrEqual(2);
    expect(told.spent_usd).toBeLessThan(told.lapse_usd);
    const agentNote = await note(agent.session_id);
    expect(agentNote).toMatchObject({ plan: "park", wait_kind: "timer", choice: "warm", outcome: "warm", expect_from: "timer" });
    // The parent's step after the command read its cache too.
    const steps = (await events(session.id)).filter((e) => e.kind === "assistant");
    expect(steps.at(-1).data.usage.cache_write).toBe(0);

    // The timeline of the agent says what the wait did with its cache, and the cost.
    await page.goto(`${d.url}/s/${agent.session_id}`);
    await openPanel(page, "timeline");
    const row = page.getByTestId("timeline-row").filter({ hasText: "Kept the prompt cache warm" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute("data-kind", "cache");
    await expect(row).toContainText("where writing the context again would cost");
    await shoot(page, "cache-plan-agent-timeline");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
