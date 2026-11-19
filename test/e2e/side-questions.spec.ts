import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: /btw asks a side question answered from the session's context with
// no tools; it opens the side panel, a follow-up continues the thread, and
// nothing is added to the conversation. Clear forgets the threads.
test("side questions stay out of the conversation", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await composer.fill("The project codename is Heron-42. Reply with only the word noted.");
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  const before = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.length;

  await composer.fill("/btw what is the project codename? Answer with the codename only.");
  await composer.press("Enter");
  const panel = page.getByTestId("side-questions");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("side-answer").last()).toContainText("Heron-42", { timeout: 60_000 });

  // A follow-up sees the thread so far.
  await panel.getByTestId("side-input").fill("Repeat your previous answer in lower case, nothing else.");
  await panel.getByTestId("side-input").press("Enter");
  await expect(panel.getByTestId("side-exchange")).toHaveCount(2, { timeout: 60_000 });
  await expect(panel.getByTestId("side-answer").last()).toContainText("heron-42", { timeout: 60_000 });
  await shoot(page, "side-01-thread");

  // The conversation is as it was: no prompt, reply or turn was added.
  const after = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(after.events.length).toBe(before);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  // Yet both side answers are requests the usage report counts, as the spend guard does.
  const usage = await (await request.get(`/api/usage?group=model&session_id=${session.id}`)).json();
  expect(usage.by_purpose.find((p: any) => p.purpose === "side").calls).toBe(2);
  expect(usage.total.calls).toBeGreaterThanOrEqual(3);

  // The threads come back after a reload, and Clear forgets them.
  await page.reload();
  await expect(page.getByTestId("side-exchange")).toHaveCount(2);
  await page.getByTestId("side-clear").click();
  await expect(page.getByTestId("side-exchange")).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${session.id}/side`)).json()).threads).toEqual([]);
});

// Follow-ups wait for the answer before them, a failed question keeps its
// words to retry, New thread holds against an answer still on its way, and a
// thread does not follow the conversation onto another branch.
test("side questions in order, retried, and per branch", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", text: "first" } })).json();
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.phase, { timeout: 20_000 }).toBe("idle");
  await idle();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("/btw warm up");
  await page.getByTestId("composer").press("Enter");
  const panel = page.getByTestId("side-questions");
  await expect(panel.getByTestId("side-exchange")).toHaveCount(1, { timeout: 20_000 });
  const input = panel.getByTestId("side-input");
  const side = new RegExp(`/api/sessions/${session.id}/side$`);

  // A failed question stays, with Retry; Retry answers it.
  await page.route(side, (r) => (r.request().method() === "POST" ? r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "the provider is down" }) }) : r.fallback()));
  await input.fill("Which check failed?");
  await input.press("Enter");
  await expect(panel.getByTestId("side-failed")).toContainText("Which check failed?");
  await expect(panel.getByTestId("side-failed")).toContainText("the provider is down");
  await shoot(page, "side-02-failed");
  await page.unroute(side);
  await panel.getByTestId("side-retry").click();
  await expect(panel.getByTestId("side-exchange")).toHaveCount(2, { timeout: 20_000 });
  await expect(panel.getByTestId("side-failed")).toHaveCount(0);

  // Two asked at once go in order, the second after the first's answer.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let posts = 0;
  await page.route(side, async (r) => { if (r.request().method() === "POST" && posts++ === 0) await held; await r.fallback(); });
  await input.fill("A?");
  await input.press("Enter");
  await input.fill("B?");
  await input.press("Enter");
  await expect(panel.getByTestId("side-pending")).toHaveCount(2);
  expect(posts).toBe(1);
  // New thread while A is out: A's answer lands in its thread, the next one starts fresh.
  await panel.getByRole("button", { name: "New thread" }).click();
  release();
  await expect(panel.getByTestId("side-pending")).toHaveCount(0, { timeout: 20_000 });
  await page.unroute(side);
  const threads = (await (await request.get(`/api/sessions/${session.id}/side`)).json()).threads;
  expect(threads.flatMap((t: any) => t.exchanges.map((x: any) => x.question))).toEqual(["warm up", "Which check failed?", "A?", "B?"]);
  expect(threads.length).toBe(2); // B went after New thread
  expect(threads[1].exchanges.map((x: any) => x.question)).toEqual(["B?"]);

  // On a sibling branch the old thread's follow-up starts a new thread.
  const first = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.find((e: any) => e.kind === "user");
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "second version", edit_of: first.id } });
  await idle();
  const r = await (await request.post(`/api/sessions/${session.id}/side`, { data: { question: "still there?", thread_id: threads[0].id } })).json();
  expect(r.branched).toBe(true);
  expect(r.thread_id).not.toBe(threads[0].id);
  await request.delete(`/api/sessions/${session.id}`);
});
