import { expect, test } from "./isolate.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
// reference). The owner's own skill's allowed-tools run without asking in the
// turn that loaded it and ask again in the next; a repository's skill grants
// nothing until the owner trusts it himself; the owner's /command sent while
// a turn runs grants that turn only, never a later one; context: fork runs
// the skill as an agent of its own (background: false waits for its report).
test("skills: allowed-tools for one turn, only the owner's, context: fork as an agent", async ({ page, request }) => {
  test.skip(!SCRIPTED, "drives the calls with the scripted model");
  const tag = Date.now().toString(36);
  const home = process.env.HOME!;
  const base = join(process.env.KEEL_DEV_DIR ?? `${home}/.cache/keel-work/bun/dev-tools`, `skills-fm-${tag}`);
  const ws = join(base, "ws"), repo = join(base, "repo");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const skill = (root: string, name: string, front: string, body: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n${front}---\n${body}\n`);
  };
  const mine = join(home, ".claude/skills");
  const outside = join(base, `outside-${tag}.txt`);
  skill(mine, `grant-${tag}`, `allowed-tools: Bash(touch granted-${tag}.txt) Write\n`, "Touch the file.");
  skill(mine, `cmd-${tag}`, `allowed-tools: Bash(touch ${outside})\ndisable-model-invocation: true\n`, "Owner command.");
  skill(mine, `fork-${tag}`, "context: fork\nbackground: false\n", `script:say forked-${tag}-done`);
  // A cloned repository's own skill that grants itself the whole shell.
  skill(join(repo, ".claude/skills"), `repo-${tag}`, "allowed-tools: Bash\n", "Run what is asked.");
  try {
    const open = async (folder: string) => {
      const { session } = await (await request.post("/api/sessions", { data: { workspace: folder, model: HAIKU } })).json();
      await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
      return session.id as string;
    };
    const events = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
    const results = async (id: string) => (await events(id)).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results.map((r: any) => JSON.stringify(r.content)));
    const ends = async (id: string) => (await events(id)).filter((e) => e.kind === "turn_end").length;
    const cards = async (id: string) => ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals ?? []) as any[];
    const send = (id: string, c: unknown[]) => request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify(c)}` } });
    const deny = async (id: string) => { for (const a of await cards(id)) await request.post(`/api/sessions/${id}/approvals/${a.id}`, { data: { choice: "deny", reason: "not this turn" } }); };
    const bash = (command: string) => ({ name: "Bash", input: { command } });
    const touch = bash(`touch granted-${tag}.txt`);

    // The owner's skill, loaded by the model: its command runs without a card in that turn.
    const id = await open(ws);
    await send(id, [{ name: "Skill", input: { skill: `grant-${tag}` } }, touch]);
    await expect.poll(async () => (await results(id)).length, { timeout: 60_000 }).toBe(2);
    expect((await results(id))[0]).toContain(`run without asking, as the skill's allowed-tools say: Bash(touch granted-${tag}.txt), Write`);
    expect(await cards(id)).toHaveLength(0);
    await expect.poll(() => ends(id), { timeout: 30_000 }).toBe(1);
    // The next turn: the same command asks again.
    await send(id, [touch]);
    await page.goto(`/s/${id}`);
    await expect(page.getByTestId("approval").first().getByTestId("approval-summary")).toContainText(`touch granted-${tag}.txt`, { timeout: 30_000 });
    await shoot(page, "skills-04-grant-ended");
    await deny(id);
    await expect.poll(() => ends(id), { timeout: 30_000 }).toBe(2);

    // The owner's /command while a turn runs: it grants that turn, and no later one.
    await send(id, [bash(`touch other-${tag}.txt`)]);
    await expect.poll(async () => (await cards(id)).length, { timeout: 30_000 }).toBe(1);
    expect((await request.post(`/api/sessions/${id}/skill`, { data: { name: `cmd-${tag}` } })).status()).toBe(201);
    await deny(id);
    await expect.poll(() => ends(id), { timeout: 30_000 }).toBe(3);
    await send(id, [bash(`touch ${outside}`)]);
    await expect.poll(async () => (await cards(id)).length, { timeout: 30_000 }).toBe(1);
    expect(existsSync(outside)).toBe(false);
    await deny(id);
    await expect.poll(() => ends(id), { timeout: 30_000 }).toBe(4);

    // A repository's own skill grants nothing: the command outside asks, and the skill says why.
    const rid = await open(repo);
    await send(rid, [{ name: "Skill", input: { skill: `repo-${tag}` } }, bash(`touch ${outside}`)]);
    await expect.poll(async () => (await cards(rid)).length, { timeout: 30_000 }).toBe(1);
    expect((await results(rid))[0]).toContain("this repository's own skill");
    expect(existsSync(outside)).toBe(false);
    await deny(rid);
    await expect.poll(() => ends(rid), { timeout: 30_000 }).toBe(1);
    // Once the owner trusts it himself, it grants its tools in the turn that loads it.
    const pinned = (await (await request.get(`/api/trust?cwd=${encodeURIComponent(repo)}`)).json()).files.find((f: any) => f.path.endsWith(`repo-${tag}`));
    expect(pinned).toMatchObject({ state: "trusted", auto: true });
    expect((await request.post("/api/trust", { data: { cwd: repo, files: [{ path: pinned.path, sha256: pinned.sha256 }] } })).ok()).toBe(true);
    const n = (await results(rid)).length;
    await send(rid, [{ name: "Skill", input: { skill: `repo-${tag}` } }, bash(`touch ${outside}`)]);
    await expect.poll(async () => (await results(rid)).length, { timeout: 60_000 }).toBe(n + 2);
    expect(existsSync(outside)).toBe(true);

    // context: fork: the skill is an agent's task; background: false waits for its report.
    const before = (await results(id)).length;
    await send(id, [{ name: "Skill", input: { skill: `fork-${tag}` } }]);
    await expect.poll(async () => (await results(id)).length, { timeout: 60_000 }).toBe(before + 1);
    expect((await results(id)).at(-1)).toContain(`forked-${tag}-done`);
    const agents = (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[];
    expect(agents.map((a) => a.title)).toContain(`/fork-${tag}`);
  } finally {
    for (const n of [`grant-${tag}`, `cmd-${tag}`, `fork-${tag}`]) rmSync(join(mine, n), { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
