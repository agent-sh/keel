import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the Branches panel shows every branch of a session (edits and
// "answer again" split it), marks the one shown and shows another on a click;
// labels name places in the session and take you back to them. Runs on the
// scripted stand-in: the replies do not matter here, only the tree.
const STAND_IN = "scripted:stand-in";

test("branch tree and labels", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const tag = `zt${Date.now().toString(36)}`; // search finds this run's words only
  for (const [i, t] of ["Plan the parser", "Write the tokenizer"].entries()) {
    await composer.fill(t);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(i + 1);
  }
  // Edit the second prompt, then answer the edit again: three ways after the first prompt.
  await page.getByTestId("user-message").last().hover();
  await page.getByTestId("edit-message").last().click();
  await page.getByTestId("edit-box").fill(`Write the tokenizer with a state machine ${tag}`);
  await page.getByTestId("edit-send").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");
  await expect(page.getByTestId("turn-end")).toHaveCount(2);
  await page.getByTestId("retry").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("3/3");

  await composer.fill("/tree");
  await composer.press("Enter");
  const panel = page.getByTestId("branch-tree");
  await expect(panel).toContainText("4 prompts, split in 1 place");
  const nodes = panel.getByTestId("tree-node");
  await expect(nodes).toHaveCount(4);
  await expect(panel.locator("[data-testid=tree-node][data-active]")).toHaveCount(2);

  // Show the first version of the second prompt from the tree.
  await nodes.nth(1).click(); // the first version, listed first under the split
  await expect(page.getByTestId("branch-pos")).toHaveText("1/3");
  await expect(page.getByTestId("user-message").last()).toContainText("Write the tokenizer");
  await expect(nodes.filter({ hasText: "Plan the parser" })).toHaveAttribute("data-active", "true");

  // Label a message from its row, and the newest message with /label.
  await page.getByTestId("assistant-text").first().hover();
  await page.getByRole("button", { name: "Label this message" }).first().click();
  await panel.getByTestId("label-input").fill("parser plan");
  await panel.getByTestId("label-input").press("Enter");
  await composer.fill("/label first tokenizer");
  await composer.press("Enter");
  await expect(panel.getByTestId("label-row")).toHaveCount(2);
  await expect(panel.getByTestId("labels")).toContainText("parser plan");
  await shoot(page, "tree-01-branches-and-labels");

  // A label on another branch brings that branch back.
  await nodes.last().click();
  await expect(page.getByTestId("branch-pos")).toHaveText("3/3");
  await panel.getByTestId("label-row").filter({ hasText: "first tokenizer" }).locator("button").first().click();
  await expect(page.getByTestId("branch-pos")).toHaveText("1/3");

  // A search hit on another branch is read in place: the session's branch
  // stays, a reply asks first, Continue makes it the branch.
  const before = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.head;
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`state machine ${tag}`);
  await page.getByRole("option").filter({ hasText: "state machine" }).first().click();
  await expect(page).toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("branch-preview")).toBeVisible();
  await expect(page.getByTestId("user-message").last()).toContainText("state machine");
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.head).toBe(before);
  await composer.fill("a reply while reading");
  await composer.press("Enter");
  await expect(page.getByText("You are reading another branch. Choose Continue")).toBeVisible();
  await shoot(page, "tree-02-search-preview");
  await page.getByTestId("preview-continue").click();
  await expect(page.getByTestId("branch-preview")).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.head).not.toBe(before);
  await composer.fill("");

  // Remove one.
  await panel.getByTestId("label-row").filter({ hasText: "parser plan" }).hover();
  await panel.getByTestId("label-row").filter({ hasText: "parser plan" }).getByRole("button", { name: "Remove the label" }).click();
  await expect(panel.getByTestId("label-row")).toHaveCount(1);
  const t = await (await request.get(`/api/sessions/${session.id}/tree`)).json();
  expect(t.labels.map((l: any) => l.label)).toEqual(["first tokenizer"]);
  expect((await request.post(`/api/sessions/${session.id}/events/${t.nodes[0].event_id}/label`, { data: { label: "x".repeat(201) } })).status()).toBe(400);
});
