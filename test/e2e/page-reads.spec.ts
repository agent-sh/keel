import { expect, test } from "./isolate.ts";

// Feature: what the page asks the daemon for. A session at work costs no
// read of its own: its background commands are read when the daemon says
// they changed, and whether it is a copy of another tool's conversation is
// asked once.
const STAND_IN = "scripted:stand-in";

test("a session at work reads its background commands when they change, not per turn", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Reads while working" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const reads = { jobs: 0, origin: 0 };
  page.on("request", (r) => {
    if (r.method() !== "GET") return;
    const path = new URL(r.url()).pathname;
    if (path === `/api/sessions/${session.id}/jobs`) reads.jobs++;
    if (path === `/api/sessions/${session.id}/origin`) reads.origin++;
  });
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  await expect.poll(() => reads.jobs).toBe(1);

  // Three turns of tool calls, each a few seconds long, none in the background.
  const calls = ["echo one", "sleep 2.5", "echo three"].map((command) => ({ name: "Bash", input: { command } }));
  for (let turn = 1; turn <= 3; turn++) {
    await composer.fill(`script:calls ${JSON.stringify(calls)}`);
    await composer.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(turn, { timeout: 30_000 });
  }
  expect(reads).toEqual({ jobs: 1, origin: 1 });

  // A command started in the background shows above the box at once, its last line follows, and its end is said.
  await composer.fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo step-1-of-2; sleep 3; echo job-finished", run_in_background: true } }])}`);
  await composer.press("Enter");
  const job = page.getByTestId("dock-job");
  await expect(job).toHaveCount(1, { timeout: 15_000 });
  await expect(job.getByTestId("dock-job-last")).toHaveText("job-finished", { timeout: 15_000 });
  await expect(job).toContainText("exit 0", { timeout: 15_000 });
  // Its two seconds of looking end with it: nothing is read once it is over.
  const after = reads.jobs;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
  expect(reads.jobs).toBe(after);
  expect(reads.origin).toBe(1);
  await request.delete(`/api/sessions/${session.id}`);
});
