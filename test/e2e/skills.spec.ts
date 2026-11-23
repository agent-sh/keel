import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: SKILL.md skills. A project skill is listed for the folder, the
// owner runs it from the message box with an argument, and the model loads
// another one itself with the Skill tool; both follow the skill's body.
test("skills: listed, run by the owner, loaded by the model", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to follow a skill's instructions and load one by itself");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-tools`, `skills-${Date.now()}`);
  const skill = (name: string, body: string, extra = "") => {
    mkdirSync(join(ws, ".claude/skills", name), { recursive: true });
    writeFileSync(join(ws, ".claude/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${extra || `Test skill ${name}`}\n---\n${body}\n`);
  };
  skill("stamp-word", "Reply with exactly one line: STAMP-$0-STAMP. Nothing else.", "Stamp a word. Run with the word as the argument.");
  skill("bird-fact", "Reply with exactly one line: BIRDFACT-$ARGUMENTS. Nothing else.", "Use when asked for a bird fact; pass the bird's name.");

  const listed = (await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json()).skills.map((s: any) => s.name);
  expect(listed).toEqual(expect.arrayContaining(["stamp-word", "bird-fact"]));

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer");
  await box.fill("/stamp");
  await expect(page.getByTestId("slash-menu")).toContainText("stamp-word");
  await shoot(page, "skills-01-slash-menu");
  await box.fill("/stamp-word pelican");
  await box.press("Escape");
  await box.press("Enter");
  await expect(page.getByTestId("note").first()).toContainText("Loaded the stamp-word skill");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText("STAMP-pelican-STAMP");
  await shoot(page, "skills-02-owner-ran");

  await box.fill("Load the bird-fact skill with the Skill tool, with args heron, and follow it.");
  await box.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 90_000 });
  await expect(page.locator('[data-tool="Skill"]')).toBeVisible();
  await expect(page.getByTestId("assistant-text").last()).toContainText("BIRDFACT-heron");
  await shoot(page, "skills-03-model-loaded");

  // After a clear the skill is gone from what the model sees: loading it again sends its body, not "already loaded".
  expect((await request.post(`/api/sessions/${session.id}/clear`)).ok()).toBe(true);
  await box.fill("Load the bird-fact skill with the Skill tool, with args heron, and follow it.");
  await box.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(3, { timeout: 90_000 });
  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  const skillIds = new Set(evs.filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks).filter((b: any) => b.type === "tool_use" && b.name === "Skill").map((b: any) => b.id));
  const last = evs.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).filter((r: any) => skillIds.has(r.tool_use_id)).map((r: any) => JSON.stringify(r.content)).at(-1);
  expect(last).toContain("BIRDFACT-$ARGUMENTS".replace("$ARGUMENTS", "heron"));
  expect(last).not.toContain("already loaded");

  // Past the listing's budget (a share of the default model's window), the skills
  // loaded least are listed by name only, and Settings > Skills says so.
  const { listing } = await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json();
  expect(listing.budget).toBeGreaterThanOrEqual(2_000);
  for (let i = 0; i < Math.ceil(listing.budget / 1_400) + 2; i++) skill(`many-${String(i).padStart(2, "0")}`, "Say done.", `Use when task ${i} comes up. ${"Long words about this one. ".repeat(52)}`);
  const after = (await (await request.get(`/api/skills?cwd=${encodeURIComponent(ws)}`)).json());
  expect(after.listing.name_only).toBeGreaterThan(0);
  const short = after.skills.find((s: any) => s.name_only).name as string;
  expect(after.skills.find((s: any) => s.name === "bird-fact").name_only).toBe(false); // loaded once: it keeps its description
  await page.goto("/settings/skills");
  await expect(page.getByTestId("toolkit-folder")).toContainText("name only");
  const row = page.getByTestId("skill-entry").filter({ hasText: short });
  await expect(row).toContainText("name only");
  await row.click();
  await expect(page.getByTestId("skill-name-only")).toContainText(`${listing.budget.toLocaleString("en-US")} characters`);
  await shoot(page, "skills-04-name-only");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// Feature: what a skill's frontmatter asks for (Claude Code's skills
// reference). allowed-tools run without asking in the turn that loaded the
// skill and ask again in the next; context: fork runs the skill as an agent
// of its own (background: false waits for its report in the same call); the
// owner's /command of an inline skill grants its tools for the turn it starts.
test("skills: allowed-tools for one turn, context: fork as an agent", async ({ page, request }) => {
  test.skip(!SCRIPTED, "drives the calls with the scripted model");
  const tag = Date.now().toString(36);
  const ws = join(process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-tools`, `skills-fm-${tag}`);
  const skill = (name: string, front: string, body: string) => {
    mkdirSync(join(ws, ".claude/skills", name), { recursive: true });
    writeFileSync(join(ws, ".claude/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n${front}---\n${body}\n`);
  };
  skill(`grant-${tag}`, `allowed-tools: Bash(touch granted-${tag}.txt) Write\n`, "Touch the file.");
  skill(`fork-${tag}`, "context: fork\nbackground: false\n", `script:say forked-${tag}-done`);
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const results = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results.map((r: any) => JSON.stringify(r.content)));
  const send = (c: unknown[]) => request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(c)}` } });
  const touch = { name: "Bash", input: { command: `touch granted-${tag}.txt` } };
  const ends = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "turn_end").length;

  // The model loads the skill: its command runs without a card in that turn.
  await send([{ name: "Skill", input: { skill: `grant-${tag}` } }, touch]);
  await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(2);
  expect((await results())[0]).toContain("run without asking, as the skill's allowed-tools say");
  expect((await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals ?? []).toHaveLength(0);
  await expect.poll(ends, { timeout: 30_000 }).toBe(1);
  // The next turn: the same command asks again.
  await send([touch]);
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("approval").first().getByTestId("approval-summary")).toContainText(`touch granted-${tag}.txt`, { timeout: 30_000 });
  await shoot(page, "skills-04-grant-ended");
  const [card] = (await (await request.get(`/api/sessions/${session.id}/approvals`)).json()).approvals;
  expect((await request.post(`/api/sessions/${session.id}/approvals/${card.id}`, { data: { choice: "deny", reason: "not this turn" } })).ok()).toBe(true);

  // context: fork: the skill is an agent's task; background: false waits for its report.
  await expect.poll(ends, { timeout: 30_000 }).toBe(2);
  const before = (await results()).length;
  await send([{ name: "Skill", input: { skill: `fork-${tag}` } }]);
  await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(before + 1);
  expect((await results()).at(-1)).toContain(`forked-${tag}-done`);
  const agents = (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents as any[];
  expect(agents.map((a) => a.title)).toContain(`/fork-${tag}`);
});
