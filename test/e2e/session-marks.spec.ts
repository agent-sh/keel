import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot, SCRIPTED } from "./shots.ts";

// Feature: session marks. Pin (the station and the list), tags (the list and
// its filter), done (the owner's next message reopens it), the step budget
// (the last step answers in words), messages from other sessions and the
// turns they may start, and an archive that asks before it stops a running
// background command. Marks are daemon state: the API reads what the UI set.
test("pin, tags, done, step budget, peer marks, archive with a job", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to pick a tool for a plain prompt and start a background job");
  const word = `mk${Date.now().toString(36)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Marks ${word}` } })).json();
  const api = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "session");
  const panel = page.getByTestId("session-panel");
  await expect(panel).toBeVisible();

  // Pin: the station's pin follows, and the list leads with it.
  await page.getByTestId("pin-toggle").click();
  await expect(page.getByTestId("pin-toggle")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("station-pin")).toHaveAttribute("aria-pressed", "true");
  expect((await api()).settings.pinned_ms).toBeGreaterThan(0);

  // Tags: added in the panel, shown on the row, filter the list.
  await page.getByTestId("tag-input").fill(`${word}, review`);
  await page.getByTestId("tag-input").press("Enter");
  await expect(page.getByTestId("session-tag")).toHaveCount(2);
  expect((await api()).settings.tags).toEqual([word, "review"]);
  expect((await (await request.get(`/api/sessions?tag=${word}`)).json()).sessions.map((s: any) => s.id)).toEqual([session.id]);
  const pinned = page.getByTestId("pinned-group");
  await expect(pinned.locator(`[data-session="${session.id}"]`)).toBeVisible();
  await expect(pinned.locator(`[data-session="${session.id}"]`).getByTestId("row-tag").first()).toHaveText(word);
  await page.getByTestId("tag-filter").getByRole("button", { name: word }).click();
  await expect(page.getByTestId("session-list").getByTestId("session-row")).toHaveCount(1);
  await shoot(page, "marks-01-pinned-tagged");
  await page.getByTestId("tag-filter").getByRole("button", { name: word }).click();

  // Peer marks: refuse messages, and a turn budget for other sessions.
  await page.getByTestId("peer-turns").fill("7");
  await page.getByTestId("peer-turns").press("Enter");
  await page.getByTestId("accept-messages").click();
  await expect(page.getByTestId("accept-messages")).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/marks`)).json())).toMatchObject({ pinned: true, accept_messages: false, peer_turns: 7 });
  expect((await request.post(`/api/sessions/${session.id}/marks`, { data: { peer_turns: 0 } })).status()).toBe(400);

  // Step budget 1 and done: the one step answers in words; the message reopens the session.
  await page.getByTestId("max-steps").fill("1");
  await page.getByTestId("max-steps").press("Enter");
  await expect.poll(async () => (await api()).settings.max_steps).toBe(1);
  await page.getByTestId("done-toggle").click();
  await expect(page.getByTestId("done-toggle")).toHaveAttribute("aria-checked", "true");
  await shoot(page, "marks-02-panel");
  await page.getByTestId("composer").fill("List the files of this folder with a tool, then say what you found.");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("done-toggle")).toHaveAttribute("aria-checked", "false");
  const events = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  expect(events.filter((e: any) => e.kind === "assistant")).toHaveLength(1);
  expect(events.some((e: any) => e.kind === "user" && e.data.origin === "harness" && /last model step/.test(e.data.text))).toBe(true);
  // Every call of that one step went unrun.
  for (const r of events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results)) expect(r.content).toMatch(/step budget/);

  // Archive while a background command runs: asked first, then both stop.
  await page.getByTestId("max-steps").fill("");
  await page.getByTestId("max-steps").press("Enter");
  await expect.poll(async () => (await api()).settings.max_steps).toBeUndefined();
  await page.getByTestId("composer").fill("Start the command `sleep 600` as a background command (do not wait for it), then reply with the word started.");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs.filter((j: any) => j.running).length, { timeout: 20_000 }).toBe(1);
  expect((await request.patch(`/api/sessions/${session.id}`, { data: { archived: true } })).status()).toBe(409);
  await page.getByTestId("panel-archive").click();
  await expect(page.getByTestId("confirm")).toContainText("sleep 600");
  await shoot(page, "marks-03-archive-asks");
  await page.getByTestId("confirm").getByRole("button", { name: "Stop and archive" }).click();
  await expect.poll(async () => (await api()).archived).toBe(true);
  expect((await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs.filter((j: any) => j.running)).toHaveLength(0);

  await request.delete(`/api/sessions/${session.id}`);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});
