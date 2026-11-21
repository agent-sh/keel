import { expect, test } from "./isolate.ts";
import type { APIRequestContext, Page } from "./isolate.ts";
import { shoot, tabInto } from "./shots.ts";

// Feature: the Branches panel shows every branch of a session (edits and
// "answer again" split it), marks the one shown and shows another on a click;
// labels name places in the session and take you back to them. Runs on the
// scripted stand-in: the replies do not matter here, only the tree.
const STAND_IN = "scripted:stand-in";

// A session whose second prompt has three versions (an edit, then that edit
// answered again), with the Branches panel open on the third.
async function forked(page: Page, request: APIRequestContext, tag: string) {
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
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
  await expect(page.getByTestId("turn-end")).toHaveCount(2);

  await composer.fill("/tree");
  await composer.press("Enter");
  return session as { id: string };
}

test("branch tree and labels", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = `zt${Date.now().toString(36)}`; // search finds this run's words only
  const session = await forked(page, request, tag);
  const composer = page.getByTestId("composer");
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
  await expect(page.getByText("You are reading another branch. Choose Reply from this branch")).toBeVisible();
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

// The rows are one tree for the keyboard: one Tab stop, the arrows reach both
// sides of a split and say which rows are the branch shown and how deep they
// sit; Enter or Space shows a branch; naming a row (F2) is its own action and
// gives the focus back to the row, on whatever branch is shown.
test("branches by keyboard", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = `kb${Date.now().toString(36)}`;
  const session = await forked(page, request, tag);
  const panel = page.getByTestId("branch-tree");
  const rows = panel.getByTestId("tree-node");
  await expect(rows).toHaveCount(4);
  const pos = page.getByTestId("branch-pos");
  const key = (k: string) => page.keyboard.press(k);

  // One Tab stop: the newest prompt of the branch shown. The next Tab is out of the tree.
  const list = panel.getByRole("tree", { name: "Branches" });
  await expect(list.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await tabInto(page, list);
  await expect(rows.nth(3)).toBeFocused();
  await expect(rows.nth(3)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(3)).toHaveAttribute("aria-level", "2");
  await key("Tab");
  await expect(list.locator(":focus")).toHaveCount(0);
  await key("Shift+Tab");
  await expect(rows.nth(3)).toBeFocused();

  // Up through the other sides of the split, Left to the split itself, Right back under it.
  await key("ArrowUp");
  await expect(rows.nth(2)).toBeFocused();
  await expect(rows.nth(2)).not.toHaveAttribute("aria-current", /./);
  // No tip comes up under a row reached with the arrows (it would cover the next row).
  await page.waitForTimeout(400);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await shoot(page, "tree-04-row-by-arrows");
  await expect(rows.nth(2)).toHaveAttribute("aria-level", "2");
  await key("ArrowLeft");
  await expect(rows.nth(0)).toBeFocused();
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-level", "1");
  await key("ArrowRight");
  await expect(rows.nth(1)).toBeFocused();
  await key("End");
  await expect(rows.nth(3)).toBeFocused();
  await key("Home");
  await key("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  // Moving shows nothing; Enter and Space show the row's branch, and the focus stays.
  await expect(pos).toHaveText("3/3");
  await key("Enter");
  await expect(pos).toHaveText("1/3");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(1)).toBeFocused();
  await key("ArrowDown");
  await key("Space");
  await expect(pos).toHaveText("2/3");
  await expect(rows.nth(2)).toBeFocused();
  await shoot(page, "tree-03-row-by-keyboard");

  // Naming a row of another branch: saved with Enter, the focus is back on
  // the row and the branch shown is the same one.
  await key("ArrowUp");
  await key("F2");
  const box = panel.getByTestId("label-input");
  await expect(box).toBeFocused();
  await page.keyboard.type("first try");
  await key("Enter");
  await expect(rows.nth(1).getByTestId("label-chip")).toHaveText("first try");
  await expect(rows.nth(1)).toBeFocused();
  await expect(pos).toHaveText("2/3");
  // Cancelled with Escape: the same, and the label is as it was.
  await key("F2");
  await expect(rows.nth(1).getByTestId("label-input")).toBeFocused();
  await page.keyboard.type(" again");
  await key("Escape");
  await expect(panel.getByTestId("label-input")).toHaveCount(0);
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1).getByTestId("label-chip")).toHaveText("first try");
  await expect(pos).toHaveText("2/3");
  expect((await (await request.get(`/api/sessions/${session.id}/tree`)).json()).labels.map((l: any) => l.label)).toEqual(["first try"]);
  // A save that fails leaves the box open; a click elsewhere then closes it and keeps the focus where the click put it.
  await page.route("**/events/*/label", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }), { times: 1 });
  await key("F2");
  await page.keyboard.type(" kept");
  await key("Enter");
  await expect(rows.nth(1).getByTestId("label-input")).toBeFocused();
  await page.getByTestId("composer").click();
  await expect(panel.getByTestId("label-input")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  // A search hit still takes the keyboard to its message: only the tree's own jumps leave it.
  await rows.nth(1).focus();
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`state machine ${tag}`);
  await page.getByRole("option").filter({ hasText: "state machine" }).first().click();
  await expect(page.locator('[data-testid="user-message"]:focus')).toContainText(`state machine ${tag}`);
  await request.delete(`/api/sessions/${session.id}`);
});
