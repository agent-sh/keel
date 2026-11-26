import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

// Feature: where a session stands, without asking it. Each top row says in one quiet line, from facts
// and never from a model, what it runs or waits on, and at rest its last result (a named check, a
// landing); the card beside the row says the same line whole (for how long, when its wait gives up,
// the result's time), and the pane's head says the result in its reason's place.
const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-stand`;
const STAND_IN = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
const idle = async (request: APIRequestContext, id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };

test("a row says where its session stands from facts: its wait and when it gives up, then its last check", async ({ page, request }) => {
  test.skip(!SCRIPTED, "drives exact commands through the scripted stand-in");
  const repo = join(DEV, `stand-${Date.now()}`);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  writeFileSync(join(repo, "README.md"), `# ${repo}\n`);
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { lint: "sh lint.sh" } }));
  writeFileSync(join(repo, "lint.sh"), "echo 'Found 2 errors.'\nexit 1\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
  const gate = join(repo, "gate.txt");

  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Lint the parser", workspace: repo } })).json();
  const id = session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  try {
    await page.goto(`/s/${id}`);
    // 1. It waits on a file: the row says so, and its card says when the wait gives up.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: script([{ name: "wait_for", input: { kind: "file", path: gate, note: "the gate file", timeout_seconds: 600 } }]) } });
    await expect(row(page, id).getByTestId("row-why")).toBeVisible({ timeout: 30_000 });
    await row(page, id).hover();
    await expect(page.getByTestId("rail-card-why")).toContainText("Its wait gives up at ", { timeout: 15_000 });
    await shoot(page, "stand-line-01-waits");
    await page.mouse.move(1200, 600);
    writeFileSync(gate, "go\n");
    await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);

    // 2. A red named check, and the turn ends: at rest the row's line is its last result.
    await request.post(`/api/sessions/${id}/messages`, { data: { text: script([{ name: "Bash", input: { command: "sh lint.sh" } }]) } });
    await expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
    await expect(row(page, id).getByTestId("row-why")).toHaveText("lint failed", { timeout: 15_000 });
    await expect(row(page, id).getByTestId("row-why")).toHaveAttribute("data-why", "result");
    await expect(page.getByTestId("station-why")).toHaveText("lint failed");
    await expect(page.getByTestId("station-why")).toHaveAttribute("title", /Last: lint failed at/);
    await shoot(page, "stand-line-02-result");
    await row(page, id).hover();
    await expect(page.getByTestId("rail-card-why")).toContainText(/Last: lint failed at \d\d:\d\d/);
    await shoot(page, "stand-line-03-result-card");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});
