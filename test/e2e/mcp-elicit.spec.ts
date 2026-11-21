import { expect, test } from "./isolate.ts";
import type { Page } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: an MCP server that asks the owner a question while it works on a
// call (elicitation, form mode). The question is a card under the call: it
// names the server, shows the server's words as plain text, takes an answer
// checked against the server's schema, and can be declined. A stopped turn is
// the protocol's cancel. Both protocol eras: a legacy server asks with a
// request of its own, a modern one with an input_required result.
// Each test runs its own daemon on the scripted stand-in; the server is the
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

// A daemon of the test's own with the stand-in connected three times (two
// servers of the older protocol era and one of the newer), and what the tests
// do with it.
async function setup(name: string, env: Record<string, string> = {}) {
  const state = join(ROOT, `mcp-elicit-${name}-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const log = join(state, "asked.jsonl"), side = join(state, "side.txt");
  const at = { d: await daemon(state) };
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(at.d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json() as any) }));
  for (const [server, args] of [["asker", [FIXTURE]], ["second", [FIXTURE]], ["modern", [FIXTURE, "--modern"]]] as const) {
    await call("/api/mcp/servers", { name: server, command: "bun", args, env: { ASK_MCP_LOG: log, ASK_MCP_SIDE: side, ...env } });
  }
  await expect.poll(async () => ((await call("/api/mcp/servers", undefined, "GET")).servers as any[]).filter((s) => s.state === "ready").map((s) => `${s.name}:${s.era}`).sort(), { timeout: 30_000 }).toEqual(["asker:legacy", "modern:modern", "second:legacy"]);
  const session = async (title: string) => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    return session.id as string;
  };
  return {
    at, state, call, session,
    restart: async (how: "SIGTERM" | "SIGKILL") => {
      const t0 = Date.now();
      at.d.proc.kill(how);
      await exited(at.d.proc);
      const took = Date.now() - t0;
      at.d = await daemon(state);
      return took;
    },
    // What the server was answered, a line per call, and what it did besides.
    answers: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    side: () => (existsSync(side) ? readFileSync(side, "utf8").trim().split("\n") : []),
    send: (id: string, tool: string) => call(`/api/sessions/${id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "mcp_call", input: { tool, arguments: {} } }])}` }),
    pending: async (id: string) => (await call(`/api/sessions/${id}/questions`, undefined, "GET")).pending as string[],
    results: async (id: string) => ((await call(`/api/sessions/${id}`, undefined, "GET")).events as any[]).filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content)),
    errors: async () => ((await call("/api/errors?resolved=0", undefined, "GET")).errors as any[]).filter((e) => e.context?.at !== "listing"),
    stop: async () => {
      at.d.proc.kill("SIGKILL");
      await exited(at.d.proc);
      rmSync(state, { recursive: true, force: true });
    },
  };
}
const run = async (page: Page, tool: string) => {
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "mcp_call", input: { tool, arguments: {} } }])}`);
  await page.keyboard.press("Enter");
};

test("an MCP server's question is a card the owner answers, declines or leaves", async ({ page }) => {
  const k = await setup("card");
  try {
    const id = await k.session("A server asks");
    const last = page.getByTestId("assistant-text").last();
    const ends = (n: number) => expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
    await page.goto(`${k.at.d.url}/s/${id}`);

    // 1. The card: the server by name, its words as text, the fields of its schema.
    await run(page, "asker__ask");
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server asker is asking");
    const words = card.getByTestId("question-message");
    await expect(words).toContainText("From the server");
    await expect(words).toContainText("Which account should the report use?");
    // Markup stays text, what draws nothing or reverses the text is gone, and none of it is a note of the harness.
    await expect(words).toContainText('<img src=x onerror="document.title=\'pwned\'">');
    await expect(card.locator("img")).toHaveCount(0);
    expect(await page.title()).not.toBe("pwned");
    expect(await words.textContent()).toMatch(/approved every call\.$/);
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
    await ends(1);
    await expect(last).toContainText('ask: {"action":"accept","content":{"account":"Acme Ltd","size":"l","copies":2}}');
    await expect(card).toHaveCount(0);

    // 4. Declined: the protocol's decline.
    await run(page, "asker__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await card.getByTestId("question-decline").click();
    await ends(2);
    await expect(last).toContainText('ask: {"action":"decline"}');

    // 5. The owner stops the turn with the card open: the protocol's cancel.
    await run(page, "asker__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await k.call(`/api/sessions/${id}/interrupt`, { by: "owner" });
    await ends(3);
    await expect.poll(() => k.answers().at(-1)).toEqual({ tool: "ask", era: "legacy", answer: { action: "cancel" } });

    // 6. A modern server asks with an input_required result; the answer goes back with its state.
    await run(page, "modern__ask");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server modern is asking");
    await field(0).fill("Brook and Sons");
    await field(2).fill("1");
    await card.getByTestId("question-submit").click();
    await ends(4);
    expect(k.answers().at(-1)).toEqual({ tool: "ask", era: "modern", answer: { action: "accept", content: { account: "Brook and Sons", size: "s", copies: 1 } }, requestState: "state-1" });

    // 7. Both servers were told what Keel offers.
    for (const [tool, n] of [["asker__caps", 5], ["modern__caps", 6]] as const) {
      await run(page, tool);
      await ends(n);
      await expect(last).toContainText('"elicitation":{"form":{}}');
    }

    // 8. Two questions in one call, one after the other: the second is a card
    // of its own, empty, and takes its answer.
    await run(page, "asker__twice");
    await expect(words).toContainText("First question: go on?", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "Yes" }).click();
    await card.getByTestId("question-submit").click();
    await expect(words).toContainText("Second question: which name?");
    await expect(card.getByTestId("question-option")).toHaveCount(0);
    await expect(card.getByTestId("question-decline")).toBeEnabled();
    await expect(field(0)).toHaveValue("");
    await field(0).fill("Heron");
    await expect(card.getByTestId("question-submit")).toBeEnabled();
    await shoot(page, "mcp-elicit-03-second-question");
    await card.getByTestId("question-submit").click();
    await ends(7);
    await expect(last).toContainText('twice: [{"action":"accept","content":{"ok":true}},{"action":"accept","content":{"name":"Heron"}}]');

    // 9. Fields named like an object's own parts are fields like any other.
    await run(page, "asker__odd");
    await expect(words).toContainText("Odd names.", { timeout: 30_000 });
    await expect(card.getByTestId("question-submit")).toBeDisabled(); // the required one is empty
    await field(0).fill("first");
    await card.getByTestId("question-submit").click();
    await ends(8);
    expect((await k.results(id)).at(-1)).toContain('odd: {"action":"accept","content":{"__proto__":"first"}}');

    // 10. A form that asks for a password: the card says a server must not,
    // masks what is typed, and sends nothing until the owner says to.
    await run(page, "asker__secret");
    await expect(words).toContainText("Sign in to the report service.", { timeout: 30_000 });
    await expect(card.getByTestId("question-notes")).toHaveText("The MCP specification says a server must not ask for passwords, API keys, access tokens or payment details in a form like this one.");
    expect(await card.getByTestId("question-other").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).type))).toEqual(["text", "password", "password"]);
    await field(0).fill("ada");
    await field(1).fill("hunter2-not-kept");
    await expect(card.getByTestId("question-submit")).toBeDisabled();
    const [open] = await k.pending(id);
    expect((await k.call(`/api/sessions/${id}/questions/${open}`, { answers: { user: { picked: [], other: "ada" }, password: { picked: [], other: "x" } } })).status).toBe(409);
    await shoot(page, "mcp-elicit-04-secret");
    await card.getByTestId("question-send-anyway").check();
    await expect(card.getByTestId("question-submit")).toBeEnabled();
    await card.getByTestId("question-decline").click();
    await ends(9);
    await expect(last).toContainText('secret: {"action":"decline"}');

    // 11. A form of twenty fields scrolls inside the card: the buttons stay in reach.
    await run(page, "asker__tall");
    await expect(words).toContainText("A long form.", { timeout: 30_000 });
    await expect(card.locator("fieldset")).toHaveCount(20);
    const fields = card.getByTestId("question-fields");
    expect(await fields.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    expect((await card.boundingBox())!.height).toBeLessThan(900);
    await card.getByTestId("question-submit").scrollIntoViewIfNeeded();
    await expect(card.getByTestId("question-submit")).toBeInViewport();
    await shoot(page, "mcp-elicit-07-long-form");
    await card.getByTestId("question-submit").click(); // every field is optional
    await ends(10);
    await expect(last).toContainText('tall: {"action":"accept","content":{}}');

    // 12. A form with a required field past the twenty a card shows cannot be
    // answered: no card, the server is told no choice was made, and the result says why.
    await run(page, "asker__wide");
    await ends(11);
    await expect(card).toHaveCount(0);
    const wide = (await k.results(id)).at(-1)!;
    expect(wide).toContain('wide: {"action":"cancel"}');
    expect(wide).toContain("[keel] asker asked the owner a form that cannot be answered: it needs a field beyond the 20 a card shows (f23). It was answered as if the owner made no choice.");
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});

// A server cannot hold the owner in an endless run of cards, and a question
// never lands in another session.
test("a server's questions are bounded, and none is shown in a session that did not ask", async ({ page }) => {
  const k = await setup("bounds", { ASK_MCP_FOREVER: "30", ASK_MCP_MANY: "12", ASK_MCP_HOLD: "5000" });
  try {
    const id = await k.session("A server that keeps asking");
    await page.goto(`${k.at.d.url}/s/${id}`);
    const card = page.getByTestId("question");
    const words = card.getByTestId("question-message");

    // After five declines in one call the rest of its questions get no card.
    await run(page, "asker__forever");
    for (let i = 1; i <= 5; i++) {
      await expect(words).toContainText(`Question ${i}: go on?`, { timeout: 30_000 });
      await card.getByTestId("question-decline").click();
    }
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    const forever = (await k.results(id)).at(-1)!;
    expect(k.answers().at(-1).answer).toEqual([...Array(5).fill("decline"), ...Array(25).fill("cancel")]);
    expect(forever).toContain("[keel] asker went on asking after the owner declined 5 of its questions in this call. It was answered as if the owner made no choice.");

    // Twelve at once: one card and five behind it; the rest are not kept waiting.
    await run(page, "asker__many");
    await expect(words).toContainText("Question 1 of many", { timeout: 30_000 });
    for (let i = 1; i <= 5; i++) {
      await expect(words).toContainText(`Question ${i} of many`);
      await card.getByTestId("question-option").filter({ hasText: "Yes" }).click();
      await card.getByTestId("question-submit").click();
    }
    await expect(words).toContainText("Question 6 of many");
    await card.getByTestId("question-decline").click();
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    expect(k.answers().at(-1).answer).toEqual([...Array(5).fill("accept"), "decline", ...Array(6).fill("cancel")]);
    expect((await k.results(id)).at(-1)).toContain("[keel] asker asked more than 5 questions at once: one card is shown at a time, and no more than that wait behind it. It was answered as if the owner made no choice.");

    // Twenty questions in one call are shown, each answered; the twenty-first is not.
    await run(page, "asker__forever");
    for (let i = 1; i <= 20; i++) {
      await expect(words).toContainText(`Question ${i}: go on?`, { timeout: 30_000 });
      await card.getByTestId("question-option").filter({ hasText: "Yes" }).click();
      await card.getByTestId("question-submit").click();
    }
    await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 30_000 });
    expect(k.answers().at(-1).answer).toEqual([...Array(20).fill("accept"), ...Array(10).fill("cancel")]);
    expect((await k.results(id)).at(-1)).toContain("[keel] asker asked more than 20 questions in this call. It was answered as if the owner made no choice.");

    // Two sessions with a call each on the one server: over stdio nothing names
    // the call a question belongs to, so nobody is asked, and both calls say so.
    const asker = await k.session("Asks late"), other = await k.session("Only waits");
    await k.send(asker, "asker__later");
    await page.waitForTimeout(500);
    await k.send(other, "asker__hold");
    await expect.poll(() => k.answers().find((a) => a.tool === "later")?.answer, { timeout: 30_000 }).toEqual({ action: "cancel" });
    expect([await k.pending(asker), await k.pending(other)]).toEqual([[], []]);
    const why = "asked the owner a question while this call ran and got no answer: calls of 2 sessions were in flight on this server, and nothing names the call such a request belongs to. If the result depends on it, run the call again when no other call is using asker.";
    await expect.poll(async () => (await k.results(asker)).at(-1), { timeout: 30_000 }).toContain(`[keel] asker ${why}`);
    await expect.poll(async () => (await k.results(other)).at(-1), { timeout: 30_000 }).toContain(`[keel] asker ${why}`);
    await page.goto(`${k.at.d.url}/s/${asker}`);
    const call = page.getByTestId("tool-call").last();
    await call.click();
    await expect(call).toContainText("got no answer");
    await shoot(page, "mcp-elicit-05-not-guessed");
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});

// A card open when the daemon stops does not hold the drain. What the next
// daemon does depends on the tool: one the owner marked as a read runs again,
// so the card is back; any other had begun its work before it asked, so it
// ends as a call the restart cut and is not run a second time. A server's
// own word that its tool only reads does not count.
test("a server's question across a daemon restart", async ({ page }) => {
  const k = await setup("restart");
  try {
    const reader = await k.session("Reads after asking"), worker = await k.session("Works around its question");
    expect((await k.call("/api/mcp/servers/asker/reads", { tools: ["look"] }, "PUT")).status).toBe(200);
    await k.send(reader, "asker__look");
    await k.send(worker, "second__work"); // a server of its own: one server's question is never guessed between two sessions
    await expect.poll(async () => [(await k.pending(reader)).length, (await k.pending(worker)).length], { timeout: 30_000 }).toEqual([1, 1]);
    expect(k.side()).toEqual(["effect-before-ask", "effect-before-ask"]);
    const [waiting] = await k.pending(reader);

    expect(await k.restart("SIGTERM")).toBeLessThan(5_000); // twenty seconds of drain were not waited for
    // The read-only call ran again and asks on the same call; the other did not.
    await expect.poll(() => k.pending(reader), { timeout: 60_000 }).toEqual([waiting]);
    expect(await k.pending(worker)).toEqual([]);
    expect(k.side().filter((l) => l === "effect-before-ask")).toHaveLength(3);
    await expect.poll(async () => (await k.results(worker)).at(-1), { timeout: 30_000 }).toBe("Interrupted by a daemon restart while this tool ran. It may have partly run: check its effects before running it again.");

    await page.goto(`${k.at.d.url}/s/${reader}`);
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "Yes" }).click();
    await card.getByTestId("question-submit").click();
    await expect.poll(async () => (await k.results(reader)).at(-1), { timeout: 30_000 }).toContain('look: {"action":"accept","content":{"ok":true}}');
    await shoot(page, "mcp-elicit-06-after-restart");

    // The same after a crash, and once the card is answered nothing is kept:
    // a restart then finds a call that had gone on, also for a read-only tool.
    await k.send(reader, "asker__look");
    await expect.poll(() => k.pending(reader), { timeout: 30_000 }).toHaveLength(1);
    await k.restart("SIGKILL");
    await expect.poll(() => k.pending(reader), { timeout: 60_000 }).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(k.state, "mcp-asked.json"), "utf8"))).toHaveLength(1);
    const [again] = await k.pending(reader);
    await k.call(`/api/sessions/${reader}/questions/${again}`, { decline: true });
    await expect.poll(async () => (await k.results(reader)).at(-1), { timeout: 30_000 }).toContain('look: {"action":"decline"}');
    expect(JSON.parse(readFileSync(join(k.state, "mcp-asked.json"), "utf8"))).toEqual([]);

    // The same tool on a server where only the server says it reads (its
    // hint): the owner did not mark it, so it is not run a second time.
    const claimer = await k.session("Its server says it only reads");
    await k.send(claimer, "second__look");
    await expect.poll(() => k.pending(claimer), { timeout: 30_000 }).toHaveLength(1);
    const begun = () => k.side().filter((l) => l === "effect-before-ask").length;
    const effects = begun();
    await k.restart("SIGTERM");
    await expect.poll(async () => (await k.results(claimer)).at(-1), { timeout: 60_000 }).toBe("Interrupted by a daemon restart while this tool ran. It may have partly run: check its effects before running it again.");
    expect(await k.pending(claimer)).toEqual([]);
    expect(begun()).toBe(effects); // its work was not begun a second time
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});
