import { expect, test } from "./isolate.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { shoot } from "./shots.ts";

// Feature: Settings > Usage > Review yield. For each builder model and agent type, how often an agent's
// "done" was later contradicted (a reviewer's refusal, a red check on the head it reported, a landing sent
// back), and for each reviewer model its refusals a later fix confirmed, what its reviews cost, and the
// rounds of the lanes it reviewed. Every figure is a count of records. The spec seeds a review history
// (fixtures/review-yield.ts) into a scratch daemon and reads the view: a builder's contradicted rate and a
// reviewer's real refusals per dollar.
test("the review yield view shows a builder's contradicted rate and a reviewer's real refusals per dollar", async ({ page }) => {
  test.setTimeout(180_000);
  const state = join(ROOT, `review-yield-${Date.now()}`);
  const d = await daemon(state);
  try {
    const parent = (await (await fetch(`${d.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "scripted:stand-in", title: "Coordinator" }) })).json()).session.id as string;
    execFileSync("bun", [join(import.meta.dirname, "fixtures/review-yield.ts"), join(state, "keel.db"), parent], { encoding: "utf8" });

    // The route says the same as the page will.
    const read = await (await fetch(`${d.url}/api/usage/yield`)).json() as { builders: any[]; reviewers: any[] };
    expect(read.builders.find((b) => b.model === "scripted:build-a")).toMatchObject({ done: 4, contradicted: 2, refused: 1, red: 1, rate: 0.5 });
    expect(read.reviewers.find((r) => r.model === "scripted:review-x")).toMatchObject({ verdicts: 3, refusals: 1, confirmed: 1, usd: 2.5, rounds_per_lane: 1.5 });

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/settings/usage`);
    const panel = page.getByTestId("usage-panel");
    await panel.getByRole("radio", { name: "Review yield" }).click();
    const builders = panel.getByTestId("yield-builders");
    await expect(builders.getByRole("row", { name: /build-a/ })).toContainText("50% (2)");
    await expect(builders.getByRole("row", { name: /build-a/ })).toContainText("general-purpose");
    await expect(builders.getByRole("row", { name: /build-b/ })).toContainText("0% (0)");
    const reviewers = panel.getByTestId("yield-reviewers");
    const row = reviewers.getByRole("row", { name: /review-x/ });
    await expect(row).toContainText("$2.50");
    await expect(row).toContainText("0.40");
    await expect(row).toContainText("1.5");
    await shoot(page, "review-yield-01-view");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "review-yield-02-narrow");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});
