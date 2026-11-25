import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: another session named in a prompt. The @ menu lists sessions by title beside files;
// picking one puts a short pointer (title, id, state, the first line of its last reply) into
// the prompt, never its history.
test("an @ mention of another session puts a short pointer to it into the prompt", async ({ page, request }) => {
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: { id: string }) => m.id === "scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json()).session.id as string;
  const other = await mk("Orchard budget notes");
  const here = await mk("The mention is written here");
  expect((await request.post(`/api/sessions/${other}/messages`, { data: { text: "script:say The budget is approved.\\nA second line that stays out of the pointer." } })).ok()).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${other}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 20_000 }).toBe(true);

  await page.goto(`/s/${here}`);
  const box = page.getByTestId("composer");
  await box.fill("Compare with @Orchard");
  const menu = page.getByTestId("mention-menu");
  await expect(menu.getByTestId("mention-session")).toHaveText("Orchard budget notes");
  await shoot(page, "session-mention-01-menu");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue(new RegExp(`^Compare with \\[Another session, "Orchard budget notes" \\(id ${other}.*Its last reply began: "The budget is approved\\."`));
  expect(await box.inputValue()).not.toContain("second line");
  await shoot(page, "session-mention-02-pointer");

  // The pointer is what the model gets: the prompt as stored holds it and none of the other session's history.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${here}`)).json()).events.some((e: any) => e.kind === "user")).toBe(true);
  const sent = (await (await request.get(`/api/sessions/${here}`)).json()).events.find((e: any) => e.kind === "user");
  expect(JSON.stringify(sent.data)).toContain(other);
  expect(JSON.stringify(sent.data)).not.toContain("second line");
  // The route says the same, with its parts.
  const p = await (await request.get(`/api/sessions/${other}/pointer`)).json();
  expect(p).toMatchObject({ id: other, title: "Orchard budget notes", last_reply: "The budget is approved." });
});
