import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: Next, in a queued prompt's move menu, puts it first among the queued
// prompts in one stored write, without stopping the turn that runs: it is the
// next turn's prompt. A stopped session's queue stays held (Next is no resume).
// (Steers and decisions others wait on stay ahead: src/engine/queue-first.test.ts.)
const MODEL = "scripted:stand-in";

test("next puts a queued prompt first without stopping the turn", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(MODEL), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title: "Queue next" } })).json();
  const sid = session.id;
  const dir = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `queue-next-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const gate = join(dir, "go");
  const msg = (text: string, mode = "send") => request.post(`/api/sessions/${sid}/messages`, { data: { text, mode } }).then((r) => r.json());
  const queue = async () => (await (await request.get(`/api/sessions/${sid}/queue`)).json()) as { queue: any[]; held: boolean };
  const events = async () => (await (await request.get(`/api/sessions/${sid}`)).json()).events as any[];
  const ends = async () => (await events()).filter((e) => e.kind === "turn_end");
  try {
    await page.goto(`/s/${sid}`);
    await msg(`script:hold ${gate}`);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${sid}`)).json()).running).toBe(true);
    for (const t of ["alpha", "bravo", "charlie"]) await msg(t, "queue");
    await expect(page.getByTestId("queue-item")).toHaveCount(2); // the third folds under "1 more queued"
    await page.getByTestId("queue-more").click();
    await expect(page.getByTestId("queue-item")).toHaveCount(3);

    // Next on charlie: first of the queue, the turn still runs.
    const row = page.getByTestId("queue-item").filter({ hasText: "charlie" });
    await row.hover();
    await row.getByTestId("queue-order").click();
    await expect(page.getByTestId("queue-order-menu")).toBeVisible();
    await shoot(page, "queue-next-01-menu");
    await page.getByTestId("queue-next").click();
    await expect.poll(async () => (await queue()).queue.map((x) => x.text)).toEqual(["charlie", "alpha", "bravo"]);
    await expect(page.getByTestId("queue-item").first()).toContainText("charlie");
    expect((await (await request.get(`/api/sessions/${sid}`)).json()).running).toBe(true);
    expect(await ends()).toHaveLength(0);
    await shoot(page, "queue-next-02-first");

    // The first one has nowhere to go: the queue is as it was.
    const first = (await queue()).queue[0];
    expect((await request.post(`/api/sessions/${sid}/queue/${first.id}/next`)).status()).toBe(200);
    expect((await queue()).queue.map((x) => x.text)).toEqual(["charlie", "alpha", "bravo"]);

    // The held turn ends by itself: charlie runs next, then the rest in order.
    writeFileSync(gate, "");
    await expect.poll(async () => (await ends()).length, { timeout: 60_000 }).toBe(4);
    expect((await events()).filter((e) => e.kind === "user" && e.data.origin === "queued").map((e) => e.data.text)).toEqual(["charlie", "alpha", "bravo"]);
    expect((await ends())[0].data.reason).not.toBe("interrupted");

    // After the owner's Stop the queue waits for them: Next reorders it and keeps it held.
    rmSync(gate, { force: true });
    await msg(`script:hold ${gate}`);
    await expect.poll(async () => (await (await request.get(`/api/sessions/${sid}`)).json()).running).toBe(true);
    await msg("delta", "queue");
    const echo = (await msg("echo", "queue")).queued;
    await request.post(`/api/sessions/${sid}/interrupt`, { data: { by: "owner" } });
    await expect(page.getByTestId("queue-held")).toBeVisible({ timeout: 10_000 });
    expect((await request.post(`/api/sessions/${sid}/queue/${echo.id}/next`)).status()).toBe(200);
    const held = await queue();
    expect([held.held, held.queue.map((x) => x.text)]).toEqual([true, ["echo", "delta"]]);
    await expect(page.getByTestId("queue-item").first()).toContainText("echo");
    await shoot(page, "queue-next-03-held");

    const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
    expect(errorsAfter).toBe(errorsBefore);
  } finally {
    writeFileSync(gate, "");
    await request.post(`/api/sessions/${sid}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${sid}`);
    rmSync(dir, { recursive: true, force: true });
  }
});
