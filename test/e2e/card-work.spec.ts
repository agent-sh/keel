import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the hover card of a list row has one Work line. A coordinator's agent commits on its branch and
// passes the repository's named check: the coordinator's card says the branch, its files and lines, that its
// checks are green on this tree and that it is ready to land. A session with no agents has no such line.
test("the hover card says what the session's branch holds", async ({ page, request }) => {
  test.setTimeout(180_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `card-work-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(join(repo, ".keel"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n") + `\nrun ${Date.now()}\n`);
  writeFileSync(join(repo, "check.sh"), "grep -q 'line 1' notes.md\n");
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const lane = { name: "spawn_agent", input: { message: `Lane work\nscript:calls ${JSON.stringify([bash("sed -i 's/^line 1$/line 1 DONE/' notes.md && git -c user.name=k -c user.email=k@k commit -qam 'Lane work'"), bash("sh check.sh")])}` } };
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const alone = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: top, title: "Alone" } })).json()).session.id as string;
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start one agent.", `script:batch ${JSON.stringify([lane])}`) } });
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[]).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(1);
  await expect.poll(async () => { const d = await (await request.get(`/api/sessions/${coord}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);

  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("keel.focus", "true"); sessionStorage.setItem("seeded", "1"); } });
  await page.goto(`/s/${alone}`);
  const entry = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  const card = page.getByTestId("rail-card");
  await entry(coord).hover();
  await expect(card).toBeVisible();
  const work = card.getByTestId("rail-card-work");
  await expect(work).toContainText(/keel\/.*1 file \+1 -1.*checks green on this tree.*ready to land/, { timeout: 30_000 });
  await shoot(page, "card-work-01-line");
  await page.mouse.move(0, 0);
  await expect(card).toHaveCount(0);

  // A session with no agents has no branch to tell: its card has no Work line (and the page read no board for it).
  await entry(alone).hover();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("rail-card-work")).toHaveCount(0);
  await shoot(page, "card-work-02-none");
  await page.mouse.move(0, 0);
  await request.delete(`/api/sessions/${coord}`);
  await request.delete(`/api/sessions/${alone}`);
});
