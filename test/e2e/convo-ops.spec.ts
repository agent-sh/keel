import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: conversation operations. A recap written on demand; summarize from
// a prompt on (the prompt comes back to the message box) and everything up to
// a prompt (it and what follows stay verbatim); a skill kept on as the
// session's mode; and the model's own context tools: it reads how full its
// context is and starts a fresh one with a handoff note.
test("recap, summarize a part, skill mode, the model's context tools", async ({ page, request }) => {
  const word = `cv${Date.now().toString(36)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  // A folder with a project skill the mode can keep on.
  const ws = join((await (await request.get("/api/workspaces")).json()).default, word);
  mkdirSync(join(ws, ".claude/skills/sign-off"), { recursive: true });
  writeFileSync(join(ws, ".claude/skills/sign-off/SKILL.md"), `---\nname: sign-off\ndescription: End every reply with a sign-off word.\n---\nEnd every reply with the word ${word.toUpperCase()} on its own line.\n`);
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Convo ${word}`, workspace: ws } })).json();
  const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  const send = async (text: string, turns: number) => {
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(turns, { timeout: 90_000 });
  };
  await send("Reply with only the word apple.", 1);
  await send("Reply with only the word banana.", 2);

  // Recap: written on demand, shown in the Session panel with a next prompt.
  await openPanel(page, "session");
  await page.getByTestId("recap-write").click();
  await expect(page.getByTestId("recap-text")).not.toBeEmpty({ timeout: 60_000 });
  await shoot(page, "convo-01-recap");

  // Summarize from the second prompt: it comes back to the box, the reply goes.
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Summarize from here" }).nth(1).click();
  await expect(page.getByTestId("summarize-dialog")).toBeVisible();
  await shoot(page, "convo-02-summarize-dialog");
  await page.getByTestId("summarize-go").click();
  await expect(page.getByTestId("summarize-dialog")).toBeHidden({ timeout: 60_000 });
  await expect(composer).toHaveValue("Reply with only the word banana.");
  await expect(page.getByTestId("compacted")).toContainText("Summarized from a prompt on");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  const s1 = (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  expect((await events()).find((e) => e.id === s1.head)).toMatchObject({ kind: "note", data: { kind: "summary", model: true } });

  // Send it again, then summarize everything up to it: it stays verbatim.
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await page.getByTestId("user-message").nth(1).hover();
  await page.getByRole("button", { name: "Summarize up to here" }).last().click();
  await page.getByTestId("summarize-focus").fill("the word apple");
  await page.getByTestId("summarize-go").click();
  await expect(page.getByTestId("summarize-dialog")).toBeHidden({ timeout: 60_000 });
  await expect(page.getByTestId("compacted").last()).toContainText("Summarized everything before a prompt");
  const cp = (await events()).findLast((e) => e.kind === "compaction");
  expect(cp.data).toMatchObject({ range: "up_to", focus: "the word apple", mode: "summary" });
  await shoot(page, "convo-03-summarized");

  // Skill mode: the skill's instructions hold on the next turn.
  await page.getByTestId("skill-mode-select").selectOption("sign-off");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.skill_mode).toBe("sign-off");
  await send("Reply with only the word cherry.", 3);
  await expect(page.getByTestId("assistant-text").last()).toContainText(word.toUpperCase());
  expect((await events()).some((e) => e.kind === "note" && e.data.kind === "skill_mode" && e.data.skill_mode === "sign-off")).toBe(true);
  await expect(page.getByTestId("note").filter({ hasText: "Skill mode: sign-off" })).toBeVisible();
  await page.getByTestId("skill-mode-select").selectOption("");
  await shoot(page, "convo-04-skill-mode");

  // The model's context tools: it reads its window, then starts fresh with a handoff.
  await send("Call the keel__context_status tool, then reply with only the context_window number it gave.", 4);
  const status = (await events()).flatMap((e) => (e.kind === "tool_result" ? e.data.results : [])).find((r: any) => /context_window/.test(String(r.content)));
  expect(JSON.parse(status.content).context_used_tokens).toBeGreaterThan(0);
  await send(`Call the keel__new_context tool with the handoff "Goal: reply with the word ${word}.", then do what the handoff says.`, 5);
  const fresh = (await events()).findLast((e) => e.kind === "compaction");
  expect(fresh.data).toMatchObject({ trigger: "model", summary: `Goal: reply with the word ${word}.` });
  await expect(page.getByTestId("compacted").last()).toContainText("handoff note");
  await expect(page.getByTestId("assistant-text").last()).toContainText(word);
  await shoot(page, "convo-05-new-context");

  await request.delete(`/api/sessions/${session.id}`);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});
