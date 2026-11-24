import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: a plan of lanes checked before any agent starts. A coordinator sends a plan of three lanes
// with keel__lane_plan: alpha and beta both name src/z.ts, gamma restyles ui/a.css. Nothing starts.
// The Lane plan panel shows each lane with its files, the pair that meets (same file, lanes 1 and 2)
// and the proposed order: alpha and gamma now, beta after alpha lands. One press starts the proposal:
// alpha and gamma work, beta waits. Gamma's commit also changes src/y.ts, which the plan gave beta:
// gamma is told once, as a note in its next model request, and its card says so. Alpha's work lands
// on main; beta then starts by itself, from a main that holds alpha's commit.
test("a plan of lanes is shown with its overlaps and started in the proposed order", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `lanes-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "ui"));
  mkdirSync(join(repo, "docs"));
  git(repo, "init", "-q", "-b", "main");
  for (const f of ["src/x.ts", "src/y.ts", "src/z.ts"]) writeFileSync(join(repo, f), `export const v = "${f}";\n`);
  writeFileSync(join(repo, "ui/a.css"), ".a { color: red; }\n");
  writeFileSync(join(repo, "docs/guide.md"), "# Guide\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const commit = (msg: string) => `git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;

  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const lanes = [
    { title: "Lane alpha", brief: `Rework src/z.ts and src/x.ts, and add src/w.ts.\n${calls([bash(`echo '// alpha' >> src/z.ts && ${commit("Lane alpha")}`)])}` },
    { title: "Lane beta", brief: `Fix src/z.ts and src/y.ts, and say so in docs/guide.md.\n${calls([bash(`echo '// beta' >> src/z.ts && ${commit("Lane beta")}`)])}` },
    // (Its command reaches src/y.ts through a variable, so its brief does not name it.)
    { title: "Lane gamma", brief: `Restyle ui/a.css.\n${calls([bash(`f=src/y; echo '// gamma' >> $f.ts && echo '.b {}' >> ui/a.css && ${commit("Lane gamma")}`)])}` },
  ];
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Plan three lanes.", calls([{ name: "keel__lane_plan", input: { action: "plan", lanes } }])) } });
  await idle(coord);
  const plans = async () => (await (await request.get(`/api/sessions/${coord}/lane-plans`)).json()).plans as any[];
  const plan = (await plans())[0];
  expect(plan.lanes).toHaveLength(3);
  expect(plan.meetings).toEqual([{ a: 0, b: 1, kind: "file", files: ["src/z.ts"] }]);
  expect(plan.proposal.units.map((u: any) => [u.lanes, u.wave, u.after])).toEqual([[[0], 0, []], [[1], 1, [0]], [[2], 0, []]]);
  // Nothing started: the coordinator has no agent yet.
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  expect(await agentsOf()).toHaveLength(0);

  // The panel: three lanes with their files, the pair that meets, the proposal.
  await page.goto(`/s/${coord}`);
  await openPanel(page, "lanes");
  const panel = page.getByTestId("lane-plan");
  const card = (i: number) => panel.locator(`[data-testid="lane-card"][data-lane="${i}"]`);
  await expect(panel.getByTestId("plan-meeting")).toHaveCount(1);
  await expect(panel.getByTestId("plan-meeting")).toHaveAttribute("data-kind", "file");
  await expect(panel.getByTestId("plan-meeting")).toContainText("src/z.ts");
  await expect(card(0).locator('[data-testid="lane-file"][data-meet="file"]')).toHaveText("src/z.ts");
  await expect(card(1).locator('[data-testid="lane-file"][data-meet="file"]')).toHaveText("src/z.ts");
  await expect(card(0).locator('[data-testid="lane-file"][data-how="new"]')).toContainText("src/w.ts");
  await expect(card(2).getByTestId("lane-files")).toContainText("ui/a.css");
  await expect(panel.getByTestId("plan-wave")).toHaveCount(2);
  await expect(panel.locator('[data-testid="plan-wave"][data-wave="0"] [data-testid="plan-unit"]')).toHaveCount(2);
  await expect(panel.locator('[data-testid="plan-wave"][data-wave="1"] [data-testid="plan-unit"]')).toContainText("after 1 lands");
  for (const i of [0, 1, 2]) await expect(card(i)).toHaveAttribute("data-state", "planned");
  await page.mouse.move(0, 0);
  await shoot(page, "lane-plan-01-planned");

  // One press: the proposed order.
  await panel.getByTestId("plan-start-order").click();
  await expect(card(1)).toHaveAttribute("data-state", "waiting");
  await expect(card(1).getByTestId("lane-state")).toHaveText("waits for 1 to land");
  await expect.poll(async () => (await agentsOf()).map((a) => a.title).sort(), { timeout: 30_000 }).toEqual(["Lane alpha", "Lane gamma"]);
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed").length, { timeout: 90_000 }).toBe(2);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const alpha = await by("Lane alpha"), gamma = await by("Lane gamma");

  // Gamma changed src/y.ts, beta's: told once, in its own session, and on its card.
  const notes = async (id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "note" && e.data?.kind === "lane_plan");
  await expect.poll(async () => (await notes(gamma.session_id)).length, { timeout: 30_000 }).toBe(1);
  expect((await notes(gamma.session_id))[0].data.text).toContain('src/y.ts: the plan gives it to lane 2 "Lane beta"');
  await expect(card(2).getByTestId("lane-stray")).toContainText("src/y.ts");
  await expect(card(2).getByTestId("lane-stray")).toContainText("told");
  // Beta still waits: alpha is done but its work is not on main.
  expect((await agentsOf()).some((a) => a.title === "Lane beta")).toBe(false);
  await expect(card(1)).toHaveAttribute("data-state", "waiting");
  await expect(card(0).getByTestId("lane-changed")).toContainText("Changed 1 file: 1 planned");
  await expect(card(0).getByTestId("lane-state")).toHaveText("Done · not on main yet");
  await page.mouse.move(0, 0);
  await shoot(page, "lane-plan-02-waiting");

  // Alpha lands on main: beta starts by itself, from a main that holds alpha's commit.
  const alphaTip = git(repo, "rev-parse", alpha.branch).trim();
  git(repo, "merge", "-q", "--ff-only", alpha.branch);
  await expect.poll(async () => (await agentsOf()).some((a) => a.title === "Lane beta"), { timeout: 45_000 }).toBe(true);
  await expect.poll(async () => (await by("Lane beta")).status, { timeout: 90_000 }).toBe("completed");
  const beta = await by("Lane beta");
  expect(() => git(repo, "merge-base", "--is-ancestor", alphaTip, beta.branch)).not.toThrow();
  // And beta's work merges onto main with alpha's: no conflict at landing.
  expect(() => git(repo, "merge", "-q", "--no-edit", beta.branch)).not.toThrow();
  await expect(card(1)).toHaveAttribute("data-state", "done");
  // What each changed is read from where its worktree was made, also once the base holds it.
  await expect(card(0).getByTestId("lane-state")).toHaveText("Done · on main");
  await expect(card(0).getByTestId("lane-changed")).toContainText("Changed 1 file: 1 planned");
  await expect(card(1).getByTestId("lane-changed")).toContainText("Changed 1 file: 1 planned");
  await expect(panel.getByTestId("plan-actions")).toHaveCount(0);
  // Gamma was told once only.
  expect(await notes(gamma.session_id)).toHaveLength(1);
  await page.mouse.move(0, 0);
  await shoot(page, "lane-plan-03-started");

  // On a phone: a plan whose merged lanes have long titles fits the screen, its titles wrapped.
  const long = "Rework the agents module and the tool list so a long title wraps on a narrow screen";
  const made = await request.post(`/api/sessions/${coord}/lane-plans`, { data: { lanes: [
    { title: long, brief: "Rework src/z.ts and src/x.ts.", files: ["src/z.ts", "src/x.ts"] },
    { title: "Beta, which shares both files with the first lane", brief: "Fix src/z.ts and src/x.ts.", files: ["src/z.ts", "src/x.ts"] },
    { title: "Gamma", brief: "Restyle ui/a.css.", files: ["ui/a.css"] },
  ] } });
  expect(made.ok()).toBe(true);
  const at = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`/s/${coord}`);
    await openPanel(page, "lanes");
    const unit = page.getByTestId("lane-plan").locator('[data-testid="plan-unit"][data-lanes="0,1"]');
    await expect(unit).toContainText(long);
    const title = unit.getByTestId("plan-unit-title");
    const box = (await title.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThan(30); // wrapped, not cut on one line
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.mouse.move(0, 0);
    await shoot(page, "lane-plan-04-phone");
  } finally {
    await page.setViewportSize(at);
  }
});
