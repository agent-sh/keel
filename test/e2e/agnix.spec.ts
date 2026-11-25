import { expect, test } from "./isolate.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endsAre, shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";

// Feature: agnix by default. A session's first prompt in a folder lints the folder's agent configs in the background
// (scripts/smoke.sh gives the daemon a stand-in agnix; a daemon on a machine with agnix uses it). The finding is quiet:
// a line for the folder on Settings > Health and in Customize > Instructions, and the error reaches the session's model
// once, as a note at its next turn. The same files are not linted again.
test("agnix: a folder's config error is a line in Health and in its instructions view, told to the model once", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const first = await (await request.get("/api/agnix")).json();
  test.skip(!first.installed, "needs agnix or its stand-in: scripts/smoke.sh sets KEEL_AGNIX to test/e2e/fixtures/agnix-standin.sh");
  const scratch = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, "agnix-"));
  try {
    writeFileSync(join(work, "CLAUDE.md"), "# Notes\n\nSee @missing-notes.md\n");
    const { session } = await (await request.post("/api/sessions", { data: { workspace: work, model: STAND_IN, title: "Agent configs" } })).json();
    const base = `/api/sessions/${session.id}`;
    await page.goto(`/s/${session.id}`);
    // The first prompt makes the prompt, and the lint runs beside it.
    await request.post(`${base}/messages`, { data: { text: "hello" } });
    await endsAre(page, 1);
    const lint = async () => ((await (await request.get("/api/agnix")).json()).folders as any[]).find((l) => l.folder === work);
    await expect.poll(async () => (await lint())?.errors, { timeout: 30_000 }).toBe(1);
    const at = (await lint()).at;

    // The next turn carries the error to the model, once; a third does not again, and nothing ran again.
    await request.post(`${base}/messages`, { data: { text: "go on" } });
    await endsAre(page, 2);
    await request.post(`${base}/messages`, { data: { text: "and on" } });
    await endsAre(page, 3);
    const notes = ((await (await request.get(`${base}/events`)).json()).events as any[]).filter((e) => e.kind === "note" && e.data.kind === "agnix_errors");
    expect(notes).toHaveLength(1);
    expect(notes[0].data.text).toContain("CC-MEM-001");
    expect(notes[0].data.model).toBe(true);
    expect((await lint()).at).toBe(at);
    await expect(page.getByTestId("note").filter({ hasText: "agnix found an error" })).toHaveCount(1);
    await shoot(page, "agnix-01-told");

    // Settings > Health: one line for the folder, its finding under it.
    await page.goto("/settings/health");
    await expect(page.getByTestId("health-panel")).toHaveAttribute("data-state", "done");
    const row = page.locator('[data-testid="health-row"]').filter({ hasText: work });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-level", "warning");
    await expect(row).toContainText("1 error, 0 warnings");
    await expect(row).toContainText("CLAUDE.md:3 CC-MEM-001");
    await row.scrollIntoViewIfNeeded();
    await shoot(page, "agnix-02-health");

    // The folder's instructions view (seen from the newest folder: this one) says it in one line.
    await page.goto("/customize/instructions");
    await expect(page.getByTestId("toolkit-folder")).toContainText(work.split("/").at(-1)!);
    const said = page.getByTestId("instructions-lint");
    await expect(said).toContainText("agnix: 1 error, 0 warnings");
    await shoot(page, "agnix-03-instructions");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
