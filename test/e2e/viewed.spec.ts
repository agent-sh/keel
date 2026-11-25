import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

const turnsDone = async (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

// Feature: a per-file "Viewed" mark in the Changes panel. A marked file folds and is counted; when the agent's next
// turn changes one file, only that file loses its mark and opens again, and a reload keeps the others.
test("viewed marks fold a file and drop only when its own diff changes", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `viewed-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(ws, f), "one\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const run = (command: string) => request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: HAIKU.startsWith("scripted:") ? `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}` : `Run exactly this one Bash command and nothing else: ${command}\nThen reply ok.` },
  });
  await run("echo two >> a.txt && echo two >> b.txt && echo two >> c.txt");
  await turnsDone(request, session.id, 1);

  await page.goto(`/s/${session.id}`);
  await openPanel(page, "changes");
  const panel = page.getByTestId("changes-panel");
  const file = (name: string) => panel.locator(`[data-testid="diff-file"][data-path="${name}"]`);
  const count = panel.getByTestId("viewed-count");
  await expect(panel.getByTestId("diff-file")).toHaveCount(3);
  await expect(count).toHaveText("0 of 3 viewed");
  await expect(file("a.txt").locator("table")).toBeVisible();
  await shoot(page, "viewed-01-none");

  await file("a.txt").getByTestId("diff-viewed").click();
  await file("b.txt").getByTestId("diff-viewed").click();
  await expect(count).toHaveText("2 of 3 viewed");
  await expect(file("a.txt").locator("table")).toHaveCount(0);
  await expect(file("b.txt").locator("table")).toHaveCount(0);
  await expect(file("c.txt").locator("table")).toBeVisible();
  await expect(panel.getByTestId("file-viewed")).toHaveCount(2);
  await shoot(page, "viewed-02-two");

  // The marks are kept in this browser.
  await page.reload();
  await openPanel(page, "changes");
  await expect(panel.getByTestId("viewed-count")).toHaveText("2 of 3 viewed");

  // The next turn changes one file: it loses its mark and opens again; the other keeps its own.
  await run("echo three >> b.txt");
  await turnsDone(request, session.id, 2);
  await expect(panel.getByTestId("viewed-count")).toHaveText("1 of 3 viewed");
  await expect(file("b.txt").locator("table")).toBeVisible();
  await expect(file("b.txt").getByTestId("diff-viewed")).toHaveAttribute("aria-checked", "false");
  await expect(file("a.txt").getByTestId("diff-viewed")).toHaveAttribute("aria-checked", "true");
  await expect(file("a.txt").locator("table")).toHaveCount(0);
  await shoot(page, "viewed-03-one");
  // Marking it again counts it again.
  await file("b.txt").getByTestId("diff-viewed").click();
  await expect(panel.getByTestId("viewed-count")).toHaveText("2 of 3 viewed");
  await request.delete(`/api/sessions/${session.id}`);
});
