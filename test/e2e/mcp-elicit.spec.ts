import { expect, test } from "./isolate.ts";
import type { Page } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionsFolder, specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: an MCP server that asks the owner a question while it works on a
// call (elicitation, form mode), or sends the owner to a page (URL mode), and
// a tool that runs as a task. The question is a card under the call: it
// names the server, shows the server's words as plain text, takes an answer
// checked against the server's schema, and can be declined. A stopped turn is
// the protocol's cancel. Both protocol eras: a legacy server asks with a
// request of its own, a modern one with an input_required result.
// Each test runs its own daemon on the scripted stand-in; the server is the
// stand-in under fixtures/ask-mcp.ts.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const FIXTURE = join(import.meta.dirname, "fixtures/ask-mcp.ts");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", sessionsFolder(state)], {
    env: specEnv(state, { KEEL_DRAIN_MS: "20000" }),
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
    // The id of the server's question that is on the session's card now.
    asked: async (id: string) => ((await call(`/api/cli/state/${id}`, undefined, "GET")).questions as any[]).find((q) => q.asked)?.asked.id as string | undefined,
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

    // 7. Both servers were told what Keel offers: both modes of elicitation.
    for (const [tool, n] of [["asker__caps", 5], ["modern__caps", 6]] as const) {
      await run(page, tool);
      await ends(n);
      await expect(last).toContainText('"elicitation":{"form":{},"url":{}}');
    }

    // 8. Two questions in one call, one after the other: the second is a card
    // of its own, empty, and takes its answer.
    await run(page, "asker__twice");
    await expect(words).toContainText("First question: go on?", { timeout: 30_000 });
    const firstQuestion = await k.asked(id);
    const [twice] = await k.pending(id);
    // The keyboard: a server's card takes none by itself, and what was typed
    // ahead of it (a number, Enter) goes to the message box and answers nothing.
    const box = page.getByTestId("composer");
    await expect(box).toBeFocused();
    expect(await card.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await page.keyboard.press("1");
    await expect(box).toHaveValue("1");
    await box.fill("");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    expect(await k.pending(id)).toEqual([twice]);
    await expect(card.locator('[aria-checked="true"]')).toHaveCount(0);
    // The owner goes to the card. A number picks there, and does not answer:
    // this card is one question with one choice, which on the agent's own
    // question one number answers.
    await page.keyboard.press("Shift+Tab"); // (the card stands before the message box)
    await expect.poll(() => card.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.waitForTimeout(400);
    await page.keyboard.press("1");
    await expect(card.getByTestId("question-option").filter({ hasText: "Yes" })).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(300);
    expect(await k.pending(id)).toEqual([twice]);
    // Enter on Answer sends what is shown chosen. (The keyboard came in on the card's last button, Decline: Answer is before it.)
    await page.keyboard.press("Shift+Tab");
    await expect(card.getByTestId("question-submit")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(words).toContainText("Second question: which name?");
    // The first answer sent again (a double click, a retry) does not answer the second question unseen.
    expect((await k.call(`/api/sessions/${id}/questions/${twice}`, { answers: { ok: { picked: ["Yes"] } }, question: firstQuestion })).status).toBe(409);
    expect((await k.call(`/api/sessions/${id}/questions/${twice}`, { answers: { ok: { picked: ["Yes"] } } })).status).toBe(409);
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
    // No key gets past the gate: Enter in a field or on the card says what is
    // missing and sends nothing, and letters typed on the card (not in a
    // field) are dropped, not passed on to the message box.
    await field(2).fill("key-not-kept");
    await field(1).click(); // (the owner's own press: the keyboard is theirs there)
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("question-nudge")).toHaveText('Tick "Send anyway" first, or decline');
    await card.getByTestId("question-from").click();
    await page.keyboard.type("s3cret");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await expect(page.getByTestId("composer")).toHaveValue("");
    expect(await k.pending(id)).toEqual([open]);
    const question = await k.asked(id);
    const typed = { answers: { user: { picked: [], other: "ada" }, password: { picked: [], other: "x" } } };
    // Not sent without the owner's word, and that word is for this question only.
    expect(await k.call(`/api/sessions/${id}/questions/${open}`, { ...typed, question })).toMatchObject({ status: 409, error: expect.stringContaining("looks like a secret") });
    expect(await k.call(`/api/sessions/${id}/questions/${open}`, { ...typed, send_anyway: true, question: "another" })).toMatchObject({ status: 409, error: expect.stringContaining("not the one this answers") });
    expect(await k.pending(id)).toEqual([open]);
    await shoot(page, "mcp-elicit-04-secret");
    await card.getByTestId("question-send-anyway").check();
    await expect(card.getByTestId("question-submit")).toBeEnabled();
    await card.getByTestId("question-decline").click();
    await ends(9);
    await expect(last).toContainText('secret: {"action":"decline"}');

    // 11. A form of twenty fields scrolls in the region above the message box,
    // under the card's own row of buttons: Answer and Decline stay in reach.
    await run(page, "asker__tall");
    await expect(words).toContainText("A long form.", { timeout: 30_000 });
    await expect(card.locator("fieldset")).toHaveCount(20);
    const tray = page.getByTestId("composer-tray");
    expect(await tray.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    await expect(card.getByTestId("question-submit")).toBeInViewport();
    await expect(card.getByTestId("question-decline")).toBeInViewport();
    await card.locator("fieldset").nth(19).scrollIntoViewIfNeeded();
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

    // After five declines in one call its next question ends the call: the
    // server is not answered "no choice" for as long as it likes to ask.
    await run(page, "asker__forever");
    for (let i = 1; i <= 5; i++) {
      await expect(words).toContainText(`Question ${i}: go on?`, { timeout: 30_000 });
      await card.getByTestId("question-decline").click();
    }
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    expect((await k.results(id)).at(-1)).toBe("asker__forever was ended: asker went on asking after the owner declined 5 of its questions in this call. Its work may be half done: check before calling it again.");
    // The server went with its call: what it would have asked next reaches no later call (it is started again for the next one).
    await page.waitForTimeout(500);
    expect(k.answers().filter((a) => a.tool === "forever")).toEqual([]);

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
    expect((await k.results(id)).at(-1)).toBe("asker__forever was ended: asker asked more than 20 questions in this call. Its work may be half done: check before calling it again.");

    // A server of the newer protocol that asks again after every answer, and
    // one whose form cannot be shown (no owner is needed to answer it): each
    // call ends, and the daemon is not kept answering.
    await run(page, "modern__loop");
    for (let i = 1; i <= 5; i++) {
      await expect(words).toContainText(`Round ${i}: go on?`, { timeout: 30_000 });
      await card.getByTestId("question-decline").click();
    }
    await expect(page.getByTestId("turn-end")).toHaveCount(4, { timeout: 30_000 });
    expect((await k.results(id)).at(-1)).toBe("modern__loop was ended: modern went on asking after the owner declined 5 of its questions in this call. Its work may be half done: check before calling it again.");
    await run(page, "modern__blind");
    await expect(page.getByTestId("turn-end")).toHaveCount(5, { timeout: 30_000 });
    expect((await k.results(id)).at(-1)).toContain("modern__blind was ended: modern asked the owner a form that cannot be answered: its field where is an object, which a form does not have. It asked 11 questions that could not be put to the owner.");
    await run(page, "modern__folders");
    await expect(page.getByTestId("turn-end")).toHaveCount(6, { timeout: 30_000 });
    expect((await k.results(id)).at(-1)).toBe("modern__folders was ended: modern asked for the session's folder more than 20 times in this call. Its work may be half done: check before calling it again.");

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
    await k.call(`/api/sessions/${reader}/questions/${again}`, { decline: true, question: await k.asked(reader) });
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

// Feature: a server asks for a reply of the session's model (MCP sampling).
// The owner sees the whole request and allows it or not; only then does the
// model answer, and the owner sees the reply before it goes back, or types
// another. A declined card is the protocol's rejection.
test("a server's sampling request is the owner's to allow, and its reply the owner's to send", async ({ page }) => {
  const k = await setup("sample");
  try {
    const id = await k.session("A server asks for the model");
    const last = page.getByTestId("assistant-text").last();
    const ends = (n: number) => expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
    const card = page.getByTestId("question");
    const words = card.getByTestId("question-message");
    await page.goto(`${k.at.d.url}/s/${id}`);

    // 1. The request on a card: the server, the model, the system prompt and the messages, whole.
    await run(page, "asker__sample");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server asker is asking");
    await expect(card.getByTestId("question-label")).toHaveText(/^What asker would send to /);
    await expect(card).toContainText(/About \d+ tokens of the model's window of \d+; (it costs at most about \$[\d.]+ at the list price|no price is known for it)\./);
    await expect(words).toContainText("You answer geography questions in one sentence.");
    await expect(words).toContainText("What is the capital of France?");
    await expect(card).toContainText("It would prefer claude-3-sonnet");
    await shoot(page, "mcp-sample-01-request");

    // 2. Declined: the server gets the rejection, and no reply card follows (the model was not asked).
    await card.getByTestId("question-decline").click();
    await ends(1);
    await expect(last).toContainText('sample: {"code":-1,"message":"the owner rejected the sampling request"}');
    await expect(card).toHaveCount(0);

    // 3. Allowed: the model answers, and the reply waits on the card for the owner.
    await run(page, "asker__sample");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "Send" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card.getByTestId("question-label")).toHaveText(/'s reply, for asker$/, { timeout: 30_000 });
    await expect(words).toContainText("Paris is the capital of France.");
    await shoot(page, "mcp-sample-02-reply");
    await card.getByTestId("question-option").filter({ hasText: "Send" }).click();
    await card.getByTestId("question-submit").click();
    await ends(2);
    await expect(last).toContainText('"content":{"type":"text","text":"Paris is the capital of France."}');
    await expect(last).toContainText('"stopReason":"endTurn"');

    // 4. The owner types another reply: that is what the server gets.
    await run(page, "asker__sample");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "Send" }).click();
    await card.getByTestId("question-submit").click();
    await expect(card.getByTestId("question-label")).toHaveText(/'s reply, for asker$/, { timeout: 30_000 });
    await card.getByTestId("question-other").first().fill("Paris.");
    await card.getByTestId("question-submit").click();
    await ends(3);
    await expect(last).toContainText('"text":"Paris."');

    // 5. A request the model cannot read is refused before any card.
    await run(page, "asker__sample_big");
    await ends(4);
    await expect(last).toContainText("over");
    await expect(last).toContainText("window");
    await expect(card).toHaveCount(0);

    // 6. Both servers were told Keel offers sampling.
    await run(page, "asker__caps");
    await ends(5);
    await expect(last).toContainText('"sampling":{}');
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});

// URL mode: the card shows the page's whole address with its site apart; the
// owner opens it in their own browser, which is the answer, and nothing of
// Keel's opens or fetches it. A call the server refuses until a step on a page
// is done (-32042) waits on a card for the step, and runs again when the
// server says it is done.
test("an MCP server sends the owner to a page, which only the owner's browser opens", async ({ page }) => {
  const k = await setup("link");
  try {
    const id = await k.session("A server sends the owner to a page");
    const last = page.getByTestId("assistant-text").last();
    const ends = (n: number) => expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
    // The payment page, as the owner's browser would get it: only a request from the page's own tab reaches it.
    const paid: string[] = [];
    await page.context().route("https://pay.example.test/**", (r) => { paid.push(r.request().url()); return r.fulfill({ contentType: "text/html", body: "<title>Pay</title><p>Paid.</p>" }); });
    await page.goto(`${k.at.d.url}/s/${id}`);

    // 1. The card: the server's words, the site set apart, the whole address,
    // and a link that opens it in a tab of its own. Enter on the card opens nothing.
    await run(page, "asker__link");
    const card = page.getByTestId("question");
    await expect(card).toHaveAttribute("data-state", "open", { timeout: 30_000 });
    await expect(card.getByTestId("question-from")).toHaveText("MCP server asker is asking");
    await expect(card.getByTestId("question-message")).toContainText("Pay for order 7 on the payment page.");
    await expect(card.getByTestId("question-host")).toHaveText("pay.example.test");
    await expect(card.getByTestId("question-url")).toHaveText("https://pay.example.test/checkout?order=7");
    const open = card.getByTestId("question-open");
    await expect(open).toHaveText("Open pay.example.test");
    await expect(open).toHaveAttribute("href", "https://pay.example.test/checkout?order=7");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(card.getByTestId("question-submit")).toHaveCount(0);
    await expect(page.getByTestId("station-word")).toHaveText("Needs you");
    await shoot(page, "mcp-elicit-10-link");
    const [asked] = await k.pending(id);
    await card.getByTestId("question-from").click();
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await expect(card.getByTestId("question-nudge")).toHaveText("Open the page with its link, or decline");
    expect(await k.pending(id)).toEqual([asked]);
    expect(paid).toEqual([]);

    // 2. Open: the owner's browser opens the page in a tab that cannot reach this one, and the server is told the owner went.
    const popup = page.waitForEvent("popup");
    await open.click();
    const tab = await popup;
    await expect.poll(() => paid).toEqual(["https://pay.example.test/checkout?order=7"]);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
    await ends(1);
    await expect(last).toContainText('link: {"action":"accept"}');
    await expect(card).toHaveCount(0);

    // 3. An address that imitates another site's: the site is the one after the @, and the card says what to know.
    await run(page, "asker__spoof");
    await expect(card.getByTestId("question-host")).toHaveText("xn--pypal-4ve.com", { timeout: 30_000 });
    await expect(card.getByTestId("question-notes")).toHaveText([
      "The site's name is written in Punycode, and reads as p\u0430ypal.com: letters of another alphabet can imitate a known site's name.",
      "The address has a name before an @ sign: the site is xn--pypal-4ve.com, whatever comes before the @.",
      "The page is not on HTTPS: what is typed there travels unencrypted.",
    ]);
    await shoot(page, "mcp-elicit-11-link-spoof");
    await card.getByTestId("question-decline").click();
    await ends(2);
    await expect(last).toContainText('spoof: {"action":"decline"}');

    // 4. An address that is no web page is not shown: the server is told why.
    await run(page, "asker__badlink");
    await ends(3);
    await expect(card).toHaveCount(0);
    await expect(last).toContainText("keel did not show the page: keel sends the owner only to http and https pages, not javascript: addresses");

    // 5. A call the server refuses until a step on its page is done (-32042):
    // the page, then a card that waits. Cancelled there, the model is told
    // the call did not run, and nothing opened the page but the owner's tab.
    // (The tab gets a page of the test's own this time: the server never hears of it.)
    const held: string[] = [];
    await page.context().route("**/connect?elicitationId=*", (r) => { held.push(r.request().url()); return r.fulfill({ contentType: "text/html", body: "<title>Connect</title><p>Not yet.</p>" }); });
    const opened = () => k.answers().filter((a) => a.page);
    await run(page, "asker__gate");
    await expect(card.getByTestId("question-message")).toContainText("Connect your Example Co account to list its files.", { timeout: 30_000 });
    await expect(card.getByTestId("question-host")).toHaveText("127.0.0.1");
    let tabs = page.waitForEvent("popup");
    await open.click();
    let gateTab = await tabs;
    await expect(card.getByTestId("question-waiting")).toHaveText("The call runs again when asker says the step is done, or when you press I finished.");
    await expect(card.getByTestId("question-submit")).toHaveText("I finished");
    await expect(open).toHaveText("Open again");
    await expect(card.getByTestId("question-decline")).toHaveText("Cancel");
    await expect.poll(() => held.length).toBe(1);
    await shoot(page, "mcp-elicit-12-link-waiting");
    await card.getByTestId("question-decline").click();
    await ends(4);
    const cancelled = (await k.results(id)).at(-1)!;
    expect(cancelled).toContain("asker__gate did not run: asker needs the owner to finish a step at 127.0.0.1 in their browser first (an MCP URL elicitation), and the owner cancelled it.");
    await gateTab.close();
    expect(opened()).toEqual([]);

    // 6. Again, and this time the page loads: the server says the step is done, the card closes by itself, and the call runs.
    await page.context().unroute("**/connect?elicitationId=*");
    await run(page, "asker__gate");
    await expect(card.getByTestId("question-host")).toHaveText("127.0.0.1", { timeout: 30_000 });
    tabs = page.waitForEvent("popup");
    await open.click();
    gateTab = await tabs;
    await ends(5);
    await expect(last).toContainText("gate: connected, 3 files listed");
    expect(opened()).toEqual([{ page: "opened", id: "gate-2" }]);
    await gateTab.close();
    await expect(card).toHaveCount(0);
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});

// Tasks: a legacy server's tool that requires a task is called as one; a
// modern server answers with a task by itself. Keel follows the task to its
// result, puts what the task asks to the owner, and cancels a task whose turn
// the owner stopped.
test("a tool that runs as a task is followed to its result, asks through it, and is cancelled with its turn", async ({ page }) => {
  const k = await setup("tasks");
  try {
    const id = await k.session("Tools that run as tasks");
    const last = page.getByTestId("assistant-text").last();
    const ends = (n: number) => expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 30_000 });
    const tasks = () => k.answers().filter((a) => a.task);
    await page.goto(`${k.at.d.url}/s/${id}`);

    // 1. Legacy: the call asks for a task, Keel looks at it until it ends and takes its result.
    await run(page, "asker__job");
    await ends(1);
    await expect(last).toContainText("job: done as task job-1");
    const legacy = tasks().filter((a) => a.id === "job-1").map((a) => a.task);
    expect(legacy[0]).toBe("created");
    expect(legacy).toContain("tasks/get");
    expect(legacy.at(-1)).toBe("tasks/result");

    // 2. Modern: the server's own task; the result comes with the task.
    await run(page, "modern__job");
    await ends(2);
    await expect(last).toContainText("job: done as task job-1");

    // 3. A legacy task that asks: the question comes while Keel waits for the result, on the call's card.
    const card = page.getByTestId("question");
    await run(page, "asker__job_ask");
    await expect(card.getByTestId("question-message")).toContainText("The task needs your word: go on?", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "Yes" }).click();
    await card.getByTestId("question-submit").click();
    await ends(3);
    await expect(last).toContainText('job_ask: {"action":"accept","content":{"ok":true}} as task job_ask-2');

    // 4. A modern task that asks: its question is in the task, the answer goes back with tasks/update.
    await run(page, "modern__job_ask");
    await expect(card.getByTestId("question-message")).toContainText("The task needs your word: go on?", { timeout: 30_000 });
    await card.getByTestId("question-option").filter({ hasText: "No" }).click();
    await card.getByTestId("question-submit").click();
    await ends(4);
    await expect(last).toContainText('job_ask: {"action":"accept","content":{"ok":false}} as task job_ask-2');
    expect(tasks().filter((a) => a.task === "tasks/update")).toEqual([{ task: "tasks/update", id: "job_ask-2", answers: { q: { action: "accept", content: { ok: false } } } }]);

    // 5. The owner stops a turn whose task never ends: the task is cancelled.
    await run(page, "asker__job_long");
    await expect.poll(() => tasks().some((a) => a.task === "tasks/get" && a.id === "job_long-3"), { timeout: 30_000 }).toBe(true);
    await k.call(`/api/sessions/${id}/interrupt`, { by: "owner" });
    await ends(5);
    await expect.poll(() => tasks().filter((a) => a.task === "tasks/cancel").map((a) => a.id)).toEqual(["job_long-3"]);
    expect(await k.errors()).toEqual([]);
  } finally {
    await k.stop();
  }
});
