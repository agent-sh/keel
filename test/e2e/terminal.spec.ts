import { expect, test } from "./isolate.ts";
import { mkdirSync, unlinkSync } from "node:fs";
import { openPanel, shoot, tabInto } from "./shots.ts";

// Feature: the terminal pane. Every command the session ran, newest first,
// with how it ended and its colored output; a background one streams and is
// stopped from the pane; the filters; copy; the owner re-runs a failed command
// and the model hears of it. The scripted stand-in sends the exact calls.
const STAND_IN = "scripted:stand-in";

test("terminal pane: commands, output, filters, stop, copy and re-run", async ({ page, request, context }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/terminal-${Date.now().toString(36)}`;
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Terminal pane", workspace: ws } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const calls = [
    { name: "Bash", input: { command: "printf '\\033[32mall green\\033[0m and plain\\n'", description: "Colored output" } },
    { name: "Bash", input: { command: "echo about to fail; exit 3" } },
    { name: "Bash", input: { command: "for i in $(seq 1 60); do echo tick $i; sleep 1; done", run_in_background: true, description: "A long watcher" } },
  ];
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });

  try {
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
    await openPanel(page, "terminal");
    const panel = page.getByTestId("terminal-panel");
    const rows = panel.getByTestId("term-entry");
    await expect(rows).toHaveCount(3);
    // Newest first: the background one leads, still running.
    await expect(rows.first()).toHaveAttribute("data-state", "background");
    await expect(rows.first().getByTestId("term-last")).toContainText(/tick \d+/, { timeout: 10_000 });

    // Its output streams in while it runs.
    await rows.first().getByTestId("term-toggle").click();
    const out = rows.first().getByTestId("term-output");
    await expect(out).toContainText("tick 3", { timeout: 10_000 });
    await expect(out).toContainText("tick 5", { timeout: 10_000 });

    // The colored one keeps its colors; copy gives the plain text.
    const green = rows.filter({ hasText: "all green" });
    await green.getByTestId("term-toggle").click();
    await expect(green.getByTestId("term-output").locator("span", { hasText: "all green" })).toHaveCSS("color", /rgb|oklch/);
    await green.getByTestId("term-copy").click();
    await expect(green.getByTestId("term-copy")).toHaveAttribute("data-copied", "true");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("all green and plain\n");
    await shoot(page, "terminal-01-running");

    // Filters, by keyboard: one Tab stop on the filter chosen; Left and Right
    // move to the next filter and show its commands; each is tied to the list.
    const filters = panel.getByRole("tablist", { name: "Which commands" });
    const filter = (f: string) => panel.getByTestId(`term-filter-${f}`);
    const list = panel.getByRole("tabpanel");
    const tied = async (f: string) => {
      await expect(list).toHaveCount(1);
      await expect(filter(f)).toHaveAttribute("aria-selected", "true");
      await expect(filter(f)).toHaveAttribute("aria-controls", (await list.getAttribute("id"))!);
      await expect(list).toHaveAttribute("aria-labelledby", (await filter(f).getAttribute("id"))!);
      await expect(list.getByTestId("term-list")).toBeVisible();
    };
    await tabInto(page, filters);
    await expect(filter("all")).toBeFocused();
    await tied("all");
    await page.keyboard.press("ArrowRight");
    await expect(filter("running")).toBeFocused();
    await tied("running");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-state", "background");
    await page.keyboard.press("ArrowRight");
    await expect(filter("failed")).toBeFocused();
    await tied("failed");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("term-ending")).toHaveText("exit 3");
    await shoot(page, "terminal-03-filter-by-keyboard");
    // The next Tab leaves the filters; coming back lands on the one chosen.
    await page.keyboard.press("Tab");
    await expect(filters.locator(":focus")).toHaveCount(0);
    await tabInto(page, filters);
    await expect(filter("failed")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await tied("running");
    await expect(rows).toHaveCount(1);
    // Stopped from the pane.
    await rows.first().getByTestId("term-stop").click();
    await expect(rows).toHaveCount(0, { timeout: 10_000 });
    await expect(panel).toContainText("Nothing is running.");
    await panel.getByTestId("term-filter-all").click();
    await expect(rows.filter({ hasText: "seq 1 60" })).toHaveAttribute("data-state", "stopped");

    // The owner runs the failed one again: a new entry by the owner.
    await rows.filter({ hasText: "about to fail" }).getByTestId("term-rerun").click();
    const mine = rows.filter({ has: page.getByTestId("term-by-owner") });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByTestId("term-ending")).toHaveText("exit 3", { timeout: 10_000 });
    await expect(mine.getByTestId("term-output")).toContainText("about to fail");
    // And a command of the owner's own from the command line.
    await panel.getByTestId("term-input").fill("echo from the owner");
    await panel.getByTestId("term-run").click();
    await expect(mine).toHaveCount(2);
    await expect(mine.first().getByTestId("term-output")).toContainText("from the owner", { timeout: 10_000 });
    await shoot(page, "terminal-02-rerun");

    // A burst bigger than one read, followed live: its first line is not skipped.
    await panel.getByTestId("term-input").fill("sleep 1.5; printf 'ERROR-AT-START\\n'; head -c 70000 /dev/zero | tr '\\0' x; printf '\\nburst-end\\n'");
    await panel.getByTestId("term-run").click();
    await expect(mine).toHaveCount(3);
    const burst = mine.first().getByTestId("term-output");
    await expect(burst).toContainText("burst-end", { timeout: 15_000 });
    await expect(burst).toContainText("ERROR-AT-START");
    await expect(burst).not.toContainText("bytes skipped");

    // The model hears of the owner's commands at its next request.
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "And now?" } });
    await expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${session.id}`)).json();
      return d.events.filter((e: any) => e.kind === "note" && e.data.model && /The owner ran `echo about to fail; exit 3`/.test(e.data.text)).length;
    }, { timeout: 20_000 }).toBe(1);

    // A known command whose log is gone says so, not "No output".
    const jobs = (await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs as { command: string; log: string; id: string }[];
    const failed = jobs.find((j) => j.command.includes("about to fail") && !j.command.startsWith("exec"))!;
    unlinkSync(failed.log);
    await page.reload();
    await openPanel(page, "terminal");
    const gone = page.getByTestId("term-entry").filter({ hasText: "about to fail" }).filter({ hasNot: page.getByTestId("term-by-owner") });
    await gone.getByTestId("term-toggle").click();
    await expect(gone.getByTestId("term-no-output")).toHaveText("Output log unavailable.");
    expect((await request.get(`/api/sessions/${session.id}/terminal/${failed.id}/log`)).status()).toBe(200);
    expect((await request.get(`/api/sessions/${session.id}/terminal/bnope/log`)).status()).toBe(404);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
