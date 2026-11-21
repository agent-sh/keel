import { expect, test } from "./isolate.ts";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: the working model consults an advisor the owner chose: another
// model reads the conversation and its guidance comes back as the tool result,
// naming the advisor and its cost. /advisor off turns it off for one session.
test("consult: the advisor tool on another model, set in Settings and per session", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: the advisor is a second model of the same provider, asked for an opinion");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { models } = await (await request.get("/api/models")).json();
  const advisor = models.find((m: any) => /sonnet/i.test(m.id) && m.provider === HAIKU.split(":")[0]);
  await request.put("/api/advisor", { data: { model: advisor.id } });

  await page.goto("/settings/agents");
  await expect(page.getByTestId("advisor-current")).toContainText(advisor.name);
  await shoot(page, "consult-01-settings");

  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("Call the advisor tool once with the question: is 91 a prime number? Then reply with one sentence giving its answer.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  const call = page.locator('[data-testid="tool-call"][data-tool="advisor"]');
  await expect(call).toHaveCount(1);
  await expect(call).toContainText(/asks: is 91 a prime number/i);
  await call.getByText(/asks: is 91/i).click();
  await expect(call).toContainText(`Advisor ${advisor.name}`);
  await shoot(page, "consult-02-guidance");
  const act = (await (await request.get(`/api/activity?kind=agent&session_id=${session.id}`)).json()).items;
  expect(act.some((a: any) => a.sub === "consult")).toBe(true);

  // Off for this session only.
  await page.getByTestId("composer").fill("/advisor off");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/advisor`)).json()).model).toBeNull();
  expect((await (await request.get("/api/advisor")).json()).model).toBe(advisor.id);

  await request.put("/api/advisor", { data: { model: null } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
