import { expect, test } from "./isolate.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, endsAre, shoot } from "./shots.ts";
import { branch, notes, read, send, twoTurns } from "./rewind.ts";

// Feature: rewind from a prompt. The chat and the files go back to before it (or only one of them), the
// prompt returns to the message box, and one Undo takes back both. When the head leaves turns that
// changed files and the files stay, the new branch's first request names them once. /rewind, /undo,
// /redo and Escape twice in an empty box open the same dialog.
test.skip(!SCRIPTED, "needs the scripted stand-in: it makes the calls and says what its request carries");

const sizes = [{ width: 1920, height: 1040 }, { width: 390, height: 844 }];

test("chat and files go back together from a prompt, and one Undo brings both back", async ({ page, request }) => {
  const { id, ws } = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(1).click();
  const dialog = page.getByTestId("rewind-dialog");
  await expect(dialog).toBeVisible();
  // The prompts, the newest last, each with the files its turns changed; the chosen one is the one the menu was on.
  await expect(dialog.getByTestId("rewind-prompt")).toHaveCount(2);
  await expect(dialog.getByTestId("rewind-prompt-files")).toHaveText(["1 file", "2 files"]);
  await expect(dialog.getByRole("radio", { name: "Chat and files" })).toBeChecked();
  await expect(dialog.getByTestId("rewind-files")).toContainText("b.txt");
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-prompt-01-dialog-${s.width}`); }
  await page.setViewportSize(sizes[0]!);
  const prompt2 = (await branch(request, id)).filter((e) => e.kind === "user")[1].data.text as string;
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();

  expect(read(ws, "a.txt")).toBe("one\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(false);
  await expect(page.getByTestId("composer")).toHaveValue(prompt2);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  let line = await branch(request, id);
  expect(line.filter((e) => e.kind === "turn_start")).toHaveLength(1);
  // The model reads one note: the files were put back.
  expect(notes(line, "rewind").filter((n) => n.data.model)).toHaveLength(1);
  expect(notes(line, "branch_files")).toHaveLength(0);
  await expect(page.getByTestId("rewound")).toContainText("rewound the chat and the files");
  for (const s of sizes) { await page.setViewportSize(s); await shoot(page, `rewind-prompt-02-rewound-${s.width}`); }
  await page.setViewportSize(sizes[0]!);

  // The next request carries no second turn, and says the files were put back.
  await send(page, "script:find mark2", 3);
  await expect(page.getByTestId("assistant-text").last()).toContainText("Not in the request.");
  line = await branch(request, id);
  expect(line.filter((e) => e.kind === "user" && e.data.text.includes("script:find"))).toHaveLength(1);
  expect(line.filter((e) => e.kind === "turn_start")).toHaveLength(2);
  // (Its note stands before that prompt, on the branch the request is made from.)
  const at = (e: any) => line.findIndex((x) => x.id === e.id);
  expect(at(notes(line, "rewind")[0])).toBeLessThan(at(line.find((e) => e.kind === "user" && e.data.text.includes("script:find"))));
  expect(notes(line, "rewind")[0].data.text).toContain("Restored: a.txt");

  // A new message ends the Undo: it is no longer offered.
  await expect(page.getByTestId("undo-rewind")).toHaveCount(0);
});

test("Undo takes back the chat and the files", async ({ page, request }) => {
  const { id, ws } = await twoTurns(request, page);
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  const dialog = page.getByTestId("rewind-dialog");
  await dialog.getByTestId("rewind-prompt").nth(1).click();
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  expect(read(ws, "a.txt")).toBe("one\n");
  const prompt2 = await page.getByTestId("composer").inputValue();
  expect(prompt2).not.toBe("");
  await page.getByTestId("undo-rewind").click();
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  expect(read(ws, "a.txt")).toBe("two\n");
  expect(read(ws, "b.txt")).toBe("mark2\n");
  const line = await branch(request, id);
  expect(line.filter((e) => e.kind === "user")).toHaveLength(2);
  // The box let go of the prompt the rewind had given it back.
  await expect(page.getByTestId("composer")).toHaveValue("");
  await shoot(page, "rewind-prompt-03-undone");
  // /redo is the same Undo while nothing newer was sent: with the rewind undone there is nothing to redo.
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(1).click();
  await page.getByTestId("rewind-prompt-go").click();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(read(ws, "a.txt")).toBe("one\n");
  await page.getByTestId("composer").fill("/redo");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  expect(read(ws, "a.txt")).toBe("two\n");
});

test("chat only keeps the files and tells the next request; files only keeps the chat", async ({ page, request }) => {
  const { id, ws } = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(1).click();
  const dialog = page.getByTestId("rewind-dialog");
  await dialog.getByRole("radio", { name: "Chat only" }).click();
  await shoot(page, "rewind-prompt-04-chat-only");
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  // The files stay.
  expect(read(ws, "a.txt")).toBe("two\n");
  expect(existsSync(join(ws, "b.txt"))).toBe(true);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(notes(await branch(request, id), "branch_files")).toHaveLength(0);
  // The first request on the branch carries one note naming what the turn left on disk; the next step does not repeat it.
  await send(page, "script:find relying", 3);
  let line = await branch(request, id);
  expect(notes(line, "branch_files")).toHaveLength(1);
  await expect(page.getByTestId("assistant-text").last()).toContainText("a.txt, b.txt");
  await send(page, "script:say again", 4);
  expect(notes(await branch(request, id), "branch_files")).toHaveLength(1);

  // Files only, on the second session: the chat stays and the restore note is sent.
  const two = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Rewind to before this prompt" }).nth(1).click();
  await page.getByRole("dialog").getByRole("radio", { name: "Files only" }).click();
  await page.getByTestId("rewind-prompt-go").click();
  await expect(page.getByTestId("rewind-dialog")).toBeHidden();
  expect(read(two.ws, "a.txt")).toBe("one\n");
  expect(existsSync(join(two.ws, "b.txt"))).toBe(false);
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  line = await branch(request, two.id);
  expect(notes(line, "rewind").filter((n) => n.data.model)).toHaveLength(1);
  expect(line.filter((e) => e.kind === "turn_start")).toHaveLength(2);
});

test("an edit names what the abandoned branch left; it can put the files back too", async ({ page, request }) => {
  // Edit prompt 2 with the files left as they are: the new branch is told, once.
  const kept = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Edit and send as a new version" }).nth(1).click();
  await expect(page.getByTestId("edit-files")).toBeVisible();
  await page.getByTestId("edit-box").fill("script:find relying");
  await page.getByTestId("edit-send").click();
  await endsAre(page, 3, 60_000, true);
  await expect(page.getByTestId("assistant-text").last()).toContainText("b.txt");
  expect(notes(await branch(request, kept.id), "branch_files")).toHaveLength(1);
  expect(read(kept.ws, "a.txt")).toBe("two\n");

  // Edit it with the box ticked: the files go back to before the prompt, and the branch is told of no file it left.
  const back = await twoTurns(request, page);
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Edit and send as a new version" }).nth(1).click();
  await page.getByTestId("edit-files").check();
  await page.getByTestId("edit-box").fill("script:find mark2");
  await shoot(page, "rewind-prompt-05-edit");
  await page.getByTestId("edit-send").click();
  await endsAre(page, 3, 60_000, true);
  expect(read(back.ws, "a.txt")).toBe("one\n");
  expect(existsSync(join(back.ws, "b.txt"))).toBe(false);
  await expect(page.getByTestId("assistant-text").last()).toContainText("Not in the request.");
  const restored = await branch(request, back.id);
  expect(notes(restored, "rewind").filter((n) => n.data.model)).toHaveLength(1);
  expect(notes(restored, "branch_files")).toHaveLength(0);

  // Turns that changed no file leave nothing to tell.
  const plain = await twoTurns(request, page, { files: false });
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Edit and send as a new version" }).nth(1).click();
  await expect(page.getByTestId("edit-files")).toHaveCount(0);
  await page.getByTestId("edit-box").fill("script:say third");
  await page.getByTestId("edit-send").click();
  await endsAre(page, 3, 60_000, true);
  expect(notes(await branch(request, plain.id), "branch_files")).toHaveLength(0);
});

test("/rewind, /undo and Escape twice open the dialog; a box with words is left alone", async ({ page, request }) => {
  const { id } = await twoTurns(request, page);
  const box = page.getByTestId("composer");
  const dialog = page.getByTestId("rewind-dialog");
  await box.fill("/undo");
  await box.press("Enter");
  await expect(dialog.getByTestId("rewind-prompt")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Escape twice in an empty box.
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await box.press("Escape");
  await expect(dialog).toBeHidden();
  await box.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // With words in the box nothing is cleared and nothing opens.
  await box.fill("keep these words");
  await box.press("Escape");
  await box.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(box).toHaveValue("keep these words");
  await box.fill("");

  // A session whose turns changed no file: the rewind offers the chat only.
  const plain = await twoTurns(request, page, { files: false });
  await page.getByTestId("composer").fill("/rewind");
  await page.getByTestId("composer").press("Enter");
  await expect(dialog.getByTestId("rewind-prompt-files")).toHaveText(["no files", "no files"]);
  await expect(dialog.getByRole("radio")).toHaveCount(2 + 1);
  await expect(dialog.getByRole("radio", { name: "Chat only" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Chat and files" })).toHaveCount(0);
  await shoot(page, "rewind-prompt-06-no-files");
  await dialog.getByTestId("rewind-prompt-go").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  expect(id).not.toBe(plain.id);
});
