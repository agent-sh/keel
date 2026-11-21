import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the Loops panel shows the run history of the loop that is picked.
// The history of the loop picked before never shows under another loop: not
// while the new one loads, and not when the old answer comes in late.
test("loops: a history answer for another loop is not shown", async ({ page, request }) => {
  const model = ((await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;
  test.skip(!model, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Loop history" } })).json();
  const make = async (name: string) =>
    (await (await request.post("/api/loops", { data: { session_id: session.id, name, schedule: "weekdays 09:30", prompt: `Say ${name}.` } })).json()) as { id: string; name: string };
  const [a, b] = [await make("History A"), await make("History B")];
  try {
    // Each loop's history answer waits for the test to let it through.
    const gates: Record<string, Promise<void> | undefined> = {};
    const hold = (id: string) => {
      let open!: () => void;
      gates[id] = new Promise<void>((r) => (open = r));
      return open;
    };
    await page.route(/\/api\/loops\/[^/]+\/runs$/, async (route) => {
      const id = route.request().url().split("/").at(-2)!;
      await gates[id];
      const now = Date.now();
      const note = id === a.id ? "a run of A" : "a run of B";
      await route.fulfill({ json: { loop: id === a.id ? a : b, runs: [{ id: `run-${id}`, loop_id: id, session_id: session.id, due_ms: now, started_ms: now, ended_ms: now + 1200, ok: true, outcome: "ok", note }] } });
    });
    const answered = (id: string) => page.waitForResponse((r) => r.url().endsWith(`/api/loops/${id}/runs`));

    await page.goto(`/s/${session.id}`);
    await page.getByTestId("loops-button").click();
    await expect(page.getByTestId("loops-panel")).toBeVisible();
    const item = (name: string) => page.getByTestId("loop-item").filter({ hasText: name }).first();
    const history = page.getByTestId("loop-history");
    const runs = page.getByTestId("loop-run");
    await item("History A").click();
    await expect(runs).toHaveCount(1);
    await expect(history).toContainText("a run of A");

    // B is picked while its history is still on the way: A's rows are gone at once.
    let openB = hold(b.id);
    await item("History B").click();
    await expect(history.getByRole("heading")).toHaveText("History B");
    await expect(runs).toHaveCount(0);
    await shoot(page, "loops-history-01-loading");
    openB();
    await expect(history).toContainText("a run of B");

    // A is picked and then B, and B's answer comes first: A's late answer changes nothing.
    const openA = hold(a.id);
    openB = hold(b.id);
    await item("History A").click();
    await expect(history.getByRole("heading")).toHaveText("History A");
    await item("History B").click();
    await expect(history.getByRole("heading")).toHaveText("History B");
    openB();
    await expect(history).toContainText("a run of B");
    const late = answered(a.id);
    openA();
    await late;
    await page.waitForTimeout(300);
    await expect(runs).toHaveCount(1);
    await expect(history).toContainText("a run of B");
    await expect(history).not.toContainText("a run of A");
    await shoot(page, "loops-history-02-late-answer");
  } finally {
    for (const l of [a, b]) await request.delete(`/api/loops/${l.id}`);
    await request.delete(`/api/sessions/${session.id}`);
  }
});
