import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const MODEL = "scripted:stand-in";

// Feature: branches that wait only for a landing are listed across the owner's sessions, in Home and in the
// Inbox, one line each with Open and Land. Two coordinators: the first has two agents, one whose named check
// passed and one whose check failed; the second has one with a passing check; a reviewer approves every head.
// Home and the Inbox list the two clean branches only, and nothing else changes: no need is counted, the tab
// title carries no number, no row of the session list says anything of it. Land queues one and it leaves the list
// once the queue has it; a branch whose head moved after the list was read is refused, and leaves the list.
test("branches ready to land are listed in Home and the Inbox, uncounted, and Land is refused for a moved head", async ({ page, request, browser, baseURL }) => {
  test.setTimeout(240_000);
  test.skip(!(await (await request.get("/api/models")).json()).models.some((m: any) => m.id === MODEL), "requires the scripted provider");
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `ready-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + `\nrun ${Date.now()}\n`);
  writeFileSync(join(repo, "check.sh"), "echo checking; ! grep -q BAD notes.md\n");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model: MODEL, workspace: repo, title } })).json()).session.id as string;
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const lane = (title: string, sed: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([bash(commit(sed, title)), bash("sh check.sh")])}` } });
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const agentsOf = async (id: string) => (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[];

  const one = await make("Ready one"), two = await make("Ready two");
  await send(one, `script:batch ${JSON.stringify([lane("Lane alpha", "s/^line 1$/line 1 ALPHA/"), lane("Lane gamma", "s/^line 6$/line 6 BAD/")])}`);
  await send(two, `script:batch ${JSON.stringify([lane("Lane delta", "s/^line 9$/line 9 DELTA/")])}`);
  for (const [id, n] of [[one, 2], [two, 1]] as const) await expect.poll(async () => (await agentsOf(id)).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(n);
  const by = async (root: string, title: string) => (await agentsOf(root)).find((a) => a.title === title)!;
  const alpha = await by(one, "Lane alpha"), gamma = await by(one, "Lane gamma"), delta = await by(two, "Lane delta");

  // A reviewer approves each head, the failing one too: only its check tells it from the others.
  const verdict = (b: any) => ({ name: "keel__verdict", input: { commit: git(repo, "rev-parse", b.branch).trim(), land: "yes", why: "Checked the diff." } });
  await send(one, `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review both.\n${calls([verdict(alpha), verdict(gamma)])}`, agent_type: "explorer", reviews: `${alpha.branch} ${gamma.branch}` } }])}`);
  await send(two, `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review it.\n${calls([verdict(delta)])}`, agent_type: "explorer", reviews: delta.branch } }])}`);

  // The board says both heads are approved (its facts, which the list is made from).
  const verdictOf = async (root: string, b: any) => ((await (await request.get(`/api/sessions/${root}/board`)).json()).rows as any[]).find((r) => r.branch === b.branch)?.review?.verdict;
  await expect.poll(() => verdictOf(one, alpha), { timeout: 90_000 }).toBe("approved");
  await expect.poll(() => verdictOf(two, delta), { timeout: 90_000 }).toBe("approved");

  // Home: the part lists the two clean branches, each with its session; the red one is not there.
  await page.goto("/");
  await expect(page.getByTestId("session-row").first()).toBeVisible();
  await shoot(page, "ready-00-home-before");
  const cards = async () => ((await (await request.get("/api/landings")).json()).cards as any[]).map((c) => c.branch).sort();
  await expect.poll(cards, { timeout: 90_000 }).toEqual([alpha.branch, delta.branch].sort());
  const part = page.getByTestId("ready-part");
  await expect(part.getByTestId("ready-row")).toHaveCount(2);
  await expect(part.getByTestId("ready-head")).toContainText("Ready to land");
  await expect(part.locator(`[data-branch="${alpha.branch}"]`).getByTestId("ready-title")).toHaveText("Ready one");
  await expect(part.locator(`[data-branch="${delta.branch}"]`).getByTestId("ready-title")).toHaveText("Ready two");
  await expect(part.locator(`[data-branch="${gamma.branch}"]`)).toHaveCount(0);
  // Nothing counts it: no need in the headline, no number in the tab title, nothing on the rows of the list.
  await expect(page.getByTestId("home-count-need")).toHaveCount(0);
  expect(await page.title()).not.toMatch(/^\(\d+\)/);
  await expect(page.getByTestId("session-row").filter({ hasText: /ready to land/i })).toHaveCount(0);
  await shoot(page, "ready-01-home");

  // The Inbox lists the same two, and its unread count is as it was.
  await page.getByTestId("inbox-button").click();
  const inbox = page.getByTestId("inbox-panel");
  await expect(inbox.getByTestId("ready-row")).toHaveCount(2);
  await expect(inbox.getByTestId("inbox-part").filter({ hasText: "Ready to land" })).toHaveCount(0);
  await shoot(page, "ready-02-inbox");
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // A phone shows the same two, one line each, and Land stays a press of its own.
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto("/");
  const onPhone = phone.getByTestId("ready-part");
  await expect(onPhone.getByTestId("ready-row")).toHaveCount(2);
  await expect(onPhone.getByTestId("ready-land").first()).toBeInViewport();
  await shoot(phone, "ready-02-phone");
  await ctx.close();

  // Delta's head moves after the list was read: Land with the print it was shown with is refused, and it leaves the list.
  const shown = ((await (await request.get("/api/landings")).json()).cards as any[]).find((c) => c.branch === delta.branch);
  writeFileSync(join(delta.worktree, "extra.md"), "more\n");
  git(delta.worktree, "add", "extra.md");
  git(delta.worktree, "commit", "-qm", "More on delta");
  const refused = await request.post(`/api/landings/${encodeURIComponent(shown.key)}/land`, { data: { fp: shown.fp } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toContain("facts changed");
  await expect(part.locator(`[data-branch="${delta.branch}"]`)).toHaveCount(0, { timeout: 30_000 });

  // Land alpha from Home: it goes to the queue, lands on main, and leaves the list.
  const base = git(repo, "rev-parse", "main").trim();
  await part.locator(`[data-branch="${alpha.branch}"]`).getByTestId("ready-land").click();
  await expect.poll(() => git(repo, "rev-parse", "main").trim(), { timeout: 90_000 }).not.toBe(base);
  await expect(part).toBeHidden({ timeout: 30_000 });
  expect(git(repo, "show", "main:notes.md")).toContain("line 1 ALPHA");
  // The card held the head it showed: the landing is kept as the owner's own, of that commit, from the card's tree.
  const entry = ((await (await request.get(`/api/sessions/${one}/landing`)).json()).entries as any[]).find((e) => e.branch === alpha.branch);
  expect([entry.owner_tip, entry.owner_via]).toEqual([entry.tip, one]);
  await shoot(page, "ready-03-landed");
});
