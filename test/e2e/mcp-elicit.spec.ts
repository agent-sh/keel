import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an MCP server that asks the owner a question while it works on a
// call (elicitation, form mode). The question is a card under the call: it
// names the server, shows the server's words as plain text, takes an answer
// checked against the server's schema, and can be declined. A stopped turn is
// the protocol's cancel. A card waiting at a daemon stop does not hold the
// drain and is back after the restart. Both protocol eras: a legacy server
// asks with a request of its own, a modern one with an input_required result.
// The spec runs its own daemon on the scripted stand-in; the server is the
// stand-in under fixtures/ask-mcp.ts.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const FIXTURE = join(import.meta.dirname, "fixtures/ask-mcp.ts");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], {
    env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config"), KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "20000", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("an MCP server's question is a card the owner answers, declines or leaves", async ({ page }) => {
  const state = join(ROOT, `mcp-elicit-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const log = join(state, "asked.jsonl");
  const answers = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let d = await daemon(state);
  try {
    const call = (path: string, body?: unknown, method = "POST") =>
      fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
    for (const [name, args] of [["asker", [FIXTURE]], ["modern", [FIXTURE, "--modern"]]] as const) {
      await call("/api/mcp/servers", { name, command: "bun", args, env: { ASK_MCP_LOG: log } });
    }
    await expect.poll(async () => ((await call("/api/mcp/servers", undefined, "GET")).servers as any[]).filter((s) => s.state === "ready").map((s) => `${s.name}:${s.era}`).sort(), { timeout: 30_000 }).toEqual(["asker:legacy", "modern:modern"]);
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "A server asks" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    const pending = async () => (await call(`/api/sessions/${session.id}/questions`, undefined, "GET")).pending as string[];
    const run = async (tool: string) => {
      await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "mcp_call", input: { tool, arguments: {} } }])}`);
      await page.keyboard.press("Enter");
    };
    const last = page.getByTestId("assistant-text").last();
    await page.goto(`${d.url}/s/${session.id}`);

    // 1. The card: the server by name, its words as text, the fields of its schema.
    await run("asker__ask");
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server asker is asking");
    const words = card.getByTestId("question-message");
    await expect(words).toContainText("From the server");
    await expect(words).toContainText("Which account should the report use?");
    // Markup stays text, the reversing character is gone, and nothing of it is a note of the harness.
    await expect(words).toContainText('<img src=x onerror="document.title=\'pwned\'">');
    await expect(card.locator("img")).toHaveCount(0);
    expect(await page.title()).not.toBe("pwned");
    expect(await words.textContent()).not.toContain("\u202e");
    await expect(page.getByTestId("note").filter({ hasText: "approved every call" })).toHaveCount(0);
    await expect(card.locator("fieldset")).toHaveCount(3);
    await expect(card.locator("fieldset").nth(0)).toContainText("Account name: As it appears on the invoice");
    await expect(card.locator("fieldset").nth(1)).toContainText("Report size (left empty: Short)");
    await expect(page.getByTestId("station-word")).toHaveText("Needs you");
    await shoot(page, "mcp-elicit-01-card");

    // 2. An answer the schema does not take is asked again, with what was wrong.
    const field = (n: number) => card.getByTestId("question-other").nth(n);
    await field(0).fill("ab");
    await field(2).fill("9");
    await card.getByTestId("question-submit").click();
    await expect(card.getByTestId("question-note")).toHaveText("Account name needs at least 3 characters. Copies must be at most 5.");
    await expect(field(0)).toHaveValue("ab"); // what was typed is still there to correct
    await shoot(page, "mcp-elicit-02-asked-again");

    // 3. A good answer goes to the server as the content its schema asks for.
    await field(0).fill("Acme Ltd");
    await card.getByTestId("question-option").filter({ hasText: "Long" }).click();
    await field(2).fill("2");
    await card.getByTestId("question-submit").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await expect(last).toContainText('ask: {"action":"accept","content":{"account":"Acme Ltd","size":"l","copies":2}}');
    await expect(card).toHaveCount(0);

    // 4. Declined: the protocol's decline.
    await run("asker__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await card.getByTestId("question-decline").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    await expect(last).toContainText('ask: {"action":"decline"}');

    // 5. The owner stops the turn with the card open: the protocol's cancel.
    await run("asker__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await call(`/api/sessions/${session.id}/interrupt`, { by: "owner" });
    await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 });
    await expect.poll(() => answers().at(-1)).toEqual({ tool: "ask", era: "legacy", answer: { action: "cancel" } });

    // 6. A modern server asks with an input_required result; the answer goes back with its state.
    await run("modern__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server modern is asking");
    await field(0).fill("Brook and Sons");
    await field(2).fill("1");
    await card.getByTestId("question-submit").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 30_000 });
    expect(answers().at(-1)).toEqual({ tool: "ask", era: "modern", answer: { action: "accept", content: { account: "Brook and Sons", size: "s", copies: 1 } }, requestState: "state-1" });

    // 7. Both servers were told what Keel offers.
    for (const [tool, n] of [["asker__caps", 5], ["modern__caps", 6]] as const) {
      await run(tool);
      await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
      await expect(last).toContainText('"elicitation":{"form":{}}');
    }

    // 8. A card open at a daemon stop: the drain does not wait for it, and the
    // next daemon asks again on the same call.
    await run("asker__ask");
    await expect.poll(pending, { timeout: 30_000 }).toHaveLength(1);
    const [waiting] = await pending();
    const t0 = Date.now();
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    expect(Date.now() - t0).toBeLessThan(5_000);
    d = await daemon(state);
    await expect.poll(pending, { timeout: 60_000 }).toEqual([waiting]);
    await page.goto(`${d.url}/s/${session.id}`);
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await field(0).fill("After the restart");
    await field(2).fill("3");
    await card.getByTestId("question-submit").click();
    await expect.poll(async () => ((await call(`/api/sessions/${session.id}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "tool_result").map((e) => e.data.results[0].content).at(-1), { timeout: 30_000 })
      .toContain('"account":"After the restart"');
    await shoot(page, "mcp-elicit-03-after-restart");
    expect(((await call("/api/errors?resolved=0", undefined, "GET")).errors as any[]).filter((e) => e.context?.at !== "listing")).toEqual([]);
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
