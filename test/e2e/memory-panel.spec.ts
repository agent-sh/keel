import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type APIRequestContext, type Locator } from "./isolate.ts";
import { choose, shoot } from "./shots.ts";

// Feature: the owner sees, searches and corrects what memory holds from
// inside Keel. Settings > Usage > Memory has four views: Usage (the numbers),
// Given (what a session was told to remember, moment by moment: the
// session's start, a prompt, a tool call, each with the facts it handed over,
// what they cost and whether the turn named them after), Search (the store's
// own search, in its order) and Never named (facts given and never named
// afterwards first, tokens per session and per day, the share of calls that
// came late or with nothing). A long list is read a part at a time. A fact
// opens beside the list at a desk, where it stays in view, and under its row
// on a phone; it takes the keyboard without moving the page and gives it
// back to its row. A correction is sent through the store's own command only
// after the owner confirmed it with a key or a press they meant: the dialog
// opens on Cancel, its action takes no key for a moment, it does not open
// under an owner who moved on, and the request that sends names the one
// shown command, once. It is listed in the session's activity by the fact's
// name, never its words, and the next prompt's memory carries it. Editing in
// place and removing are the store's own page: Keel shows the command. Keel
// keeps names and ids only. A slow store is said, and nothing waits for it.
// A deleted session is said, and its rows go with it.
// The daemon runs with TACIT_BIN at test/e2e/fixtures/tacit-standin.sh.
const STAND_IN = "scripted:stand-in";

const ended = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBeGreaterThanOrEqual(n);
// Whether something stands inside the window, top and bottom.
const inView = async (l: Locator) => {
  const [box, size] = [await l.boundingBox(), l.page().viewportSize()!];
  return !!box && box.y >= 0 && box.y + Math.min(box.height, 40) <= size.height;
};

test("memory panel: what a session was told, the store's search, a correction the owner meant, facts given and never named", async ({ page, request }) => {
  const info = await (await request.get("/api/integrations")).json();
  test.skip(!info.tacit.bin?.includes("tacit-standin"), "needs the tacit stand-in (TACIT_BIN)");
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  // Words of this run's own: the notes corrections leave stay in the stand-in's store.
  const run = Date.now().toString(36);
  const word = `kingfisher${run}`, other = `bittern${run}`;
  const standInStore = join(dirname((await (await request.get("/api/daemon")).json()).state_dir), "tacit-store");

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Memory panel", text: "script:memory What is the code word?" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await ended(request, session.id, 1);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: 'script:calls [{"name":"Bash","input":{"command":"touch memory-panel-check.txt"}}]' } });
  await ended(request, session.id, 2);

  // What Keel recorded as it happened: one row per fact, its hook and its call, whether the turn named it. No text.
  const givenOf = async (id: string, before?: number) => (await (await request.get(`/api/memory/given?session_id=${id}${before ? `&before=${before}` : ""}`)).json());
  // A turn's facts are checked a moment after its last event: until then a row says its turn is not over.
  await expect.poll(async () => (await givenOf(session.id)).rows.some((g: any) => g.used === null)).toBe(false);
  const given = await givenOf(session.id);
  expect(given.rows.map((g: any) => [g.name, g.hook, g.call, g.used, g.open])).toEqual([["echo-rule", "pre-tool", "Bash", 1, false], ["code-word", "prompt", null, 1, false], ["keel-bun-e2e", "session-start", null, 0, false]]);
  // The session's sums, as every view counts them: the facts, the blocks that carried them, what the blocks added.
  expect(given).toMatchObject({ total: 3, facts: 3, blocks: 3, named: 2, checked: 3, more: false });
  expect(given.block_tokens).toBeGreaterThan(given.tokens);
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  expect(given.rows[1].ref).toBe(events.find((e) => e.kind === "user").id);
  expect(given.rows.every((g: any) => g.tokens > 0)).toBe(true);
  for (const text of ["heron", "tests are fine", "sessions of the e2e"]) expect(JSON.stringify(given)).not.toContain(text);
  expect((await request.get("/api/memory/given?session_id=nope")).status()).toBe(404);

  // From the session: the turn's memory chip opens the panel on this session.
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(2);
  await page.getByTestId("memory-note").first().getByRole("button").click();
  await page.getByTestId("memory-open").click();
  await expect(page).toHaveURL(new RegExp(`/settings/usage\\?view=memory&session=${session.id}`));
  const panel = page.getByTestId("usage-memory");
  // The session's story: a mark for each moment the store spoke, the facts it handed over under it.
  await expect(panel.getByTestId("memory-moment")).toHaveCount(3);
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(3);
  await expect(panel.getByTestId("memory-given-total")).toContainText("This session was told 3 facts at 3 moments");
  await expect(panel.getByTestId("memory-given-total")).toContainText("The model named 2 of the 3 checked afterwards");
  const row = (name: string) => panel.locator(`[data-testid="memory-given-row"][data-name="${name}"]`);
  const tool = panel.locator('[data-testid="memory-moment"][data-hook="pre-tool"]');
  await expect(tool).toContainText("Before a tool, Bash");
  await expect(tool.getByTestId("memory-given-row")).toHaveAttribute("data-name", "echo-rule");
  await expect(panel.locator('[data-testid="memory-moment"][data-hook="prompt"]')).toContainText("With a prompt");
  await expect(row("keel-bun-e2e").getByTestId("memory-given-used")).toHaveText("not named");
  await expect(row("code-word").getByTestId("memory-given-used")).toHaveText("named");
  // The range above sums nothing this view shows: it is not offered here.
  await expect(page.getByRole("radiogroup", { name: "Range" })).toHaveCount(0);
  await shoot(page, "memory-panel-01-given");

  // A click opens the fact, read from the store now: its text, the store's own line about it, its date.
  // The fact takes the keyboard; Escape closes it and the row has the keyboard again.
  await row("code-word").getByRole("button").click();
  const fact = panel.getByTestId("memory-fact");
  await expect(fact).toBeFocused();
  await expect(fact.getByTestId("memory-fact-body")).toHaveText("the code word for this test is heron");
  await expect(fact.getByTestId("memory-fact-whose")).toHaveText("whose: code-word is agent note (2026-01-02)");
  await expect(fact.getByTestId("memory-fact-meta")).toContainText("design decision");
  await expect(fact.getByTestId("memory-fact-meta")).toContainText("claude@standin");
  await expect(fact.getByTestId("memory-fact-meta")).toContainText("2026-01-02");
  // Editing in place and removing are the store's own page: one command, shown, and said to be the owner's to run.
  await expect(fact.getByTestId("memory-action-page")).toContainText("review --fact code-word");
  await expect(fact.getByTestId("memory-action-page")).toContainText("Keel has no command for either");
  // Beside the open fact no name is cut.
  expect(await panel.getByTestId("memory-given-row").getByRole("button").evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth))).toBe(true);
  await shoot(page, "memory-panel-02-fact");
  await page.keyboard.press("Escape");
  await expect(fact).toHaveCount(0);
  await expect(row("code-word").getByRole("button")).toBeFocused();
  // The reader comes after the list: from the row, Enter opens it and the correction box is a few Tabs on.
  await page.keyboard.press("Enter");
  await expect(fact).toBeFocused();
  await expect(fact.getByTestId("memory-fact-body")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(fact.getByTestId("memory-fact-close")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(fact.getByTestId("memory-correct-text")).toBeFocused();

  // A correction asks first, with the store's own command in full, in a box of its own, and under which writer.
  // The dialog opens on Cancel: the Enter that follows the one in the box sends nothing.
  const sent = async () => (await (await request.get(`/api/activity?session_id=${session.id}&kind=memory`)).json()).items as any[];
  const notes = async (w = word) => (await (await request.get(`/api/memory/search?q=${w}&inbox=1`)).json()).hits as any[];
  await page.keyboard.type(`the code word for this test is ${word}`);
  await page.keyboard.press("Enter");
  const confirm = page.getByTestId("confirm");
  await expect(confirm.getByTestId("confirm-code")).toHaveText(`tacit-standin.sh add --harness claude --kind user --type design_decision --scope user --desc 'the code word for this test is ${word}' --body 'Corrects code-word, which the owner marked wrong in Keel. the code word for this test is ${word}' code-word-correction`);
  await expect(confirm).toContainText("its writer claude: it has no writer for Keel");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shoot(page, "memory-panel-03-confirm");
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  expect(await notes()).toHaveLength(0);
  // The action takes no key while the dialog has only just taken the keyboard: Tab and Enter at once do nothing.
  await fact.getByTestId("memory-correct-text").press("Enter");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(confirm).toBeVisible();
  expect(await notes()).toHaveLength(0);
  // After it stood for the settle time, the key is the owner's answer: it goes through the store's own command.
  await page.waitForTimeout(1100);
  await page.keyboard.press("Enter");
  await expect(fact.getByTestId("memory-correct-result")).toContainText("inbox/claude@standin/code-word-correction.md");
  await shoot(page, "memory-panel-04-sent");
  expect((await notes()).map((h) => h.name)).toEqual(["code-word-correction"]);
  // The session's activity lists it by the fact's name and the note's path: none of the correction's words are kept.
  let activity = await sent();
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ kind: "memory", sub: "correction", session_id: session.id, data: { fact: "code-word", where: "inbox/claude@standin/code-word-correction.md" } });
  expect(JSON.stringify(activity)).not.toContain(word);
  expect(JSON.stringify(activity)).not.toContain("--desc");

  // A request alone sends nothing, whatever it says of itself: the answer is the command and a one-time id.
  const ask = async (data: object) => (await (await request.post("/api/memory/correct", { data })).json());
  const dry = await ask({ name: "echo-rule", text: `gnp.\u202Eexe ${other} is listed`, session_id: session.id, confirmed: true });
  expect(dry.state).toBe("confirm");
  expect(dry.words.join(" ")).toBe(dry.command);
  expect(await notes(other)).toHaveLength(0);
  expect((await ask({ confirm: "not-an-id" })).state).toBe("expired");
  expect((await request.post("/api/memory/correct", { data: { name: "echo-rule", text: "x".repeat(2001) } })).status()).toBe(400);
  // The id sends the shown command once. Sent again it does nothing. A command that a request from no page
  // asked for is said to be one, even when a page confirms it.
  const fromPage = (id: string) => page.evaluate((confirmId) => fetch("/api/memory/correct", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: confirmId }) }).then((x) => x.json()), id);
  expect((await fromPage(dry.id)).state).toBe("ok");
  expect((await ask({ confirm: dry.id })).state).toBe("expired");
  activity = await sent();
  expect(activity).toHaveLength(2);
  expect(activity[0].text).toContain("no page origin");
  expect(activity[0].data).toMatchObject({ fact: "echo-rule", origin: "none" });
  expect(activity[1].data.origin).toBeUndefined();
  expect(JSON.stringify(activity)).not.toContain(other);

  // The next prompt's memory carries the correction, and the list of what was given names it.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:memory Is it heron or ${word}?` } });
  await ended(request, session.id, 3);
  const after = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  expect(after.filter((e) => e.kind === "note" && e.data.memory).at(-1).data.text).toContain(`- code-word-correction: the code word for this test is ${word}`);
  expect((await givenOf(session.id)).rows[0]).toMatchObject({ name: "code-word-correction", hook: "prompt" });

  // The store's own search: its order and its score; a character that cannot be seen is spelled out; a result opens the fact.
  await fact.getByTestId("memory-fact-close").click();
  await panel.getByTestId("memory-tab-search").click();
  await panel.getByTestId("memory-search-input").fill("code word test");
  await panel.getByTestId("memory-search-go").click();
  await expect(panel.getByTestId("memory-hit")).toHaveCount(3);
  expect(await panel.getByTestId("memory-hit").evaluateAll((els) => els.map((e) => e.getAttribute("data-name")))).toEqual(["code-word", "keel-bun-e2e", "echo-rule"]);
  await expect(panel.getByTestId("memory-hit-score").first()).toHaveText("score 0.3");
  await panel.getByTestId("memory-search-inbox").click();
  const hit = (name: string) => panel.locator(`[data-testid="memory-hit"][data-name="${name}"]`);
  await expect(hit("code-word-correction")).toContainText("unreviewed note");
  await panel.getByTestId("memory-search-input").fill(other);
  await panel.getByTestId("memory-search-go").click();
  await expect(hit("echo-rule-correction").getByTestId("memory-hit-text")).toHaveText(`gnp.<U+202E>exe ${other} is listed`);
  await panel.getByTestId("memory-search-input").fill("code word test");
  await panel.getByTestId("memory-search-go").click();
  await hit("code-word-correction").getByRole("button").click();
  await expect(fact.getByTestId("memory-fact-whose")).toContainText("code-word-correction is your words");
  await shoot(page, "memory-panel-05-search");

  // The owner types a correction while the store is busy, and goes on to search. The dialog does not open
  // under the typing, the search gets its Enter and its words whole, and nothing is sent.
  mkdirSync(standInStore, { recursive: true });
  writeFileSync(join(standInStore, "fact-delay"), "3");
  try {
    await fact.getByTestId("memory-correct-text").fill(`a stray one ${word}`);
    await fact.getByTestId("memory-correct-text").press("Enter");
    await panel.getByTestId("memory-search-input").click();
    await panel.getByTestId("memory-search-input").fill("");
    await page.keyboard.type("heron and more", { delay: 150 });
    await page.keyboard.press("Enter");
    await expect(fact.getByTestId("memory-correct-result")).toContainText("Not sent: you had moved on", { timeout: 10_000 });
    await expect(confirm).toBeHidden();
    await expect(panel.getByTestId("memory-search-input")).toHaveValue("heron and more");
    await expect(panel.getByTestId("memory-search-count")).toContainText("in the store's own order");
    expect(await sent()).toHaveLength(2);
    await shoot(page, "memory-panel-06-moved-on");
  } finally {
    rmSync(join(standInStore, "fact-delay"), { force: true });
  }

  // A store that does not answer: said after the wait, and the daemon answers other requests meanwhile.
  await fact.getByTestId("memory-fact-close").click();
  await panel.getByTestId("memory-search-input").fill("standin:slow");
  await panel.getByTestId("memory-search-go").click();
  const t0 = Date.now();
  expect((await request.get("/api/daemon")).ok()).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2_000);
  await expect(panel.getByTestId("memory-trouble")).toHaveAttribute("data-state", "slow", { timeout: 15_000 });
  await shoot(page, "memory-panel-07-slow");

  // The list is headed for what it measures, with its caveat under the heading and no warning ink.
  // The figures are the strip every Usage view draws; a fact's bar is how often it was given.
  await panel.getByTestId("memory-tab-unused").click();
  await expect(page.getByRole("radiogroup", { name: "Range" })).toBeVisible();
  await expect(panel.getByTestId("memory-unused-title")).toContainText("Notes given, never named afterwards (rough)");
  await expect(panel.getByTestId("memory-unused-caveat")).toContainText("a rule is judged by the call it forbids");
  const unused = panel.getByTestId("memory-unused-list").getByTestId("memory-fact-row");
  await expect(unused).toHaveCount(1);
  await expect(unused.first()).toHaveAttribute("data-name", "keel-bun-e2e");
  await expect(unused.first().getByTestId("memory-fact-used")).toHaveText("given once, never named after");
  expect(await panel.locator("[class*=warn]").count()).toBe(0);
  await expect(panel.getByTestId("memory-used-list").getByTestId("memory-fact-row")).toHaveCount(3);
  await expect(panel.getByTestId("memory-stats").locator("[data-stat]")).toHaveCount(4);
  await expect(panel.getByTestId("memory-stats")).toContainText("Added to the context");
  await expect(panel.getByTestId("memory-per-session")).toContainText("Memory panel");
  await expect(panel.getByTestId("memory-days").locator("li")).toHaveCount(1);
  const eff = await (await request.get(`/api/memory/efficiency?session_id=${session.id}`)).json();
  expect(eff.calls).toMatchObject({ asked: 5, added: 4, late: 0, failed: 0 });
  expect(eff.facts[0]).toMatchObject({ name: "keel-bun-e2e", given: 1, checked: 1, used: 0 });
  expect(eff.total_facts).toBe(4);
  // One session's counts agree across the views: its facts, its blocks and the tokens they added.
  const now = await givenOf(session.id);
  expect([now.facts, now.blocks, now.block_tokens]).toEqual([eff.sessions[0].facts, eff.sessions[0].recalls, eff.calls.tokens]);
  await shoot(page, "memory-panel-08-never-named");
  // The search kept its words and its answer while another view showed.
  await panel.getByTestId("memory-tab-search").click();
  await expect(panel.getByTestId("memory-search-input")).toHaveValue("standin:slow");
  await expect(panel.getByTestId("memory-trouble")).toBeVisible();

  // A session that was told a great deal: the list is read a part at a time, never as one page.
  const long = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Memory panel, long", text: "script:memory standin:many What do you hold?" } })).json()).session;
  await ended(request, long.id, 1);
  await expect.poll(async () => (await givenOf(long.id)).checked).toBe(62);
  const first = await givenOf(long.id);
  expect(first).toMatchObject({ total: 62, more: true });
  expect(first.rows).toHaveLength(40);
  const rest = await givenOf(long.id, first.rows.at(-1).id);
  expect(rest.rows).toHaveLength(22);
  expect(rest.more).toBe(false);
  await page.goto(`/settings/usage?view=memory&session=${long.id}`);
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(40);
  await expect(panel.getByTestId("memory-part")).toHaveText("1 to 40 of 62");
  await panel.getByTestId("memory-older").click();
  await expect(panel.getByTestId("memory-part")).toHaveText("41 to 62 of 62");
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(22);
  await expect(panel.getByTestId("memory-older")).toBeDisabled();
  await panel.getByTestId("memory-newer").click();
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(40);
  // Far down the list, a fact opens where the owner is: the page does not jump, the fact stays in view beside
  // the list, and its row is still there. Closed, the row is in view with the keyboard.
  const far = row("many-22");
  await far.scrollIntoViewIfNeeded();
  await far.getByRole("button").click();
  await expect(fact.getByTestId("memory-fact-body")).toHaveText("filler fact 22 for a long list");
  expect(await inView(fact)).toBe(true);
  expect(await inView(far)).toBe(true);
  await shoot(page, "memory-panel-09-long-open");
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(200);
  expect(await inView(fact)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(far.getByRole("button")).toBeFocused();
  expect(await inView(far)).toBe(true);

  // On a phone: the views, and a fact that opens under its own row, read from its start.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(40);
  await far.scrollIntoViewIfNeeded();
  await far.getByRole("button").click();
  await expect(panel.getByTestId("memory-fact-under").getByTestId("memory-fact-body")).toHaveText("filler fact 22 for a long list");
  expect(await far.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid"))).toBe("memory-fact-under");
  expect(await inView(far)).toBe(true);
  expect(await inView(fact)).toBe(true);
  expect((await far.boundingBox())!.y).toBeLessThan(300);
  await shoot(page, "memory-panel-10-long-open-390x844");
  await fact.getByTestId("memory-fact-close").click();
  await expect(far.getByRole("button")).toBeFocused();
  expect(await inView(far)).toBe(true);
  await page.goto(`/settings/usage?view=memory&session=${session.id}`);
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(4);
  await shoot(page, "memory-panel-11-given-390x844");
  await row("code-word").getByRole("button").click();
  await expect(fact.getByTestId("memory-fact-body")).toHaveText("the code word for this test is heron");
  await expect(fact).toBeFocused();
  await shoot(page, "memory-panel-12-fact-390x844");
  await fact.getByTestId("memory-correct-text").fill("a phone check");
  await fact.getByTestId("memory-correct-send").click();
  await expect(confirm.getByTestId("confirm-code")).toBeVisible();
  await shoot(page, "memory-panel-13-confirm-390x844");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await fact.getByTestId("memory-fact-close").click();
  await panel.getByTestId("memory-tab-unused").click();
  await expect(panel.getByTestId("memory-stats")).toBeVisible();
  await shoot(page, "memory-panel-14-never-named-390x844");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1040 });

  // The writer a correction is recorded under is a setting, shown where memory is set up: the store's own
  // writers are offered. One the store lacks (set some other way) is said there, and when a send is refused for it.
  await page.goto("/settings/integrations");
  const writer = page.getByTestId("memory-writer");
  await expect(writer).toHaveAttribute("data-value", "claude");
  await shoot(page, "memory-panel-15-writer");
  await choose(writer, "codex");
  await expect.poll(async () => (await (await request.get("/api/integrations")).json()).tacit.writer).toBe("codex");
  expect((await ask({ name: "code-word", text: "written as another" })).command).toContain("add --harness codex --kind user");
  expect((await request.patch("/api/settings", { data: { memory: { writer: "Not A Writer" } } })).status()).toBe(400);
  expect((await request.patch("/api/settings", { data: { memory: { writer: "pi" } } })).ok()).toBe(true);
  const lacking = await ask({ name: "code-word", text: "under a writer the store lacks", session_id: session.id });
  expect(await ask({ confirm: lacking.id })).toMatchObject({ state: "failed", no_writer: "pi" });
  expect((await sent())[0].text).toContain("the store has no writer named pi");
  await page.reload();
  await expect(page.getByTestId("memory-writer-lacks")).toContainText("no writer named pi");
  await request.patch("/api/settings", { data: { memory: { writer: "claude" } } });

  // With Settings > Usage already open, the palette's command still brings the Memory view up, on what was given.
  await page.goto("/settings/usage");
  await expect(page.getByTestId("usage-panel")).toBeVisible();
  await expect(page.getByTestId("memory-given")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Memory: what was given");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("memory-given")).toBeVisible();

  // A session whose folder is gone: its turn goes on, what it was given is recorded, and a search still answers.
  const gone = join((await (await request.get("/api/workspaces")).json()).default, `memory-panel-gone-${Date.now()}`);
  mkdirSync(gone, { recursive: true });
  const away = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Memory panel, folder gone", workspace: gone } })).json()).session;
  rmSync(gone, { recursive: true, force: true });
  await request.post(`/api/sessions/${away.id}/messages`, { data: { text: "script:memory What is the code word?" } });
  await ended(request, away.id, 1);
  expect((await givenOf(away.id)).rows.map((g: any) => g.name)).toEqual(["code-word", "keel-bun-e2e"]);
  const found = await (await request.get(`/api/memory/search?q=heron&session_id=${away.id}`)).json();
  expect(found).toMatchObject({ state: "ok" });
  expect(found.hits.map((h: any) => h.name)).toEqual(["code-word"]);
  expect((await (await request.get(`/api/memory/fact?name=code-word&session_id=${away.id}`)).json()).state).toBe("ok");
  expect((await (await request.get("/api/memory/fact?name=no-such-fact")).json()).state).toBe("missing");
  for (const name of ["--help", "Has_Upper.dot"]) expect((await request.get(`/api/memory/fact?name=${name}`)).status()).toBe(400);

  // A deleted session: its rows go with it (a part at a time, off the delete itself), and a link to it says so
  // and shows what is left.
  await request.delete(`/api/sessions/${away.id}`);
  await request.delete(`/api/sessions/${long.id}`);
  expect((await request.get(`/api/memory/given?session_id=${away.id}`)).status()).toBe(404);
  expect((await (await request.get("/api/memory/sessions")).json()).sessions.map((s: any) => s.session_id)).not.toContain(away.id);
  await expect.poll(async () => (await (await request.get("/api/memory/efficiency")).json()).facts.some((f: any) => f.name.startsWith("many-"))).toBe(false);
  await page.goto(`/settings/usage?view=memory&session=${away.id}`);
  await expect(panel.getByTestId("memory-session-gone")).toContainText("was deleted");
  await expect(panel.getByTestId("memory-given-row")).toHaveCount(4);
  await panel.getByTestId("memory-tab-unused").click();
  await expect(panel.getByTestId("memory-session-gone")).toContainText("all sessions");
  await expect(panel.getByTestId("memory-stats")).toBeVisible();
  await shoot(page, "memory-panel-16-session-deleted");

  await request.delete(`/api/sessions/${session.id}`);
});
