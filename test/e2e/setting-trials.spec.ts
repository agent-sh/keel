import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a setting that changes what an agent costs is tried on half of the new agent trees. Settings > Usage >
// Trials has one group a setting: what agents do now, the offer to try the other value, and once a trial is on,
// what each arm cost a turn and a tree, how many failed and how long they took, with intervals. The owner keeps the
// other value (it becomes the setting for agents) or drops it (nothing changes). The daemon here has a week of
// agent trees written into its store beforehand, and one trial of the agents' working window with a dozen trees an
// arm, settled: a cheaper arm that the card shows beside the other.
const FIXTURE = join(import.meta.dirname, "fixtures/trial-rows.ts");

// A daemon of its own whose store holds the fixture's rows: started once so its tables exist, then written, then started again.
async function seededDaemon(what: "rate" | "seed") {
  const state = join(ROOT, `trials-${what}-${Date.now()}`);
  const first = await daemon(state);
  first.proc.kill();
  await exited(first.proc);
  execFileSync("bun", [FIXTURE, state, what], { stdio: "inherit" });
  return { state, ...(await daemon(state)) };
}

test("a trial's card shows both arms from the store, and Keep makes the other value the agents' setting", async ({ page }) => {
  const d = await seededDaemon("seed");
  try {
    const get = async (path: string) => (await fetch(`${d.url}${path}`)).json() as Promise<any>;
    await page.goto(`${d.url}/settings/usage`);
    const panel = page.getByTestId("usage-panel");
    await panel.getByRole("radio", { name: "Trials" }).click();
    const card = page.locator('[data-testid="setting-trial"][data-trial="agent_window"]');
    await expect(card).toHaveAttribute("data-state", "running");
    await expect(card.getByTestId("trial-now")).toContainText("compacts at 85% of the window");
    await expect(card.getByTestId("trial-state")).toHaveText("On trial");
    await expect(card.getByTestId("trial-line")).toContainText("24 trees of 80 wanted");

    // Both arms, each with its trees, in the measures the owner reads: cost a turn and a tree, failures, time.
    const table = card.getByTestId("trial-table");
    await expect(table).toContainText("compacts at 85% of the window (12 trees)");
    await expect(table).toContainText("compacts at 42.5% of the window (12 trees)");
    const rows = card.locator('[data-testid="trial-row"]');
    await expect.poll(async () => rows.evaluateAll((r) => r.map((x) => x.getAttribute("data-metric")))).toEqual(
      ["cost_usd", "tree_cost_usd", "error", "tool_errors", "successor", "stopped_by_owner", "thumbs_down", "ms", "tree_ms"]);
    const tree = card.locator('[data-testid="trial-row"][data-metric="tree_cost_usd"]');
    await expect(tree).toContainText("cost a tree");
    await expect(tree).toContainText(/\$\d\.\d+/);
    await expect(tree).toContainText(" to ");        // an interval under each figure
    await expect(tree).toContainText("beyond chance"); // the smaller window costs less a tree: the difference is real
    // What it saves, at the rate trees start at.
    await expect(card.getByTestId("trial-saving")).toContainText(/less at \d+ new trees a day/);
    await expect(card.getByTestId("trial-saving")).toContainText(/about \$[\d.]+ a day less/);
    await shoot(page, "setting-trials-01-running");

    // Nothing else starts while it runs; the setting is as it was.
    expect((await get("/api/settings")).settings.agents.window_share).toBeNull();
    // Keep: the trial ends, and the smaller share is what agents compact at from now on.
    await card.getByTestId("trial-keep").click();
    await expect(card).toHaveAttribute("data-state", "kept");
    await expect(card.getByTestId("trial-state")).toHaveText("Kept");
    await expect(card.getByTestId("trial-now")).toContainText("compacts at 42.5% of the window");
    expect((await get("/api/settings")).settings.agents.window_share).toBe(0.425);
    const exp = (await get("/api/experiments/fx-trial")).experiment;
    expect(exp).toMatchObject({ state: "stopped", stop_reason: "kept by the owner", setting: { choice: { kept: true } } });
    await expect(card.getByTestId("trial-keep")).toHaveCount(0);
    await shoot(page, "setting-trials-02-kept");

    // And it can be put back to what agents did before the trial.
    await card.getByTestId("trial-reset").click();
    await expect(card.getByTestId("trial-now")).toContainText("compacts at 85% of the window");
    expect((await get("/api/settings")).settings.agents.window_share).toBeNull();
  } finally { d.proc.kill(); await exited(d.proc); }
});

test("a trial starts on the press from the rate new trees start at, and Drop leaves the setting as it was", async ({ page }) => {
  const d = await seededDaemon("rate");
  try {
    const get = async (path: string) => (await fetch(`${d.url}${path}`)).json() as Promise<any>;
    await page.goto(`${d.url}/settings/usage`);
    await page.getByTestId("usage-panel").getByRole("radio", { name: "Trials" }).click();
    const card = page.locator('[data-testid="setting-trial"][data-trial="cache_plan"]');
    await expect(card).toHaveAttribute("data-state", "none");
    await expect(card.getByTestId("trial-now")).toContainText("plans its waits");
    await expect(card.getByTestId("trial-now")).toContainText("lets its cache lapse");
    // The page says what it is from the rate: 450 trees in three days.
    await expect(page.getByTestId("setting-trials")).toContainText("About 150 new agent trees start a day");
    await shoot(page, "setting-trials-03-offer");

    await card.getByTestId("trial-start").click();
    await expect(card).toHaveAttribute("data-state", "running");
    const running = (await get("/api/experiments")).experiments.filter((e: any) => e.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ mode: "live", unit: "agent", primary: "tree_cost_usd", setting: { trial: "cache_plan", from: true, to: false } });
    expect(running[0].arms.map((a: any) => [a.name, a.settings])).toEqual([["plans its waits", { cache_plan: true }], ["lets its cache lapse", { cache_plan: false }]]);
    // 150 trees a day: two days of trees, 150 an arm, ending by itself at four days at the latest.
    expect(running[0].stop.sessions_per_arm).toBe(150);
    expect(running[0].stop.until_ms - running[0].started_ms).toBeGreaterThan(3.9 * 86_400_000);
    // The other trial waits for it.
    await expect(page.locator('[data-testid="setting-trial"][data-trial="agent_window"]').getByTestId("trial-start")).toBeDisabled();
    await shoot(page, "setting-trials-04-started");

    await card.getByTestId("trial-drop").click();
    await expect(card).toHaveAttribute("data-state", "dropped");
    await expect(card.getByTestId("trial-state")).toHaveText("Dropped");
    expect((await get("/api/settings")).settings.agents.cache_plan).toBe(true);
    expect((await get("/api/experiments")).experiments.some((e: any) => e.state === "running")).toBe(false);
    // A new trial of it can start again.
    await expect(card.getByTestId("trial-start")).toBeEnabled();
  } finally { d.proc.kill(); await exited(d.proc); }
});
