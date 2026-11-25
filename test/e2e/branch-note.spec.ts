import { expect, test } from "./isolate.ts";
import { SCRIPTED, endsAre } from "./shots.ts";
import { branch, notes, read, twoTurns } from "./rewind.ts";

// Feature: the files a branch left. When the head moves off turns that changed files and the files stay, the
// first request of the new branch carries one note naming them; none when no file changed; never twice.
test.skip(!SCRIPTED, "needs the scripted stand-in: it makes the calls and says what its request carries");

test("a new version of a prompt is told what the old one left on disk, once", async ({ page, request }) => {
  const { id, ws } = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Edit and send as a new version" }).nth(1).click();
  await page.getByTestId("edit-box").fill("script:find relying");
  await page.getByTestId("edit-send").click();
  await endsAre(page, 3, 60_000, true);
  // The note lists the files of the turn that is no longer on this branch, and the files stay.
  await expect(page.getByTestId("assistant-text").last()).toContainText("a.txt, b.txt");
  expect(read(ws, "a.txt")).toBe("two\n");
  expect(notes(await branch(request, id), "branch_files")).toHaveLength(1);
  // The next turn does not tell it again.
  await page.getByTestId("composer").fill("script:say again");
  await page.getByTestId("composer").press("Enter");
  await endsAre(page, 4, 60_000, true);
  expect(notes(await branch(request, id), "branch_files")).toHaveLength(1);
});

test("turns that changed no file leave nothing to tell", async ({ page, request }) => {
  const { id } = await twoTurns(request, page, { files: false });
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Edit and send as a new version" }).nth(1).click();
  await page.getByTestId("edit-box").fill("script:say third");
  await page.getByTestId("edit-send").click();
  await endsAre(page, 3, 60_000, true);
  expect(notes(await branch(request, id), "branch_files")).toHaveLength(0);
});
