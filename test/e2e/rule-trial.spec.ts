import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";
const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

// Feature: a safety rule change tried on the stored calls before it is on. The gate keeps what its rules decided of
// each call, so the current rules replayed agree with every stored call; an edit of the owner's namespaces in
// Settings > Safety shows its replay (which calls it would treat otherwise, with a link to each) before Save, and
// Save is offered for the edit the replay is of. (The remote points at a port nothing listens on: no push leaves.)
test("an edit of the owner's rules shows its replay over the stored calls before it is saved", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const had = ((await (await request.get("/api/settings")).json()).settings.accounts?.namespaces ?? []) as string[];
  test.skip(had.includes("127.0.0.1/trial"), "needs a daemon whose namespaces do not hold 127.0.0.1/trial");
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "rule-trial-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@e.test", "commit", "-q", "--allow-empty", "-m", "x");
  git("remote", "add", "theirs", "http://127.0.0.1:1/trial/lib.git");

  // Calls to replay: two that run, and a push beyond the owner's namespaces, which asks him in Full auto too (denied here).
  const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: STAND_IN, title: "Rule trial" } })).json();
  const base = `/api/sessions/${session.id}`;
  const turns = async () => { const r = await (await request.get(base)).json(); return r.running ? -1 : r.events.filter((e: any) => e.kind === "turn_end").length; };
  expect((await request.put(`${base}/permissions`, { data: { mode: "full-auto", sandbox: "off" } })).ok()).toBe(true);
  await page.goto(`/s/${session.id}`);
  await request.post(`${base}/messages`, { data: { text: calls([bash("git status --short"), bash("echo trial")]) } });
  await expect.poll(turns, { timeout: 30_000 }).toBe(1);
  await request.post(`${base}/messages`, { data: { text: calls([bash("git push theirs main")]) } });
  const card = page.getByTestId("approval");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByTestId("deny").click();
  await card.getByTestId("deny-send").click();
  await expect.poll(turns, { timeout: 30_000 }).toBe(2);

  // The current rules, replayed, agree with every call the gate kept its decision with.
  const now = await (await request.post("/api/safety/trial", { data: { days: 1 } })).json();
  expect(now.agreement.recorded.compared).toBeGreaterThanOrEqual(3);
  expect(now.agreement.recorded.agreed).toBe(now.agreement.recorded.compared);
  expect(now.changed.n).toBe(0);
  // The daemon tries settings changes only, and saves only a change it replayed.
  const patched = await request.post("/api/safety/trial", { data: { days: 1, patch: "--- a/x\n+++ b/x\n", repo: "/" } });
  expect(patched.status()).toBe(400);
  expect((await request.post("/api/safety/trial/save", { data: { change: { namespaces: { add: ["npm:@untried"] } } } })).status()).toBe(409);

  // The owner names the push's namespace as his: the replay says the push would have run, before anything is saved.
  await page.goto("/settings/safety");
  const trial = page.getByTestId("rule-trial");
  await trial.scrollIntoViewIfNeeded();
  await expect(trial.getByTestId("trial-save")).toBeDisabled();
  await trial.getByTestId("trial-namespace-input").fill("127.0.0.1/trial");
  await trial.getByTestId("trial-namespace-add").click();
  await expect(trial.locator('[data-testid="trial-namespace"][data-state="new"]')).toHaveText("+ 127.0.0.1/trial");
  await expect(trial.getByTestId("trial-save")).toBeDisabled();
  await trial.getByTestId("trial-days").click();
  await page.getByRole("option", { name: "1 day" }).click();
  await trial.getByTestId("trial-run").click();
  const result = trial.getByTestId("trial-result");
  await expect(result.getByTestId("trial-summary")).toContainText("1 allowed", { timeout: 60_000 });
  await expect(result.locator('[data-testid="trial-tools-row"][data-key="Bash"]')).toBeVisible();
  await expect(result.locator('[data-testid="trial-classes-row"][data-key="writes beyond your accounts"]')).toBeVisible();
  const row = result.getByTestId("trial-call");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("asked about to allowed");
  await expect(row).toContainText("had not run or failed");
  await expect(result.getByTestId("trial-agreement")).toContainText("Of the calls stored with the rules' own record");
  await expect(trial.getByTestId("trial-save")).toBeEnabled();
  // Nothing was saved by the trial.
  expect(((await (await request.get("/api/settings")).json()).settings.accounts?.namespaces ?? [])).toEqual(had);
  await shoot(page, "rule-trial-01-replay");
  await result.getByTestId("trial-agreement").scrollIntoViewIfNeeded();
  await shoot(page, "rule-trial-03-agreement");

  // An edit after the replay takes Save away until it is tried; taking the edit back brings it back.
  await trial.getByTestId("trial-namespace-input").fill("npm:@trial");
  await trial.getByTestId("trial-namespace-add").click();
  await expect(trial.getByTestId("trial-stale")).toBeVisible();
  await expect(trial.getByTestId("trial-save")).toBeDisabled();
  await shoot(page, "rule-trial-02-stale");
  await trial.locator('[data-testid="trial-namespace"][data-state="new"]', { hasText: "npm:@trial" }).click();
  await expect(trial.getByTestId("trial-stale")).toHaveCount(0);

  // The link opens the call where it is in its session.
  await row.getByTestId("trial-call-open").click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}`));
  await page.goBack();
  await expect(page.getByTestId("rule-trial")).toBeVisible();

  // Saved: the namespace is his, and the next replay with no change treats the push as his rules now do.
  await page.getByTestId("rule-trial").getByTestId("trial-namespace-input").fill("127.0.0.1/trial");
  await page.getByTestId("rule-trial").getByTestId("trial-namespace-add").click();
  await page.getByTestId("rule-trial").getByTestId("trial-run").click();
  await expect(page.getByTestId("rule-trial").getByTestId("trial-save")).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId("rule-trial").getByTestId("trial-save").click();
  await expect(page.getByTestId("rule-trial").getByTestId("trial-note")).toHaveText("Saved.");
  await expect(page.getByTestId("rule-trial").locator('[data-testid="trial-namespace"][data-state="kept"]', { hasText: "127.0.0.1/trial" })).toBeVisible();
  expect(((await (await request.get("/api/settings")).json()).settings.accounts.namespaces as string[])).toContain("127.0.0.1/trial");

  // Put back what the spec changed.
  expect((await request.patch("/api/settings", { data: { accounts: { namespaces: had } } })).ok()).toBe(true);
});
