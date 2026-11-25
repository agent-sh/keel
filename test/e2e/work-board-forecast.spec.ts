import { expect, test, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

// A card's facts open under its chevron: open every card that has them, once the board shows its cards.
const expandAll = async (page: Page) => {
  const board = page.getByTestId("work-board");
  await expect(board.getByTestId("board-row").first()).toBeVisible();
  for (const t of await board.getByTestId("board-toggle").all()) if ((await t.getAttribute("aria-expanded")) === "false") await t.click();
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the work board holds Land for a branch that git merge-tree says would conflict (the overlap forecast's merge),
// with another live branch or with the base, and names the other one. A coordinator starts three agents: two
// change line 1 of one file differently (each would conflict with the other), one changes line 12 alone (clean,
// Land stays). Then the base takes a different change to line 12: the third is held for the base.
test("the board holds Land for a branch the overlap forecast says would conflict, and names the other", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `forecast-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const lane = (title: string, sed: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command: commit(sed, title) } }])}` } });

  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start three agents.", `script:batch ${JSON.stringify([
    lane("Lane one", "s/^line 1$/line 1 ONE/"),
    lane("Lane two", "s/^line 1$/line 1 TWO/"),
    lane("Lane three", "s/^line 12$/line 12 THREE/"),
  ])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(3);
  await idle(coord);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const one = await by("Lane one"), two = await by("Lane two"), three = await by("Lane three");

  const board = async () => (await (await request.get(`/api/sessions/${coord}/board?fresh=1`)).json()) as any;
  const rowOf = (b: any, id: string) => b.rows.find((r: any) => r.id === id);
  // The forecast names each of the two to the other; the third is clean.
  await expect.poll(async () => rowOf(await board(), one.id)?.forecast?.map((f: any) => f.with), { timeout: 60_000 }).toEqual([two.branch]);
  const b = await board();
  expect(rowOf(b, two.id).forecast).toMatchObject([{ with: one.branch, with_agent: one.id, base: false, files: ["notes.md"] }]);
  expect(rowOf(b, three.id).forecast).toEqual([]);

  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${coord}`);
  await openPanel(page, "board");
  await expandAll(page);
  const card = (id: string) => page.locator(`[data-testid="board-row"][data-agent="${id}"]`);
  await expect(card(one.id).getByTestId("board-forecast-conflict")).toHaveAttribute("data-with", two.branch);
  await expect(card(one.id).getByTestId("board-forecast-conflict")).toContainText("Would conflict with");
  await expect(card(one.id).getByTestId("board-forecast-files")).toHaveText("notes.md");
  // Land is there, held, with the forecast's words as the reason.
  await expect(card(one.id).getByTestId("board-land")).toBeDisabled();
  await expect(card(one.id).getByTestId("board-held")).toContainText("would conflict with");
  await expect(card(two.id).getByTestId("board-land")).toBeDisabled();
  await expect(card(three.id).getByTestId("board-forecast")).toHaveCount(0);
  await expect(card(three.id).getByTestId("board-land")).toBeEnabled();
  await page.mouse.move(0, 0);
  await shoot(page, "work-board-forecast-pair");

  // The base takes another change to line 12: the third would now conflict with the base.
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => (i === 11 ? "line 12 MAIN" : `line ${i + 1}`)).join("\n") + "\n");
  git(repo, "commit", "-qam", "Main changes line 12");
  await expect.poll(async () => rowOf(await board(), three.id)?.forecast?.map((f: any) => [f.with, f.base]), { timeout: 60_000 }).toEqual([["main", true]]);
  await page.reload();
  await openPanel(page, "board");
  await expandAll(page);
  await expect(card(three.id).getByTestId("board-forecast-conflict")).toHaveAttribute("data-base", "yes");
  await expect(card(three.id).getByTestId("board-forecast-conflict")).toContainText("the base");
  await expect(card(three.id).getByTestId("board-land")).toBeDisabled();
  await page.mouse.move(0, 0);
  await shoot(page, "work-board-forecast-base");
});
