import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the first run. With no provider listing a model, the start page
// says so and leads to Providers; with models but no session yet, starters
// fill the message box. The daemon is real; only its two listings are
// answered empty here to stand for a machine Keel has never run on.
test("first run", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const empty = async (route: any, body: unknown) => route.fulfill({ json: body });
  await page.route("**/api/sessions", (r) => (r.request().method() === "GET" ? empty(r, { sessions: [] }) : r.continue()));
  await page.route(/\/api\/models(\?.*)?$/, (r) => empty(r, { models: [], default: "", pinned: [], providers: [] }));

  await page.goto("/");
  await expect(page.getByTestId("setup-providers")).toBeVisible();
  await expect(page.getByTestId("first-steps")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toContainText("No models");
  await shoot(page, "onboard-01-no-provider");
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, "onboard-02-no-provider-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  await page.getByTestId("setup-read-again").click();
  await expect(page.getByTestId("setup-read-again")).toHaveText("I added a key, read again", { timeout: 60_000 });
  await page.getByTestId("setup-open-providers").click();
  await expect(page).toHaveURL(/\/settings\/providers$/);

  // Models are listed now: the setup card goes, the starters stay until a session exists.
  await page.unroute(/\/api\/models(\?.*)?$/);
  await page.goto("/");
  await expect(page.getByTestId("first-steps")).toBeVisible();
  await expect(page.getByTestId("setup-providers")).toHaveCount(0);
  await page.getByTestId("starter").first().click();
  await expect(page.getByTestId("composer")).toHaveValue(/Explain how this project is laid out/);
  await shoot(page, "onboard-03-starters");

  // With real sessions, none of it shows.
  await page.unroute("**/api/sessions");
  await page.reload();
  await expect(page.getByTestId("new-composer")).toBeVisible();
  await expect(page.getByTestId("first-steps")).toHaveCount(0);

  // A link to a session this daemon does not have (deleted, or from another machine) says so.
  await page.goto("/s/0000aaaa-gone-link");
  await expect(page.getByTestId("session-missing")).toBeVisible();
  await page.getByRole("button", { name: "Start a new session" }).click();
  await expect(page.getByTestId("new-composer")).toBeVisible();

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
