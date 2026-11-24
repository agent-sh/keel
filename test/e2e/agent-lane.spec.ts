import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./isolate.ts";
import { SHOTS, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-lane`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const calls = (l: unknown[]) => `script:calls ${JSON.stringify(l)}`;
const KEYS = ["doing", "waits", "wrong", "changed", "next"];

// Feature: an agent's lane in five lines. A coordinator in a repository that
// names a check starts five agents, one in each state: one works (a long
// command after its plan), one waits on a command it left running, one waits
// on the owner's answer, one failed, one is done in a worktree of its own
// after it wrote a file and ran the check. Its row in the sidebar's tree, its
// card in the coordinator and the card on a phone say, for each, what it is
// doing, what it waits for and since when, what went wrong, what it changed
// (files, branch, head, the check on that tree) and what comes next (its own
// plan, marked as its words), each line from what Keel keeps, and a fact that
// is missing says so. No model request makes a lane.
test("an agent's lane: doing, waits for, went wrong, changed and next, for each state", async ({ page, request, browser, baseURL }) => {
  test.setTimeout(240_000);
  const model = "scripted:stand-in-strict";
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === model), "needs the scripted provider: the stand-in runs the agents' calls on demand");

  const repo = join(DEV, `lane-${Date.now()}`);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { unit: "sh unit.sh" } }));
  writeFileSync(join(repo, "unit.sh"), "echo ' 4 pass'\necho ' 0 fail'\n");
  // (The ledger is kept by content: this run's own content has no runs of an earlier run.)
  writeFileSync(join(repo, "README.md"), `# ${repo}\n`);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "First commit");

  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Lane coordinator", workspace: repo } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto" } });
  type Agent = { id: string; title: string; status: string; session_id: string };
  const tree = async () => (await (await request.get(`/api/sessions/${id}/agents`)).json()).tree as Agent[];
  const usage = async () => JSON.stringify((await (await request.get(`/api/sessions/${id}`)).json()).session.usage);
  const spawn = (message: string, isolation = "none") => ({ name: "spawn_agent", input: { message, isolation } });
  const plan = { name: "TodoWrite", input: { todos: [{ content: "Write the note", status: "completed", activeForm: "Writing the note" }, { content: "Run the slow suite", status: "in_progress", activeForm: "Running the slow suite" }] } };
  const agents = [
    spawn(`Worker\n${calls([plan, { name: "Bash", input: { command: "sleep 150; echo done" }, think: "The note is written. Running the slow suite now." }])}`),
    spawn(`Parker\n${calls([{ name: "Bash", input: { command: "sleep 180; echo built", run_in_background: true, description: "The long build" } }])}`),
    spawn(`Asker\n${calls([{ name: "AskUserQuestion", input: { questions: [{ question: "Which store should I use?", header: "Store", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }])}`),
    spawn("Broken\nscript:billing"),
    spawn(`Builder\n${calls([{ name: "Write", input: { file_path: "notes/plan.md", content: "# plan\n" } }, { name: "Bash", input: { command: "sh unit.sh" } }])}`, "worktree"),
  ];
  try {
    await page.goto(`/s/${id}`);
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:batch ${JSON.stringify(agents)}` } });
    const want: Record<string, string> = { Worker: "running", Parker: "waiting", Asker: "running", Broken: "failed", Builder: "completed" };
    await expect.poll(async () => Object.fromEntries((await tree()).map((a) => [a.title, a.status])), { timeout: 60_000 }).toEqual(want);
    // The worker is in its command, the parker's turn ended on its build, the asker's question is up.
    const laneOf = async (title: string) => {
      const a = (await tree()).find((x) => x.title === title)!;
      return (await (await request.get(`/api/automation/agents/${a.id}/lane`)).json()) as { lines: { key: string; text: string; from: string; tone?: string }[]; ms: number };
    };
    await expect.poll(async () => (await laneOf("Worker")).lines.find((l) => l.key === "waits")!.text, { timeout: 30_000 }).toMatch(/^Its command, running since/);
    await expect.poll(async () => (await laneOf("Parker")).lines.find((l) => l.key === "waits")!.text, { timeout: 30_000 }).toMatch(/^Background command \w+ \u201cThe long build\u201d \(its description\) since/);
    await expect.poll(async () => (await laneOf("Asker")).lines.find((l) => l.key === "waits")!.tone, { timeout: 30_000 }).toBe("need");

    // Reading lanes asks no model: the coordinator's usage does not move.
    const before = await usage();
    for (const t of Object.keys(want)) expect((await laneOf(t)).lines.map((l) => l.key)).toEqual(KEYS);
    expect(await usage()).toBe(before);

    // The sidebar's tree: each row opens its lane under it.
    await page.setViewportSize({ width: 1920, height: 1040 });
    const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`).locator("xpath=..");
    const toggle = row.getByTestId("children-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const kid = (title: string) => row.getByTestId("child-row").filter({ has: page.getByTestId("child-title").getByText(title, { exact: true }) });
    // What each row says before its lane opens: its mark's word and, while it works, its "now" line.
    const said: Record<string, { row: string; lane: Record<string, string> }> = {};
    for (const t of Object.keys(want)) {
      const r = kid(t);
      said[t] = { row: (await r.innerText()).replace(/\s+/g, " ").trim(), lane: {} };
      await r.hover();
      await r.getByTestId("child-lane-fold").click();
      await expect(r.getByTestId("child-lane")).toHaveAttribute("data-ready", "");
    }
    const line = (r: Locator, key: string) => r.getByTestId(`lane-${key}`).locator(".k-lane-text");
    await expect(line(kid("Worker"), "doing")).toContainText("Running the slow suite now.");
    await expect(kid("Worker").getByTestId("lane-doing")).toHaveAttribute("data-from", "own");
    await expect(line(kid("Worker"), "waits")).toContainText("Its command, running since");
    await expect(line(kid("Worker"), "next")).toHaveText("\u201cRun the slow suite\u201d (its plan, 1 of 2 done)");
    await expect(line(kid("Parker"), "waits")).toContainText("\u201cThe long build\u201d (its description) since");
    await expect(kid("Parker").getByTestId("lane-next")).toHaveAttribute("data-from", "missing");
    await expect(kid("Asker").getByTestId("lane-waits")).toHaveAttribute("data-tone", "need");
    await expect(line(kid("Asker"), "waits")).toContainText("Its question, \u201cWhich store should I use?\u201d");
    await expect(kid("Broken").getByTestId("lane-wrong")).toHaveAttribute("data-tone", "fail");
    await expect(line(kid("Broken"), "wrong")).toContainText("credit balance is too low");
    await expect(line(kid("Builder"), "changed")).toContainText(/1 file on keel\/\S+ at [0-9a-f]{7,} \u201cFirst commit\u201d \(its commit message\), not committed: notes\/plan\.md\. Checks on this tree: unit passed/);
    await expect(line(kid("Builder"), "next")).toHaveText("Nothing: its report went to its parent");
    for (const t of Object.keys(want)) for (const k of KEYS) said[t]!.lane[k] = (await line(kid(t), k).textContent()) ?? "";
    writeFileSync(join(SHOTS, "agent-lane-rows.json"), JSON.stringify(said, null, 2));
    await page.mouse.move(1900, 1000);
    await kid("Worker").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shoot(page, "agent-lane-01-tree");

    // The card in the coordinator: its lane comes first when it opens.
    const group = page.locator('[data-testid="work-step"][data-family="agents"]').locator("button.k-line").first();
    await expect(group).toBeVisible({ timeout: 30_000 });
    await group.click();
    const card = (p: Page, title: string) => p.getByTestId("agent-call").filter({ has: p.getByTestId("agent-call-title").getByText(title) });
    for (const t of ["Asker", "Builder"]) {
      await card(page, t).locator("button.k-line").first().click();
      await expect(card(page, t).getByTestId("agent-lane")).toHaveAttribute("data-ready", "");
    }
    await expect(card(page, "Builder").getByTestId("lane-changed")).toContainText("notes/plan.md");
    await expect(card(page, "Asker").getByTestId("lane-waits")).toContainText("Which store should I use?");
    await card(page, "Asker").scrollIntoViewIfNeeded();
    await shoot(page, "agent-lane-02-cards");

    // On a phone: the same lane in the card, its lines whole within the screen's width.
    const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const phone = await ctx.newPage();
      await phone.goto(`/s/${id}`);
      const g = phone.locator('[data-testid="work-step"][data-family="agents"]').locator("button.k-line").first();
      // (The group stands far above the end, where the question card above the message box takes the room: a block
      // far from the view is held, not drawn. The view goes up to it by the reader's own scroll.)
      await expect.poll(async () => {
        if (await g.count()) return true;
        await phone.getByTestId("transcript").evaluate((el) => el.parentElement!.scrollBy(0, -300));
        return false;
      }, { timeout: 30_000 }).toBe(true);
      await expect(g).toBeVisible();
      await g.tap();
      for (const t of ["Broken", "Asker"]) {
        await card(phone, t).locator("button.k-line").first().tap();
        await expect(card(phone, t).getByTestId("agent-lane")).toHaveAttribute("data-ready", "");
      }
      const lane = card(phone, "Broken").getByTestId("agent-lane");
      await expect(lane.getByTestId("lane-wrong")).toHaveAttribute("data-tone", "fail");
      const box = (await lane.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await lane.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shoot(phone, "agent-lane-03-phone");
      const asking = card(phone, "Asker").getByTestId("agent-lane");
      await expect(asking.getByTestId("lane-waits")).toHaveAttribute("data-tone", "need");
      await asking.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shoot(phone, "agent-lane-04-phone-asking");
    } finally {
      await ctx.close();
    }
  } finally {
    for (const a of await tree().catch(() => [] as Agent[])) await request.post(`/api/sessions/${id}/agents/${a.id}/stop`).catch(() => {});
    await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});
