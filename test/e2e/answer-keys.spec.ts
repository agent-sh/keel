import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: answering what waits on the owner by keyboard. Each test names the rule it holds.
const MODEL = "scripted:stand-in";
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
}
const folder = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
const create = async (request: APIRequestContext, title: string, workspace: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session.id as string;
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
// Stops every turn an earlier test left open: what waits on the owner is read across the daemon's sessions.
async function settle(request: APIRequestContext) {
  const { sessions } = (await (await request.get("/api/sessions")).json()) as { sessions: { id: string; phase: string }[] };
  for (const s of sessions) if (s.phase === "working") await request.post(`/api/sessions/${s.id}/interrupt`);
}
// A session that waits on an approval of one command.
async function asksToRun(request: APIRequestContext, title: string, ws: string, word: string) {
  const id = await create(request, title, ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word} > ${word}.txt` } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length).toBe(1);
  return id;
}
const approvals = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { state: string; choice?: string }[];
const keysOn = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? "");

test("Esc twice on an approval gives the keyboard back to Allow once", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Esc and back", folder("esc"), "escback");
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  await expect(allow).toBeFocused();
  // Esc opens the reason, Esc again leaves it: the keyboard is on Allow once, not on the page.
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(allow).toBeFocused();
  expect(await keysOn(page)).toBe("allow-once");
  await shoot(page, "answer-keys-01-esc-back");
  // The Back button does the same.
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "Back" }).click();
  await expect(allow).toBeFocused();
  // And Enter still allows, once the button has stood for its second.
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.delete(`/api/sessions/${id}`);

  // A card whose command is not all on it takes no answer: leaving the reason puts the keyboard
  // on the list of requests, where the card's own rule keeps it, and Enter there answers nothing.
  const long = await create(request, "Esc and back, cut", folder("esc-cut"));
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const lines = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho last > last.txt`;
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: lines } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/approvals`)).json()).approvals.length).toBe(1);
  await page.goto(`/s/${long}`);
  await expect(card).toHaveAttribute("data-must-open", "true");
  const list = page.getByTestId("approvals");
  await expect(list).toBeFocused();
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect((await approvals(request, long))[0]).toMatchObject({ state: "pending" });
  await request.post(`/api/sessions/${long}/interrupt`);
  await request.delete(`/api/sessions/${long}`);
});

const colors = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal", description: "Calm and cool" }, { label: "Amber", description: "Warm" }, { label: "Slate" }], multiSelect: false }] } };
const twoParts = { name: "AskUserQuestion", input: { questions: [
  { header: "Checks", question: "Which checks should run?", options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }], multiSelect: true },
  { header: "Branch", question: "Which branch is the base?", options: [{ label: "main" }, { label: "release" }], multiSelect: false },
] } };
const pending = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending as string[];
// What the owner answered, as the daemon stored it with the question's result.
const answersOf = async (request: APIRequestContext, id: string) => {
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  const shown = events.findLast((e: any) => e.kind === "tool_result" && e.data.shown)?.data.shown as Record<string, { answers: Record<string, { picked: string[]; other?: string }> }> | undefined;
  return shown ? Object.values(shown)[0]!.answers : undefined;
};

test("a question docks above the message box, takes the keyboard and is answered with a number", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("question");
  const id = await create(request, "Pick a color", ws);
  // A long conversation first: the question must not scroll away with it.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:fill" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([colors]) } });
  await expect.poll(() => pending(request, id)).toHaveLength(1);

  await page.goto(`/s/${id}`);
  const card = page.getByTestId("question");
  await expect(card).toHaveAttribute("data-state", "open");
  // Docked: in the region above the message box, where approvals wait, and one line in the conversation.
  await expect(page.getByTestId("composer-asks").getByTestId("question")).toHaveCount(1);
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveCount(0);
  await expect(page.getByTestId("transcript").getByTestId("question-asked")).toContainText("Which color should I use?");
  // It takes the keyboard when it opens, and says what the keys do.
  await expect(card).toBeFocused();
  await expect(card.getByTestId("question-hint")).toBeVisible();
  await expect(card.getByTestId("question-hint")).toHaveText("Press 1 to 3 to answer, or type your own");
  await shoot(page, "answer-keys-02-question-docked");
  // At any scroll position of the conversation the card stays whole in view.
  const whole = () => card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
  for (const top of [0, 3000, 1e9]) {
    await page.evaluate((y) => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = y; }, top);
    await page.waitForTimeout(150);
    expect(await whole()).toBe(true);
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = 0; });
  await shoot(page, "answer-keys-03-question-scrolled-up");

  // 1 then Enter answers it (the number alone already does: one question, one choice).
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("data-state", "answered");
  expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Teal"] } });
  await expect(page.getByTestId("composer-asks").getByTestId("question")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  await expect(page.getByTestId("composer")).toHaveValue("");
  await expect.poll(() => pending(request, id)).toHaveLength(0);
  await request.post(`/api/sessions/${id}/interrupt`);
  await request.delete(`/api/sessions/${id}`);
});

test("a question with several parts: numbers choose, words are an own answer, Enter sends", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("question-parts");
  const id = await create(request, "Checks and base", ws);
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([twoParts, colors]) } });
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("composer-asks").getByTestId("question");
  await expect(card).toBeFocused();
  await expect(card.getByTestId("question-hint")).toHaveText("Press 1 to 3 to choose, Enter to send");

  // Enter with nothing chosen says why it does nothing.
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-nudge")).toHaveText("Choose an answer for each question first");
  // Numbers go to the first part that has no answer: two checks, then that part is answered and the next takes them.
  await page.keyboard.press("1");
  await expect(card.getByRole("checkbox", { name: "Lint" })).toHaveAttribute("aria-checked", "true");
  // Down and Up move through the options; Space toggles the one the keyboard is on.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("checkbox", { name: "Types" })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(card.getByRole("checkbox", { name: "Types" })).toHaveAttribute("aria-checked", "true");
  await card.focus();
  await page.keyboard.press("2");
  await expect(card.getByRole("radio", { name: "release" })).toHaveAttribute("aria-checked", "true");
  await shoot(page, "answer-keys-04-question-parts");
  await page.keyboard.press("Enter");
  await expect.poll(async () => await answersOf(request, id)).toEqual({ "0": { picked: ["Lint", "Types"] }, "1": { picked: ["release"] } });

  // The next question: words typed on the card are the owner's own answer, and Enter sends them.
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.type("a dark teal");
  await expect(card.getByTestId("question-other")).toBeFocused();
  await expect(card.getByTestId("question-other")).toHaveValue("a dark teal");
  await expect(page.getByTestId("composer")).toHaveValue("");
  await page.keyboard.press("Enter");
  await expect.poll(() => pending(request, id)).toHaveLength(0);
  expect(await answersOf(request, id)).toEqual({ "0": { picked: [], other: "a dark teal" } });
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.post(`/api/sessions/${id}/interrupt`);
  await request.delete(`/api/sessions/${id}`);
});

test("a plan takes the keyboard when it opens and Enter approves it", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Plan the retry policy", folder("plan"));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "plan" } });
  const plan = "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.\n3. Run the tests.";
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "present_plan", input: { plan } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("plan-card");
  await expect(card.getByTestId("plan-approve")).toBeFocused();
  await expect(card.getByTestId("plan-hint")).toBeVisible();
  await shoot(page, "answer-keys-05-plan-keys");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length).toBe(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/permissions`)).json()).perm.mode).toBe("auto-edits");
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.post(`/api/sessions/${id}/interrupt`);
  await request.delete(`/api/sessions/${id}`);
});

test("what waits across sessions is answered in sequence, one key each", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence");
  const quiet = await create(request, "Nothing waits here", ws);
  // Three approvals and a question, each in a session of its own, in the order they began to wait.
  const a = await asksToRun(request, "Build the docs", ws, "docs");
  const b = await asksToRun(request, "Clean the cache", ws, "cache");
  const c = await asksToRun(request, "Tag the release", ws, "tag");
  const q = await create(request, "Pick a color", ws);
  await request.post(`/api/sessions/${q}/messages`, { data: { text: calls([colors]) } });
  await expect.poll(() => pending(request, q)).toHaveLength(1);

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  for (const id of [a, b, c, q]) await expect(row(id)).toHaveAttribute("data-watch", "need");
  // Only the keyboard is used from here: every press is counted, and the pointer never moves.
  let presses = 0;
  const press = async (key: string) => { presses++; await page.keyboard.press(key); };
  const at = (id: string) => expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  const card = page.getByTestId("approval");
  const ready = async (id: string) => {
    await at(id);
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card).toHaveAttribute("data-live", "true");
  };

  // One key starts the sequence on the one that has waited longest.
  await press("Alt+a");
  await ready(a);
  // Each Enter answers, and the next one opens by itself with the keyboard on it.
  await press("Enter");
  await ready(b);
  // The card says that it is a sequence and how many more wait.
  await expect(page.getByTestId("waiting-elsewhere")).toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("2 more sessions wait for you");
  await shoot(page, "answer-keys-06-sequence");
  await press("Enter");
  await ready(c);
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("1 more session waits for you");
  await press("Enter");
  await at(q);
  const question = page.getByTestId("composer-asks").getByTestId("question");
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute("data-live", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toHaveCount(0);
  await shoot(page, "answer-keys-07-sequence-question");
  await press("2");

  // Everything is answered, in five presses, and the page says that nothing else waits.
  await expect(page.locator(".k-tip")).toHaveText("Nothing else waits for you.");
  expect(presses).toBe(5);
  for (const id of [a, b, c]) await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Amber"] } });
  for (const id of [a, b, c, q]) await expect(row(id)).not.toHaveAttribute("data-watch", "need");
  await at(q);
  await expect(page.getByTestId("composer")).toBeFocused();
  await shoot(page, "answer-keys-08-sequence-done");

  for (const id of [quiet, a, b, c, q]) { await request.post(`/api/sessions/${id}/interrupt`); await request.delete(`/api/sessions/${id}`); }
});

test("the sequence stays with the owner: several requests in one session, and it ends when they do something else", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence-ends");
  const quiet = await create(request, "Nothing waits here", ws);
  // One session with two requests of different tools (each is answered on its own), and one more session.
  const two = await create(request, "Two requests", ws);
  await request.put(`/api/sessions/${two}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${two}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "Bash", input: { command: "echo one > one.txt" } }, { name: "Write", input: { file_path: `${ws}/two.txt`, content: "two" } }])}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${two}/approvals`)).json()).approvals.length).toBe(2);
  const other = await asksToRun(request, "One more", ws, "more");

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  const cards = page.getByTestId("approval");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByTestId("allow-once")).toBeFocused();
  await expect(cards.first()).toHaveAttribute("data-live", "true");
  // The first is answered: the keyboard goes to the one left in this session, not to another session.
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  // The owner types into the message box instead: the sequence is over, and an answer moves nothing.
  await page.getByTestId("composer").focus();
  await page.keyboard.type("x");
  await expect(page.getByTestId("waiting-elsewhere")).not.toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toHaveText("1 more session waits for you.AltAgoes to the next.");
  await shoot(page, "answer-keys-09-waits-elsewhere");
  await page.getByTestId("composer").fill("");
  await expect(cards).toHaveAttribute("data-live", "true");
  await cards.getByTestId("allow-once").focus();
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  // The key again takes up what is left.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${other}$`));

  for (const id of [quiet, two, other]) { await request.post(`/api/sessions/${id}/interrupt`); await request.delete(`/api/sessions/${id}`); }
});
