import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

test("archiving pauses only active loops and restoring resumes their schedules", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Archive a scheduled session" } })).json();
  const path = `/api/sessions/${session.id}`;
  const made = await request.post("/api/loops", { data: { session_id: session.id, name: "Archive schedule", schedule: "10m", prompt: "Check the schedule." } });
  expect(made.status()).toBe(201);
  const { id } = await made.json();
  const loopPath = `/api/loops/${id}`;
  const history = async () => (await (await request.get(`${loopPath}/runs`)).json());
  const state = async () => (await history()).loop;
  try {
    const off = await request.post("/api/loops", { data: { session_id: session.id, name: "Manual pause", schedule: "10m", prompt: "Check later." } });
    expect(off.status()).toBe(201);
    const offPath = `/api/loops/${(await off.json()).id}`;
    expect((await request.patch(offPath, { data: { enabled: false } })).ok()).toBe(true);
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("loops-button").click();
    const item = page.getByTestId("loop-item").filter({ hasText: "Archive schedule" });
    await expect(item.getByTestId("loop-item-state")).toContainText("every 10 minutes");
    expect(await state()).toMatchObject({ enabled: true, next_ms: expect.any(Number) });

    expect((await request.patch(path, { data: { archived: true } })).ok()).toBe(true);
    expect(await state()).toMatchObject({ enabled: false, next_ms: null });
    await expect(item.getByTestId("loop-item-state")).toContainText("paused because the session was archived");
    await shoot(page, "loops-archived-paused");
    expect((await request.patch(loopPath, { data: { enabled: true } })).status()).toBe(409);
    expect((await request.post(`${loopPath}/run`)).status()).toBe(409);

    expect((await request.patch(path, { data: { archived: false } })).ok()).toBe(true);
    expect(await state()).toMatchObject({ enabled: true, disabled_reason: null, next_ms: expect.any(Number) });
    await expect(item.getByTestId("loop-item-state")).not.toContainText("paused");
    await expect(page.getByTestId("loop-item").filter({ hasText: "Manual pause" }).getByTestId("loop-item-state")).toContainText("paused");
    expect((await history()).runs).toEqual([]);
  } finally {
    await request.delete(loopPath);
    await request.delete(path);
  }
});
