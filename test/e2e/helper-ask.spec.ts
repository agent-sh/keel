import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the helper on a phone. The home's first row is the helper: a
// question typed (or held to speak, where the phone recognizes speech on the
// device) goes to the helper's conversation as the owner's words, and the
// answer comes back under it as text, with the sessions it read named. Its
// turn only reads: a tool that changes something is refused, not run and not
// asked. What it offers is the owner's tap: Answer on a session that waits
// for them opens its request; Open opens a session it read.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
// The helper is daemon-wide: off again after the spec, so other specs' sessions never wake it.
test.afterEach(async ({ request }) => { await request.put("/api/helper", { data: { on: false } }); });

test("helper row: ask across sessions, read-only, the answer names what it read and offers the taps", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(180_000);
  const { state_dir } = await (await request.get("/api/daemon")).json();
  const tag = Date.now().toString(36);
  const mark = join(state_dir, `helper-ask-${tag}`);

  // A fresh helper: an earlier run's conversation archived.
  const was = await (await request.get("/api/helper")).json();
  if (was.session_id) await request.patch(`/api/sessions/${was.session_id}`, { data: { archived: true } });
  // A session that waits for the owner's approval, and one that is done.
  const make = async (title: string) => (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title } })).json()).session;
  const deploy = await make(`Deploy ${tag}`);
  await request.put(`/api/sessions/${deploy.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${deploy.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "bun run deploy --prod" } }])}` } });
  const docs = await make(`Docs ${tag}`);
  const waits = async () => (await (await request.get(`/api/sessions/${deploy.id}/approvals`)).json()).approvals.filter((a: any) => a.state === "pending").length;
  await expect.poll(waits, { timeout: 60_000 }).toBe(1);

  try {
    await page.goto("/");
    const row = page.getByTestId("helper-ask");
    await expect(row).toBeVisible();
    // First on the home: above the headline and the start box.
    const first = await page.getByTestId("home-start").evaluate((el) => el.firstElementChild?.getAttribute("data-testid"));
    expect(first).toBe("helper-ask");
    await shoot(page, "helper-ask-01-row");

    // The question: the helper lists the sessions, reads two, tries a command that would write, and tries
    // what the gate reads as reads but acts in Keel: an agent started, a loop set, a notification sent.
    const calls = [
      { name: "helper__sessions", input: {} },
      { name: "helper__session_read", input: { session: deploy.id } },
      { name: "helper__session_read", input: { session: docs.id } },
      { name: "Bash", input: { command: `touch ${mark}` } },
      { name: "spawn_agent", input: { message: `touch ${mark}`, isolation: "none" } },
      { name: "schedule_create", input: { cron: "*/5 * * * *", prompt: `touch ${mark}` } },
      { name: "notify", input: { text: `helper-ask ${tag}` } },
    ];
    await row.getByTestId("helper-ask-field").fill(`What waits for me? script:calls ${JSON.stringify(calls)}`);
    await row.getByTestId("helper-ask-send").tap();
    const answer = row.getByTestId("helper-answer");
    await expect(answer).toHaveAttribute("data-state", "done", { timeout: 90_000 });
    await expect(answer.getByTestId("helper-answer-text")).toContainText(`Done with ${calls.length} calls`);
    await expect(answer.getByTestId("helper-answer-read")).toHaveText(`Read Deploy ${tag}, Docs ${tag} and the session list`);
    // Read only: the command was refused before any gate, and nothing ran.
    const helper = await (await request.get("/api/helper")).json();
    const events = (await (await request.get(`/api/sessions/${helper.session_id}`)).json()).events;
    const results = events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results);
    const refused = (name: string) => {
      const use = events.flatMap((e: any) => (e.kind === "assistant" ? e.data.blocks : [])).find((b: any) => b?.type === "tool_use" && b.name === name);
      return JSON.stringify(results.find((r: any) => r.tool_use_id === use?.id)?.content ?? "");
    };
    for (const name of ["Bash", "spawn_agent", "schedule_create", "notify"]) expect([name, refused(name)]).toEqual([name, expect.stringContaining("only reads")]);
    expect(existsSync(mark)).toBe(false);
    // No agent under the helper, no loop of its.
    const all = (await (await request.get("/api/sessions")).json()).sessions;
    expect(all.filter((x: any) => x.parent_id === helper.session_id)).toEqual([]);
    expect((await (await request.get(`/api/sessions/${helper.session_id}/approvals`)).json()).approvals.filter((a: any) => a.state === "pending")).toHaveLength(0);
    // The question is the owner's words in the helper's conversation, marked as asked from the page.
    expect(events.find((e: any) => e.kind === "user" && String(e.data.text).startsWith("What waits for me?"))?.data.ask).toBe("page");
    // The taps it offers: Answer where a session waits for the owner, Open for the other.
    const acts = answer.getByTestId("helper-answer-act");
    await expect(acts).toHaveCount(2);
    await expect(acts.nth(0)).toHaveText(`Answer Deploy ${tag}`);
    await expect(acts.nth(0)).toHaveAttribute("data-act", "answer");
    await expect(acts.nth(1)).toHaveText(`Open Docs ${tag}`);
    await shoot(page, "helper-ask-02-answer");

    // Answer opens the session at its request, which waits as it did: the tap is the owner's.
    await acts.nth(0).tap();
    await expect(page).toHaveURL(new RegExp(`/s/${deploy.id}`));
    await expect(page.locator(".k-station[data-helm]").getByTestId("approval").first()).toBeVisible();
    expect(await waits()).toBe(1);
    await shoot(page, "helper-ask-03-answer-opened");

    // Back home the answer is still there, kept across the visit.
    await page.goto("/");
    await expect(page.getByTestId("helper-answer")).toHaveAttribute("data-state", "done");
    await page.getByTestId("helper-answer-clear").tap();
    await expect(page.getByTestId("helper-answer")).toHaveCount(0);
  } finally {
    await request.post(`/api/sessions/${deploy.id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    for (const id of [deploy.id, docs.id]) await request.delete(`/api/sessions/${id}`).catch(() => {});
  }
});

// An answer that does not come (the helper's turn waits on its provider) is read for two minutes, then the
// row says the helper did not answer and stops asking; Look again reads it for as long again.
test("helper row: an answer that does not come is read for two minutes, then the row says so", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.setTimeout(120_000);
  const was = await (await request.get("/api/helper")).json();
  if (was.session_id) await request.patch(`/api/sessions/${was.session_id}`, { data: { archived: true } });
  // The page's clock is the test's: two minutes pass without waiting for them.
  await page.clock.install();
  await page.goto("/");
  const row = page.getByTestId("helper-ask");
  let helperId = "";
  try {
    // The provider asks the helper's turn to wait four minutes: the answer stays to come.
    await row.getByTestId("helper-ask-field").fill("Anything new? script:rate-limit-long 240000");
    await row.getByTestId("helper-ask-send").tap();
    const answer = row.getByTestId("helper-answer");
    await expect(answer).toBeVisible();
    helperId = (await (await request.get("/api/helper")).json()).session_id;
    await page.clock.runFor(3000);
    await expect(answer).toHaveAttribute("data-state", /waiting|working/);
    await expect(answer.getByTestId("helper-answer-wait")).toBeVisible();
    // Reads on the page's clock: none past the bound.
    let reads = 0;
    page.on("request", (r) => { if (r.url().includes("/api/helper/ask/")) reads++; });
    await page.clock.runFor(120_000);
    await expect(answer.getByTestId("helper-answer-late")).toContainText("The helper did not answer.");
    await expect(answer.getByTestId("helper-answer-wait")).toHaveCount(0);
    const after = reads;
    await page.clock.runFor(30_000);
    expect(reads).toBe(after);
    await shoot(page, "helper-ask-04-unanswered");
    // Look again reads it once more, and the row waits again.
    await answer.getByTestId("helper-answer-again").tap();
    await expect(answer.getByTestId("helper-answer-wait")).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(after);
    await page.getByTestId("helper-answer-clear").tap();
  } finally {
    if (helperId) await request.post(`/api/sessions/${helperId}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});
